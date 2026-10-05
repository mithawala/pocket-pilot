import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { PersistentTunnel } = createRequire(import.meta.url)('../extension/core/tunnel.js');

const temp = [];
test.after(() => {
  for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake of what the tunnel deals with: cloudflared processes (each with its metrics endpoint and a
 * quick tunnel), the network, Cloudflare, and the clock. A tunnel that is `gone` never connects again,
 * like a quick tunnel that didn't survive the PC being offline.
 */
function world() {
  const w = { t: 1_000_000, online: true, publicOk: true, procs: new Map(), spawned: 0, logs: [], onSpawn: null };
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  w.connected = (p) => p.alive && w.online && !p.gone && w.t >= (p.connectAt || 0);
  w.last = () => [...w.procs.values()].at(-1);
  w.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === '127.0.0.1') {
      const p = [...w.procs.values()].find((x) => x.metricsPort === Number(u.port) && x.alive);
      if (!p) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      if (u.pathname === '/quicktunnel') return json(200, { hostname: p.host });
      if (u.pathname === '/ready') return json(w.connected(p) ? 200 : 503, { readyConnections: w.connected(p) ? 1 : 0 });
      return json(404, {});
    }
    if (!w.online || !w.publicOk) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const p = [...w.procs.values()].find((x) => `https://${x.host}` === u.origin);
    return json(p && w.connected(p) ? 200 : 530, {});
  };
  return w;
}

function tunnelIn(w, timing = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tunnel-'));
  temp.push(dir);
  const t = new PersistentTunnel({
    storageDir: dir, fetchImpl: w.fetch, now: () => w.t, log: (level, m) => w.logs.push(`${level} ${m}`),
    timing: { checkMs: 3600000, ...timing },
  });
  t._sleep = async (ms) => {
    w.t += ms;
  };
  t._isRunning = (pid) => !!w.procs.get(pid)?.alive;
  t._kill = async (pid) => {
    const p = w.procs.get(pid);
    if (p) p.alive = false;
  };
  t._spawnCloudflared = (args) => {
    const proc = new EventEmitter();
    proc.pid = 50000 + ++w.spawned;
    proc.unref = () => {};
    const metricsPort = Number(args[args.indexOf('--metrics') + 1].split(':')[1]);
    // Offline, cloudflared can't get a quick tunnel and exits.
    const p = { pid: proc.pid, metricsPort, host: `tunnel-${w.spawned}.trycloudflare.com`, alive: w.online, gone: false };
    w.procs.set(proc.pid, p);
    if (!w.online) queueMicrotask(() => proc.emit('exit', 1));
    w.onSpawn?.(p);
    return proc;
  };
  return t;
}

/** Lets `ms` pass, with the tunnel checked every 15 seconds. */
async function pass(t, w, ms) {
  for (const end = w.t + ms; w.t < end;) {
    w.t += 15000;
    await t._check();
  }
}

async function started(timing) {
  const w = world();
  const t = tunnelIn(w, timing);
  const urls = [];
  t.on('url', (u) => urls.push(u));
  await t.start(4000, 'cloudflared');
  return { w, t, urls, first: w.last() };
}

test('tunnel: a connection that comes back keeps its address', async () => {
  const { w, t, urls, first } = await started();
  assert.deepEqual(urls, [`https://${first.host}`]);
  w.online = false;
  await pass(t, w, 60000);
  assert.equal(t.state, 'error');
  assert.match(t.error, /No connection to Cloudflare/);
  assert.equal(w.spawned, 1, 'no new tunnel while the old one may come back');
  w.online = true;
  await pass(t, w, 15000);
  assert.equal(t.state, 'online');
  assert.equal(t.error, null);
  assert.deepEqual(urls, [`https://${first.host}`], 'same address');
  assert.equal(w.spawned, 1);
  await t.stop({ keep: true });
});

test('tunnel: one that never comes back is replaced once the PC is online again, and the old one ended', async () => {
  const { w, t, urls, first } = await started();
  w.online = false;
  first.gone = true;
  await pass(t, w, 200000);
  assert.ok(w.spawned >= 2 && w.spawned <= 6, `offline, a new tunnel was tried now and then (${w.spawned - 1} tries)`);
  assert.equal(urls.length, 1, 'no new address while offline');
  assert.equal(first.alive, true, 'the old one keeps its chance');
  assert.equal(t.saved().pid, first.pid);
  assert.equal(t.saved().next, undefined, 'a tunnel that did not open is not left in tunnel.json');
  w.online = true;
  await pass(t, w, 180000);
  assert.equal(urls.length, 2, 'one new address');
  const now = w.last();
  assert.equal(urls[1], `https://${now.host}`);
  assert.equal(first.alive, false, 'the old cloudflared is ended');
  assert.equal(t.state, 'online');
  assert.deepEqual(t.saved(), { pid: now.pid, port: 4000, metricsPort: now.metricsPort, startedAt: t.saved().startedAt });
  assert.ok(w.logs.some((l) => /did not come back; using a new one/.test(l)));
  await t.stop();
  assert.equal(now.alive, false, 'Stop ends the new one');
});

