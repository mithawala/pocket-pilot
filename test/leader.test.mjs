// Leader election across VS Code windows: "Move it to this window" hands the lock over directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Leader } = require('../extension/leader.js');

test('the running window hands its lock straight to the window that asked, and cannot take it back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-leader-'));
  // Another live process stands in for the window that asked to take over.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const running = new Leader(dir, 'Window A');
    assert.equal(running.acquire().ok, true);

    const asking = { pid: other.pid, label: 'Window B' };
    fs.writeFileSync(path.join(dir, 'takeover.json'), JSON.stringify({ ...asking, at: Date.now() }));
    assert.deepEqual(running.pendingTakeover(), asking);

    running.handOver(asking);
    assert.equal(running.held, false);
    assert.deepEqual({ pid: running.holder().pid, label: running.holder().label }, asking, 'the lock now names the asking window');
    // There is never a moment without a holder, so neither the old window nor a third one can start.
    const again = running.acquire();
    assert.equal(again.ok, false);
    assert.equal(again.holder.pid, other.pid);
  } finally {
    other.kill();
  }
  await new Promise((r) => other.once('exit', r));
  const later = new Leader(dir, 'Window A');
  assert.equal(later.acquire().ok, true, 'a lock held by a closed window is free again');
});

test('a window keeps a lock that was handed to it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-leader-'));
  const file = path.join(dir, 'leader.json');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, since: Date.now(), label: 'another window' }));
  const before = fs.statSync(file).ino;
  const me = new Leader(dir, 'Window B');
  assert.equal(me.acquire().ok, true);
  assert.equal(me.held, true);
  assert.equal(fs.statSync(file).ino, before, 'taken over in place, not deleted and re-created');
  me.release();
  assert.equal(fs.existsSync(file), false);
});
