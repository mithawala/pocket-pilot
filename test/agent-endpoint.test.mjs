// Finding VS Code's agent host. After VS Code restarted to update (1.144), Pocket Pilot kept connecting
// to the agent host of an earlier run: VS Code had left its entry behind, the old process ID was still
// taken on Windows (so it looked alive), and the stale entry came first in the folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const agentHost = createRequire(import.meta.url)('../extension/core/agentHost.js');
const win = process.platform === 'win32';
const name = () => `pp-test-agent-host-${crypto.randomBytes(6).toString('hex')}`;

/** A pipe (Windows) or socket file that exists, like a running agent host's. */
function listen() {
  const p = win ? `\\\\.\\pipe\\${name()}` : path.join(os.tmpdir(), `${name()}.sock`);
  const server = net.createServer((s) => s.destroy());
  return new Promise((resolve) => server.listen(p, () => resolve({ path: p, close: () => new Promise((r) => server.close(r)) })));
}

function userData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-userdata-'));
  const entries = agentHost.endpointDir(dir);
  fs.mkdirSync(entries, { recursive: true });
  return {
    dir,
    write(file, entry, writtenAt) {
      const f = path.join(entries, file);
      fs.writeFileSync(f, JSON.stringify({ schemaVersion: 1, instanceId: file, connectionToken: 'token', protocolVersion: '1.1.0', ...entry }));
      const t = new Date(writtenAt);
      fs.utimesSync(f, t, t);
    },
  };
}

test('a stale entry whose process ID is still taken is skipped: its pipe is gone', async () => {
  const live = await listen();
  const ud = userData();
  try {
    // The previous run's entry, first in the folder, its process ID taken (this test's own process).
    const gone = win ? `\\\\.\\pipe\\${name()}` : path.join(os.tmpdir(), `${name()}.sock`);
    ud.write('1-stale.json', { type: 'editor', pid: process.pid, endpoint: { type: 'socket', path: gone } }, '2026-10-18T19:04:36Z');
    ud.write('2-live.json', { type: 'editor', pid: process.pid, endpoint: { type: 'socket', path: live.path } }, '2026-10-28T11:10:41Z');
    const picked = agentHost.selectEndpoint(ud.dir);
    assert.equal(picked?.endpoint.path, live.path);
    assert.deepEqual(agentHost.listEndpoints(ud.dir).map((e) => e.instanceId), ['2-live.json']);
    // And it really connects.
    const conn = await new Promise((resolve, reject) => {
      const s = net.connect(picked.endpoint.path, () => resolve(s)).on('error', reject);
    });
    conn.destroy();
  } finally {
    await live.close();
    fs.rmSync(ud.dir, { recursive: true, force: true });
  }
});

test('of several live entries, the newest comes first; editor ones before others; dead processes are skipped', async () => {
  const a = await listen();
  const b = await listen();
  const ud = userData();
  try {
    ud.write('a.json', { type: 'editor', pid: process.pid, endpoint: { type: 'socket', path: a.path } }, '2026-10-20T10:00:00Z');
    ud.write('b.json', { type: 'editor', pid: process.pid, endpoint: { type: 'socket', path: b.path } }, '2026-10-28T10:00:00Z');
    ud.write('c.json', { type: 'standalone', pid: process.pid, endpoint: { type: 'tcp', host: '127.0.0.1', port: 9 } }, '2026-10-29T10:00:00Z');
    // A process that has exited (a spawned node, waited for).
    const exited = (await import('node:child_process')).spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    ud.write('d.json', { type: 'editor', pid: Number(exited.stdout.trim()), endpoint: { type: 'tcp', host: '127.0.0.1', port: 9 } }, '2026-10-30T10:00:00Z');
    fs.writeFileSync(path.join(agentHost.endpointDir(ud.dir), 'half-written.json'), '{"type":"edi');
    assert.deepEqual(agentHost.listEndpoints(ud.dir).map((e) => e.instanceId), ['b.json', 'a.json', 'c.json']);
    assert.equal(agentHost.selectEndpoint(ud.dir).instanceId, 'b.json');
    assert.equal(agentHost.selectEndpoint(ud.dir, { types: ['standalone'] }).instanceId, 'c.json');
  } finally {
    await a.close();
    await b.close();
    fs.rmSync(ud.dir, { recursive: true, force: true });
  }
});

test('no entries folder: no endpoint', () => {
  assert.equal(agentHost.selectEndpoint(path.join(os.tmpdir(), `pp-missing-${crypto.randomBytes(4).toString('hex')}`)), null);
});
