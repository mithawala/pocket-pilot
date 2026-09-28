import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SharedState } = require('../extension/shared.js');

test('windows share the running state, forward buttons, and one window answers a pairing request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shared-'));
  try {
    const host = new SharedState(dir);
    const other = new SharedState(dir);

    // The running window publishes; the others mirror it.
    host.writeMirror({ pid: process.pid, label: 'api', at: 1, view: { pairing: { link: 'https://x/#y' } } });
    assert.equal(other.readMirror().view.pairing.link, 'https://x/#y');

    // Stopping is remembered for every window.
    assert.equal(other.enabled(), false);
    host.setEnabled(true);
    assert.equal(other.enabled(), true);

    // Buttons pressed in another window reach the running one, once, in order.
    other.request('newCode');
    other.request('restartTunnel');
    assert.deepEqual(host.takeRequests().map((r) => r.action), ['newCode', 'restartTunnel']);
    assert.deepEqual(host.takeRequests(), []);

    // A pairing request: exactly one window may ask, and the host reads its answer.
    const id = host.postApproval({ name: 'iPhone' });
    assert.deepEqual(other.pendingApprovals().map((a) => a.info.name), ['iPhone']);
    assert.equal(other.claim(id), true);
    assert.equal(host.claim(id), false, 'a second window cannot ask as well');
    other.answer(id, true);
    assert.equal(host.readAnswer(id).allow, true);
    host.clearApproval(id);
    assert.deepEqual(other.pendingApprovals(), []);

    host.clearMirror();
    assert.equal(other.readMirror(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
