import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

// The hub keeps its state under POCKET_PILOT_HOME: use a throwaway one (set before the modules load).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hub-test-'));
process.env.POCKET_PILOT_HOME = home;
fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ enabled: true, settings: { tunnel: 'none', passkey: 'off', requireApproval: false } }));
const lib = '../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib';
const ipc = await import(`${lib}/ipc.mjs`);

const lockFile = path.join(home, 'hub.lock');
const setLock = (pid, ageMs = 0) => {
  fs.writeFileSync(lockFile, String(pid));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(lockFile, t, t);
};

test('hub lock: live owners keep it; dead or silent owners (reused PIDs) lose it', () => {
  fs.rmSync(lockFile, { force: true });
  assert.equal(ipc.takeLock(), true, 'free lock');
  assert.equal(ipc.lockInfo().pid, process.pid);
  assert.equal(ipc.takeLock(), true, 're-entrant for the owner');
  ipc.releaseLock();
  assert.equal(fs.existsSync(lockFile), false);

  const other = process.ppid;
  setLock(other);
  assert.equal(ipc.takeLock(), false, 'a live owner with a fresh heartbeat keeps the lock');
  setLock(other, ipc.LOCK_STALE_MS + 5000);
  assert.equal(ipc.takeLock(), true, 'a live PID that stopped refreshing the lock (reused PID) loses it');
  setLock(2147483646);
  assert.equal(ipc.takeLock(), true, 'a dead owner loses the lock');
  assert.equal(fs.readdirSync(home).filter((f) => f.startsWith('hub.lock.')).length, 0, 'no temp or stale files left behind');

  // hub.json is only trusted while its owner holds a fresh lock.
  const info = { pid: process.pid, port: 1, token: 'x' };
  assert.equal(ipc.hubAlive(info), true);
  setLock(process.pid, ipc.LOCK_STALE_MS + 5000);
  assert.equal(ipc.hubAlive(info), false);
  ipc.releaseLock();
  assert.equal(ipc.hubAlive(info), false);
});

function raw(port, text) {
  return new Promise((resolve) => {
    let data = '';
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    s.on('data', (d) => {
      data += d;
    });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    setTimeout(() => s.destroy(), 1500);
  });
}

test('hub: boots in-process, serves status over a control connection, rejects bad pairing-page requests, stops cleanly', async () => {
  fs.rmSync(lockFile, { force: true });
  const { startHub } = await import(`${lib}/hub.mjs`);
  const hub = await startHub();
  assert.ok(hub, 'hosted here');
  try {
    const info = ipc.readJson(path.join(home, 'hub.json'));
    assert.equal(info.pid, process.pid);
    assert.equal(ipc.hubAlive(info), true);

    const ch = await ipc.connect(info.port, info.token, { pid: process.pid });
    const rpc = new ipc.Rpc(ch, {});
    const status = await rpc.request('status');
    assert.equal(status.sessions, 0);
    assert.match(status.pageUrl, /^http:\/\/127\.0\.0\.1:\d+\/pair\?k=/);
    await assert.rejects(ipc.connect(info.port, 'wrong-token', {}), /refused|not running/);

    const page = new URL(status.pageUrl);
    const port = Number(page.port);
    assert.match(await raw(port, 'GET //x:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/pair?k=nope`)).status, 403);
    assert.match(await raw(port, `GET /pair${page.search} HTTP/1.1\r\nHost: rebind.example:${port}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403/, 'foreign Host headers (DNS rebinding) are refused');
    const state = await fetch(`http://127.0.0.1:${port}/pair/state${page.search}`).then((r) => r.json());
    assert.ok(state.pairing?.link.includes('#'), 'a pairing code is ready without a tunnel');
    assert.equal((await fetch(status.pageUrl)).status, 200, 'still serving after the bad request');

    await rpc.request('stop');
    await new Promise((r) => setTimeout(r, 400));
    ch.close();
    assert.equal(hub.stopped, true);
    assert.equal(fs.existsSync(path.join(home, 'hub.json')), false);
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    await hub.stop();
  }
});

test('hub: the pairing page stays up when remote access is turned off there, and turns it back on', async () => {
  fs.rmSync(lockFile, { force: true });
  const stateFile = path.join(home, 'state.json');
  const { startHub } = await import(`${lib}/hub.mjs`);
  const hub = await startHub();
  assert.ok(hub);
  const info = ipc.readJson(path.join(home, 'hub.json'));
  const ch = await ipc.connect(info.port, info.token, { pid: process.pid });
  const { pageUrl } = await new ipc.Rpc(ch, {}).request('status');
  ch.close();
  const page = new URL(pageUrl);
  const get = (p) => fetch(`http://127.0.0.1:${page.port}${p}${page.search}`).then((r) => r.json());
  const post = (p, b = {}) => fetch(`http://127.0.0.1:${page.port}${p}${page.search}`, { method: 'POST', body: JSON.stringify(b) }).then((r) => r.json());
  const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) {
      if (await fn().catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${what}`);
  };
  let next = null;
  try {
    assert.equal((await get('/pair/state')).on, true);
    await post('/pair/off');
    await until(async () => (await get('/pair/state')).on === false, 'the page shows remote access off');
    assert.equal(hub.stopped, true);
    assert.equal(ipc.readJson(stateFile).enabled, false);
    assert.equal(fs.existsSync(path.join(home, 'hub.json')), false, 'no hub while off');
    const off = await get('/pair/state');
    assert.deepEqual(off.devices, []);
    assert.equal(off.pairing, undefined, 'no pairing code while off');
    assert.equal((await fetch(pageUrl)).status, 200, 'the page itself still loads');

    await post('/pair/on');
    await until(async () => (await get('/pair/state')).on === true, 'the page shows remote access on again');
    assert.equal(ipc.readJson(stateFile).enabled, true);
    next = ipc.readJson(path.join(home, 'hub.json'));
    assert.equal(ipc.hubAlive(next), true, 'a new hub runs');
    const on = await get('/pair/state');
    assert.equal(on.pageUrl, pageUrl, 'same page: the panel keeps working');
    await until(async () => !!(await get('/pair/state')).pairing, 'a pairing code');
  } finally {
    await hub.stop();
    if (next) {
      const c = await ipc.connect(next.port, next.token, { pid: process.pid }).catch(() => null);
      if (c) {
        await new ipc.Rpc(c, {}).request('stop').catch(() => {});
        c.close();
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
});

test.after(async () => {
  const { closePageServer } = await import(`${lib}/hub.mjs`);
  closePageServer();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});
