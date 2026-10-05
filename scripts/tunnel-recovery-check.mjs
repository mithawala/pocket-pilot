#!/usr/bin/env node
// Real-network check of the tunnel watchdog: a quick tunnel whose cloudflared keeps running without a
// connection to Cloudflare (what a PC can be left with after being offline or asleep) must not leave
// devices stuck. cloudflared is started with its edge connections bound to 127.0.0.1, so it gets an
// address but never connects; a real hub then takes it over, as after a restart of the app. The hub
// must say it's reconnecting rather than online, open a new tunnel, end the dead one and come back
// online at the new address. Uses a throwaway POCKET_PILOT_HOME; takes about four minutes.
//   node scripts/tunnel-recovery-check.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(root, 'copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib');
const { PersistentTunnel } = createRequire(import.meta.url)(path.join(root, 'extension/core/tunnel.js'));
const ipc = await import(pathToFileURL(path.join(lib, 'ipc.mjs')).href);

const t0 = Date.now();
const log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${m}`);
const cleanup = [];
const fail = (m) => {
  console.error(`RECOVERY CHECK FAILED: ${m}`);
  for (const c of cleanup) c();
  process.exit(1);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-recovery-'));
const tunnelDir = path.join(home, 'tunnel');
const probe = new PersistentTunnel({ storageDir: path.join(os.homedir(), '.pocket-pilot', 'copilot', 'tunnel') });
const bin = probe.findBinary() || (await new PersistentTunnel({ storageDir: tunnelDir }).download((m) => log(m)));
fs.mkdirSync(path.join(tunnelDir, 'bin'), { recursive: true });
if (path.dirname(bin) !== path.join(tunnelDir, 'bin')) fs.copyFileSync(bin, path.join(tunnelDir, 'bin', path.basename(bin)));
fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ enabled: true, settings: { tunnel: 'quick', passkey: 'off', requireApproval: false, rendezvous: false } }));
// A paired phone that takes notifications: it gets the new address in one (its push service refuses the
// made-up subscription, which is fine here).
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
fs.writeFileSync(path.join(home, 'devices.json'), JSON.stringify({ version: 1, devices: [{
  id: 'test-phone', name: 'Test phone', platform: 'iPhone', publicKey: crypto.randomBytes(65).toString('base64url'), pairedAt: Date.now(),
  push: { endpoint: 'https://fcm.googleapis.com/fcm/send/pocket-pilot-recovery-check', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } },
}] }));

const free = () => new Promise((r) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => r(port));
  });
});
const get = async (url, ms = 3000) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, error: err.cause?.code || err.message };
  }
};

// A cloudflared without a connection to Cloudflare, recorded as the running tunnel.
const port = await free();
const metricsPort = await free();
const empty = path.join(tunnelDir, 'cloudflared-empty.yml');
fs.writeFileSync(empty, '# empty\n');
const dead = spawn(path.join(tunnelDir, 'bin', path.basename(bin)), ['tunnel', '--no-autoupdate', '--config', empty, '--metrics', `127.0.0.1:${metricsPort}`, '--loglevel', 'warn', '--logfile', path.join(tunnelDir, 'dead.log'), '--edge-bind-address', '127.0.0.1', '--url', `http://127.0.0.1:${port}`], { detached: true, stdio: 'ignore', windowsHide: true });
dead.unref();
cleanup.push(() => ipc.isAlive(dead.pid) && process.kill(dead.pid));
let deadHost = null;
for (let i = 0; i < 60 && !deadHost; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await get(`http://127.0.0.1:${metricsPort}/quicktunnel`);
  if (r.status === 200) deadHost = JSON.parse(r.body).hostname;
}
if (!deadHost) fail('the unconnected cloudflared did not get an address');
const ready = await get(`http://127.0.0.1:${metricsPort}/ready`);
if (ready.status !== 503) fail(`expected the unconnected cloudflared to report 503 on /ready, got ${ready.status}`);
fs.writeFileSync(path.join(tunnelDir, 'tunnel.json'), JSON.stringify({ pid: dead.pid, port, metricsPort, startedAt: Date.now() }));
log(`cloudflared ${dead.pid} runs with address https://${deadHost} but no connection to Cloudflare (/ready 503)`);

