import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '../pwa/vendor/ahp/client/index.js';
import { HostStore } from '../pwa/js/model/host-store.js';
import { TOO_LARGE } from '../pwa/js/net/host-connection.js';

const SESSION = 'copilotcli:/s1';
const CHAT = 'ahp-chat://default/s1';

/**
 * Scripted AHP server on one half of an in-memory transport pair. `errorFor(request)` may answer a
 * request with an error instead; `listReply(n, answer)` decides when the n-th listSessions is answered
 * (VS Code sometimes takes minutes).
 */
function fakeHost(transport, { errorFor, listReply } = {}) {
  let seq = 100;
  const received = [];
  const subscriptions = new Set();
  const send = (m) => transport.send(m);
  const sessionState = { provider: 'copilotcli', title: 'Test', status: 33, lifecycle: 'ready', chats: [{ resource: CHAT, title: '', status: 1, modifiedAt: '' }], defaultChat: CHAT };
  const chatState = { resource: CHAT, title: '', status: 1, modifiedAt: '', turns: [] };
  let lists = 0;
  (async () => {
    for (;;) {
      const f = await transport.recv();
      if (!f) return;
      const m = JSON.parse(f.text);
      received.push(m);
      const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
      const error = m.id !== undefined && errorFor ? errorFor(m) : null;
      if (error) {
        send({ jsonrpc: '2.0', id: m.id, error });
        continue;
      }
      if (m.method === 'initialize') {
        reply({ protocolVersion: '0.9.0', serverSeq: seq, snapshots: [{ resource: 'ahp-root://', state: { agents: [{ provider: 'copilotcli', displayName: 'Copilot', description: '', models: [{ id: 'm1', name: 'Model 1', provider: 'copilotcli' }] }] }, fromSeq: seq }] });
      } else if (m.method === 'listSessions') {
        const answer = () => reply({ items: [{ resource: SESSION, provider: 'copilotcli', title: 'Test', status: 33, createdAt: '', modifiedAt: '2026-01-01T00:00:00Z', workingDirectories: ['file:///c%3A/work'] }] });
        if (listReply) listReply(++lists, answer);
        else answer();
      } else if (m.method === 'subscribe') {
        subscriptions.add(m.params.channel);
        const state = m.params.channel === SESSION ? sessionState : chatState;
        // An action racing with the snapshot: already included in the snapshot (seq <= fromSeq).
        send({ jsonrpc: '2.0', method: 'action', params: { channel: m.params.channel, serverSeq: seq, action: { type: 'session/titleChanged', title: 'stale' } } });
        reply({ snapshot: { resource: m.params.channel, state: structuredClone(state), fromSeq: seq } });
      } else if (m.method === 'unsubscribe') {
        subscriptions.delete(m.params.channel);
      } else if (m.method === 'dispatchAction') {
        seq++;
        send({ jsonrpc: '2.0', method: 'action', params: { channel: m.params.channel, action: m.params.action, serverSeq: seq, origin: { clientId: 'phone', clientSeq: m.params.clientSeq } } });
      } else if (m.id !== undefined) {
        reply({});
      }
    }
  })();
  return {
    received,
    subscriptions,
    push(channel, action) {
      seq++;
      send({ jsonrpc: '2.0', method: 'action', params: { channel, action, serverSeq: seq } });
    },
  };
}

function setup(opts, hostOpts) {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  const conn = new EventTarget();
  conn.state = 'online';
  const store = new HostStore(conn, opts);
  const host = fakeHost(serverSide, hostOpts);
  conn.dispatchEvent(new CustomEvent('ready', { detail: { transport: clientSide } }));
  return { store, host, conn };
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met');
};

test('loads sessions, subscribes session + default chat, applies live actions after the snapshot', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 30 });
  await until(() => store.sessionsLoaded);
  assert.equal(store.sortedSessions()[0].title, 'Test');
  assert.equal(store.models('copilotcli')[0].id, 'm1');
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  assert.equal(store.sessionState.get(SESSION).title, 'Test', 'racing action covered by the snapshot must be ignored');
  assert.ok(host.subscriptions.has(CHAT));
  host.push(CHAT, { type: 'chat/turnStarted', turnId: 't1', startedAt: new Date().toISOString(), message: { text: 'hi', origin: { kind: 'user' } } });
  await until(() => store.chatState.get(CHAT).activeTurn);
  host.push(CHAT, { type: 'chat/responsePart', turnId: 't1', part: { kind: 'markdown', id: 'p1', content: 'Hel' } });
  host.push(CHAT, { type: 'chat/delta', turnId: 't1', partId: 'p1', content: 'lo' });
  await until(() => store.chatState.get(CHAT).activeTurn?.responseParts?.[0]?.content === 'Hello');
  stop();
});

test('a second watcher keeps the chat alive when the first one releases (regression)', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 30 });
  await until(() => store.sessionsLoaded);
  const first = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  const second = store.watchSession(SESSION);
  first();
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(store.chatState.get(CHAT), 'chat must stay subscribed while a watcher remains');
  assert.ok(host.subscriptions.has(CHAT));
  second();
  await until(() => !store.chatState.get(CHAT) && !host.subscriptions.has(CHAT));
  assert.equal(store.subscribed.size, 0);
});

test('re-watching within the grace period cancels the release', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 60 });
  await until(() => store.sessionsLoaded);
  const a = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  a();
  const b = store.watchSession(SESSION);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(store.chatState.get(CHAT));
  assert.equal(host.received.filter((m) => m.method === 'unsubscribe').length, 0);
  b();
});

