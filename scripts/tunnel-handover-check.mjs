#!/usr/bin/env node
// Real-network check of the Copilot app hub's persistent quick tunnel: a hub opens a Cloudflare quick
// tunnel and is killed abruptly (as when its chat is closed or deleted); the next hub must keep the
// same cloudflared process and public address; `stop` must end it. Uses a throwaway POCKET_PILOT_HOME.
//   node scripts/tunnel-handover-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
const fail = (m) => {
  console.error(`HANDOVER CHECK FAILED: ${m}`);
  process.exit(1);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-handover-'));
const tunnelDir = path.join(home, 'tunnel');
const probe = new PersistentTunnel({ storageDir: path.join(os.homedir(), '.pocket-pilot', 'copilot', 'tunnel') });
const bin = probe.findBinary() || (await new PersistentTunnel({ storageDir: tunnelDir }).download((m) => log(m)));
fs.mkdirSync(path.join(tunnelDir, 'bin'), { recursive: true });
if (path.dirname(bin) !== path.join(tunnelDir, 'bin')) fs.copyFileSync(bin, path.join(tunnelDir, 'bin', path.basename(bin)));
fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ enabled: true, settings: { tunnel: 'quick', passkey: 'off', requireApproval: false, rendezvous: false } }));
const env = { ...process.env, POCKET_PILOT_HOME: home };
const hubScript = `import { startHub } from ${JSON.stringify(pathToFileURL(path.join(lib, 'hub.mjs')).href)}; await startHub();`;
const startHubProcess = () => spawn(process.execPath, ['--input-type=module', '-e', hubScript], { env, stdio: 'ignore' });

async function status(pred, what, ms = 150000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const info = ipc.readJson(path.join(home, 'hub.json'));
    if (info && ipc.isAlive(info.pid)) {
      try {
        const ch = await ipc.connect(info.port, info.token, { pid: process.pid });
        const s = await new ipc.Rpc(ch, {}).request('status', {}, 10000);
        ch.close();
        if (pred(s, info)) return { s, info };
      } catch {
        /* starting */
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return fail(`timed out waiting for ${what}`);
}

const a = startHubProcess();
const first = await status((s) => s.tunnel.url && s.tunnel.reachable, 'the first tunnel to be reachable');
const cf = ipc.readJson(path.join(tunnelDir, 'tunnel.json'));
log(`hub A (pid ${first.info.pid}): ${first.s.tunnel.url} on local port ${first.info.relayPort}, cloudflared pid ${cf.pid}`);
a.kill('SIGKILL');
await new Promise((r) => a.once('exit', r));
if (!ipc.isAlive(cf.pid)) fail('cloudflared ended with the hub');
log(`hub A killed; the address now answers ${await fetch(`${first.s.tunnel.url}/health`).then((r) => r.status).catch((e) => e.message)} (devices retry)`);

const b = startHubProcess();
const second = await status((s, info) => info.pid !== first.info.pid && s.tunnel.url && s.tunnel.reachable, 'the next hub to be reachable');
if (second.s.tunnel.url !== first.s.tunnel.url) fail(`the address changed to ${second.s.tunnel.url}`);
if (ipc.readJson(path.join(tunnelDir, 'tunnel.json'))?.pid !== cf.pid) fail('a new cloudflared was started');
log(`hub B (pid ${second.info.pid}) kept ${second.s.tunnel.url} and cloudflared ${cf.pid}`);

const ch = await ipc.connect(second.info.port, second.info.token, { pid: process.pid });
await new ipc.Rpc(ch, {}).request('stop', {}, 10000);
ch.close();
await new Promise((r) => setTimeout(r, 3000));
if (ipc.isAlive(cf.pid) || fs.existsSync(path.join(tunnelDir, 'tunnel.json'))) fail('stop did not end the tunnel');
b.kill();
await new Promise((r) => setTimeout(r, 500));
fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
log('HANDOVER CHECK OK');
process.exit(0);