const env = { ...process.env, POCKET_PILOT_HOME: home };
const hubScript = `import { startHub } from ${JSON.stringify(pathToFileURL(path.join(lib, 'hub.mjs')).href)}; await startHub();`;
const hub = spawn(process.execPath, ['--input-type=module', '-e', hubScript], { env, stdio: 'ignore' });
cleanup.push(() => hub.kill());

async function status(pred, what, ms) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end;) {
    const info = ipc.readJson(path.join(home, 'hub.json'));
    if (info && ipc.isAlive(info.pid)) {
      try {
        const ch = await ipc.connect(info.port, info.token, { pid: process.pid });
        last = await new ipc.Rpc(ch, {}).request('status', {}, 10000);
        ch.close();
        if (pred(last, info)) return { s: last, info };
      } catch {
        /* starting */
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return fail(`timed out waiting for ${what} (last status: ${JSON.stringify(last?.tunnel)})`);
}

const kept = await status((s) => s.tunnel.url === `https://${deadHost}`, 'the hub to take over the tunnel', 60000);
log(`hub ${kept.info.pid} took over https://${deadHost} on local port ${kept.info.relayPort}`);
const down = await status((s) => s.tunnel.error, 'the hub to notice the tunnel has no connection', 60000);
if (down.s.tunnel.reachable) fail('the hub calls a tunnel without a connection reachable');
log(`hub says: "${down.s.tunnel.error}" (reachable: ${down.s.tunnel.reachable})`);

const back = await status((s) => s.tunnel.url && s.tunnel.url !== `https://${deadHost}` && s.tunnel.reachable && !s.tunnel.error, 'a new tunnel to take over', 330000);
log(`new tunnel ${back.s.tunnel.url} is online (${((Date.now() - t0) / 1000).toFixed(0)}s after the start)`);
await new Promise((r) => setTimeout(r, 1500));
if (ipc.isAlive(dead.pid)) fail('the unconnected cloudflared was not ended');
const saved = ipc.readJson(path.join(tunnelDir, 'tunnel.json'));
if (!saved || saved.pid === dead.pid || saved.next) fail(`tunnel.json was not updated: ${JSON.stringify(saved)}`);
const health = await get(`${back.s.tunnel.url}/health`, 15000);
log(`the dead cloudflared is ended; ${back.s.tunnel.url}/health answers ${health.status || health.error} from this PC`);
const told = await (async () => {
  for (let i = 0; i < 20; i++) {
    if (/New address, and no auto-reconnect gist: telling 1 device\(s\) by notification/.test(fs.readFileSync(path.join(home, 'hub.log'), 'utf8'))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
})();
if (!told) fail('the paired phone was not told the new address');
log('the phone that takes notifications was sent the new address');

const info = ipc.readJson(path.join(home, 'hub.json'));
const ch = await ipc.connect(info.port, info.token, { pid: process.pid });
await new ipc.Rpc(ch, {}).request('stop', {}, 10000);
ch.close();
await new Promise((r) => setTimeout(r, 3000));
if (ipc.isAlive(saved.pid) || fs.existsSync(path.join(tunnelDir, 'tunnel.json'))) fail('stop did not end the new tunnel');
hub.kill();
await new Promise((r) => setTimeout(r, 500));
const hubLog = fs.readFileSync(path.join(home, 'hub.log'), 'utf8').split('\n').filter((l) => /tunnel|Tunnel|address|Push/.test(l)).map((l) => `    ${l.slice(25)}`);
console.log(hubLog.join('\n'));
fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
log('RECOVERY CHECK OK');
process.exit(0);