test('tunnel: the old one coming back while the new one opens keeps its address', async () => {
  const { w, t, urls, first } = await started();
  w.online = false;
  first.gone = true;
  await pass(t, w, 150000);
  // Online again, and the old tunnel reconnects a few seconds after the new one starts.
  w.online = true;
  first.gone = false;
  first.connectAt = Infinity;
  w.onSpawn = (p) => {
    first.connectAt = w.t + 5000;
    w.candidate = p;
  };
  await pass(t, w, 60000);
  assert.ok(w.candidate, 'a new tunnel was opened');
  assert.equal(urls.length, 1, 'same address');
  assert.equal(first.alive, true);
  assert.equal(w.candidate.alive, false, 'the new one is ended');
  assert.equal(t.state, 'online');
  assert.equal(t.saved().pid, first.pid);
  assert.equal(t.saved().next, undefined);
  await t.stop({ keep: true });
});

test('tunnel: cloudflared ending while offline is reopened once the PC is online, however long it takes', async () => {
  const { w, t, urls, first } = await started();
  first.alive = false;
  w.online = false;
  await pass(t, w, 600000);
  assert.equal(t.running, null);
  assert.equal(t.state, 'error');
  assert.match(t.error, /Trying again/);
  assert.ok(w.spawned <= 12, `tries get less frequent (${w.spawned - 1} in 10 minutes)`);
  w.online = true;
  await pass(t, w, 150000);
  assert.equal(urls.length, 2);
  assert.equal(t.state, 'online');
  await t.stop();
});

test('tunnel: started offline, it opens by itself once online', async () => {
  const w = world();
  const t = tunnelIn(w);
  const urls = [];
  t.on('url', (u) => urls.push(u));
  w.online = false;
  await assert.rejects(t.start(4000, 'cloudflared'), /exited/);
  assert.equal(t.state, 'error');
  w.online = true;
  await pass(t, w, 150000);
  assert.equal(urls.length, 1);
  assert.equal(t.state, 'online');
  await t.stop();
});

test('tunnel: a new tunnel left opening by an earlier process is ended; the tunnel itself is kept', async () => {
  const w = world();
  const t = tunnelIn(w);
  const a = { pid: 61001, metricsPort: 61101, host: 'kept.trycloudflare.com', alive: true };
  const b = { pid: 61002, metricsPort: 61102, host: 'half-open.trycloudflare.com', alive: true };
  w.procs.set(a.pid, a);
  w.procs.set(b.pid, b);
  t._save({ pid: a.pid, port: 4000, metricsPort: a.metricsPort, startedAt: 1, next: { pid: b.pid, port: 4000, metricsPort: b.metricsPort, startedAt: 2 } });
  assert.equal(await t.start(4000, 'cloudflared'), 'https://kept.trycloudflare.com');
  assert.equal(b.alive, false);
  assert.equal(a.alive, true);
  assert.deepEqual(t.saved(), { pid: a.pid, port: 4000, metricsPort: a.metricsPort, startedAt: 1 });
  await t.stop({ keep: true });
  assert.equal(a.alive, true, 'handing over keeps it running');
  assert.equal(w.spawned, 0);
});

test('tunnel: reachable once it answers, or connected for a while when this PC cannot reach its own address', async () => {
  const { w, t } = await started();
  const t0 = w.t;
  assert.equal(await t.waitReachable(), true);
  assert.ok(w.t - t0 < 15000, 'answers through Cloudflare right away');
  // A DNS answer cached before the address existed, a VPN or a filter: the phone gets through anyway.
  w.publicOk = false;
  const t1 = w.t;
  assert.equal(await t.waitReachable(), true);
  assert.ok(w.t - t1 >= 30000 && w.t - t1 < 45000, `trusted after being connected for 30s (${(w.t - t1) / 1000}s)`);
  assert.ok(w.logs.some((l) => /can't reach .* but the tunnel is connected to Cloudflare/.test(l)));
  // Without a connection, not reachable.
  w.online = false;
  await assert.rejects(t.waitReachable(20000), /not reachable yet: ENOTFOUND/);
  await t.stop({ keep: true });
});