test('sendMessage dispatches a turn, or queues it while a turn is active', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 30 });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  assert.equal(store.sendMessage(SESSION, { text: 'first' }), 'sent');
  await until(() => store.chatState.get(CHAT).activeTurn?.message.text === 'first');
  assert.equal(store.localTurns.size, 0, 'the echoed turn replaces the optimistic one');
  assert.equal(store.sendMessage(SESSION, { text: 'second' }), 'queued');
  await until(() => store.chatState.get(CHAT).queuedMessages?.length === 1);
  const dispatched = host.received.filter((m) => m.method === 'dispatchAction').map((m) => m.params.action.type);
  assert.deepEqual(dispatched, ['chat/turnStarted', 'chat/pendingMessageSet']);
  stop();
});

const chatSubscribes = (host) => host.received.filter((m) => m.method === 'subscribe' && m.params.channel === CHAT).length;

test('a chat the computer could not send shows its error until Try again, without downloading it again by itself', async () => {
  let n = 0;
  const tooLarge = (m) => (m.method === 'subscribe' && m.params.channel === CHAT && ++n === 1 ? { code: TOO_LARGE, message: 'This is too large to load on your phone.' } : null);
  const { store, host } = setup({ unsubscribeDelayMs: 30 }, { errorFor: tooLarge });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.failedChats.has(CHAT));
  assert.equal(store.failedChats.get(CHAT), 'This is too large to load on your phone.');
  assert.equal(store.errors.length, 0, 'shown on the chat screen, not as a toast');
  assert.equal(store.chatFor(SESSION), CHAT);
  store._ensureChat(SESSION);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(chatSubscribes(host), 1, 'session updates must not fetch it again by themselves');
  store.retryChat(SESSION);
  await until(() => store.chatState.get(CHAT));
  assert.equal(store.failedChats.has(CHAT), false);
  assert.equal(chatSubscribes(host), 2);
  stop();
});

test('opening a chat again tries again', async () => {
  let n = 0;
  const once = (m) => (m.method === 'subscribe' && m.params.channel === CHAT && ++n === 1 ? { code: -32000, message: 'Chat not ready' } : null);
  const { store, host } = setup({ unsubscribeDelayMs: 30 }, { errorFor: once });
  await until(() => store.sessionsLoaded);
  const first = store.watchSession(SESSION);
  await until(() => store.failedChats.has(CHAT));
  first();
  const again = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  assert.equal(chatSubscribes(host), 2);
  again();
});

test('requests waiting behind a large incoming message do not time out while it arrives', async () => {
  const { store, host, conn } = setup({ unsubscribeDelayMs: 30, requestTimeoutMs: 150 }, { listReply: (_n, answer) => setTimeout(answer, 500) });
  const progress = setInterval(() => conn.dispatchEvent(new CustomEvent('progress', { detail: { bytes: 5 * 1048576 } })), 50);
  try {
    await until(() => store.sessionsLoaded, 3000);
  } finally {
    clearInterval(progress);
  }
  assert.equal(store.incoming, 5 * 1048576);
  conn.dispatchEvent(new CustomEvent('progress', { detail: { bytes: 0 } }));
  assert.equal(store.incoming, 0);
  assert.equal(host.received.filter((m) => m.method === 'listSessions').length, 1, 'answered within the extended time');
  assert.equal(store.errors.length, 0);
});

test('keeps asking for the session list while VS Code is slow to answer', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 30, requestTimeoutMs: 100 }, { listReply: (n, answer) => n > 2 && answer() });
  let sawSlow = false;
  store.addEventListener('change', () => {
    if (store.slowSessions) sawSlow = true;
  });
  await until(() => store.sessionsLoaded, 3000);
  assert.ok(sawSlow, 'the phone says it is still waiting');
  assert.equal(store.slowSessions, false);
  assert.equal(host.received.filter((m) => m.method === 'listSessions').length, 3);
  assert.equal(store.errors.length, 0, 'no "Could not load sessions" error');
});

test('a reconnect too large for the phone starts over without the open chats', async () => {
  const { store, conn } = setup({ unsubscribeDelayMs: 30 });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  // The connection drops; on the next one the computer's reply with the chat in it is too large.
  const [clientSide, serverSide] = InMemoryTransport.pair();
  const tooLarge = (m) => ((m.method === 'reconnect' || m.method === 'initialize') && JSON.stringify(m.params).includes(CHAT) ? { code: TOO_LARGE, message: 'This is too large to load on your phone.' } : null);
  const host2 = fakeHost(serverSide, { errorFor: tooLarge });
  let closed = 0;
  conn.sock = { close: () => closed++ };
  conn.dispatchEvent(new CustomEvent('ready', { detail: { transport: clientSide } }));
  await until(() => closed === 1);
  assert.ok(store.failedChats.has(CHAT));
  assert.equal(store.subscribed.has(CHAT), false);
  assert.ok(store.subscribed.has(SESSION), 'the session itself stays');
  // Connected again: no chat in the subscriptions this time.
  const [c3, s3] = InMemoryTransport.pair();
  const host3 = fakeHost(s3, { errorFor: tooLarge });
  conn.dispatchEvent(new CustomEvent('ready', { detail: { transport: c3 } }));
  await until(() => host3.received.some((m) => m.method === 'listSessions'));
  assert.equal(host3.received.some((m) => JSON.stringify(m.params || {}).includes(CHAT)), false);
  assert.ok(host2.received.length > 0);
  stop();
});
