// SessionMonitor against a scripted agent host connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionMonitor } = require('../extension/core/monitor.js');

/** A fake agent host connection: `reply` answers requests; `emit` pushes frames whenever the test wants. */
function scriptedConnection(reply) {
  const conn = new EventEmitter();
  conn.requests = [];
  conn.send = (text) => {
    const m = JSON.parse(text);
    conn.requests.push(m);
    const frames = reply(m) || [];
    queueMicrotask(() => conn.emitFrames(frames));
  };
  // Like one TCP read in wslite: every frame back to back in the same tick.
  conn.emitFrames = (frames) => {
    for (const f of frames) conn.emit('message', JSON.stringify(f), false);
  };
  conn.close = () => conn.emit('close');
  return conn;
}

async function waitUntil(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a session tracked for an error status keeps the actions it gets before its snapshot is in', async () => {
  const S = 'copilotcli:/s1';
  const conn = scriptedConnection((m) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return [ok({ protocolVersion: '0.9.0', serverSeq: 5, snapshots: [{ resource: 'ahp-root://', fromSeq: 5, state: { agents: [] } }] })];
    // A sub-agent failed while the main chat is still working: the host reports the whole session as failed.
    if (m.method === 'listSessions') return [ok({ items: [{ resource: S, provider: 'copilotcli', title: 'Work', status: 2 }] })];
    if (m.method === 'subscribe') return []; // answered by the test
    return m.id !== undefined ? [ok({})] : [];
  });
  const monitor = new SessionMonitor({ getEndpoint: () => ({ type: 'test' }), openConnection: async () => conn });
  const pushed = [];
  monitor.on('effective', (e) => pushed.push(e));
  monitor.start();
  try {
    await waitUntil(() => conn.requests.some((m) => m.method === 'subscribe'));
    const sub = conn.requests.find((m) => m.method === 'subscribe');
    const action = (serverSeq, status) => ({ jsonrpc: '2.0', method: 'action', params: { channel: S, serverSeq, action: { type: 'session/chatUpdated', chat: 'c1', changes: { status } } } });
    // The client can process actions before the subscribe reply resolves (both arrive in one read).
    conn.emitFrames([action(5, 16), action(6, 1)]);
    await new Promise((r) => setTimeout(r, 50));
    conn.emitFrames([{ jsonrpc: '2.0', id: sub.id, result: { snapshot: { resource: S, fromSeq: 5, state: { defaultChat: 'c1', chats: [{ resource: 'c1', status: 8 }, { resource: 'c2', status: 2, interactivity: 'read-only' }] } } } }]);
    await waitUntil(() => monitor.tracked.get(S)?.state);
    assert.equal(monitor.adjustSummary({ resource: S, status: 2 }).status, 1, 'the finished main chat is not lost (and seq 5 is not re-applied)');
    assert.deepEqual(pushed.at(-1), { uri: S, status: 1 });
    assert.equal(monitor.tracked.get(S).pending.length, 0);

    // Later actions still apply; stale ones are ignored.
    conn.emitFrames([action(4, 16), action(7, 8)]);
    await waitUntil(() => monitor.adjustSummary({ resource: S, status: 2 }).status === 8);
  } finally {
    monitor.stop();
  }
});

test('a notification never loads the whole chat of a session that keeps a lot on disk', async () => {
  const S = 'copilotcli:/big';
  const CHAT = 'ahp-chat:/big';
  const conn = scriptedConnection((m) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return [ok({ protocolVersion: '1.1.0', serverSeq: 5, snapshots: [{ resource: 'ahp-root://', fromSeq: 5, state: { agents: [] } }] })];
    if (m.method === 'listSessions') return [ok({ items: [{ resource: S, provider: 'copilotcli', title: 'Big', status: 1 }] })];
    if (m.method === 'subscribe' && m.params.channel === S) return [ok({ snapshot: { resource: S, fromSeq: 5, state: { defaultChat: CHAT, chats: [{ resource: CHAT, status: 1 }] } } })];
    if (m.method === 'subscribe' && m.params.channel === CHAT) return [ok({ snapshot: { resource: CHAT, fromSeq: 5, state: { turns: [{ id: 't1', responseParts: [{ kind: 'markdown', id: 'p', content: 'All **done**: the app is live.' }] }] } } })];
    return m.id !== undefined ? [ok({})] : [];
  });
  // Like the CAIP chat: 462 MB on disk, most of it the copies its edits keep.
  let size = 462 * 1024 * 1024;
  const monitor = new SessionMonitor({ getEndpoint: () => ({ type: 'test' }), openConnection: async () => conn, storeSize: (uri) => (uri === S ? size : null) });
  monitor.start();
  try {
    await waitUntil(() => monitor.connected);
    const chatLoads = () => conn.requests.filter((m) => m.method === 'subscribe' && m.params.channel === CHAT).length;
    assert.deepEqual(await monitor.describeDone(S), { text: 'Finished.', chat: CHAT });
    assert.equal((await monitor.describeInput(S)).text, 'The agent is waiting for you.');
    assert.equal(chatLoads(), 0, 'its chat was not loaded');
    // An ordinary session: its last sentence, as before.
    size = 5 * 1024 * 1024;
    assert.deepEqual(await monitor.describeDone(S), { text: 'All done: the app is live.', chat: CHAT });
    assert.equal(chatLoads(), 1);
    size = null;
    assert.equal((await monitor.describeDone(S)).text, 'All done: the app is live.', 'unknown size: as before');
  } finally {
    monitor.stop();
  }
});