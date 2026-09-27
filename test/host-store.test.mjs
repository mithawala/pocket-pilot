import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '../pwa/vendor/ahp/client/index.js';
import { HostStore } from '../pwa/js/model/host-store.js';

const SESSION = 'copilotcli:/s1';
const CHAT = 'ahp-chat://default/s1';

/** Scripted AHP server on one half of an in-memory transport pair. */
function fakeHost(transport) {
  let seq = 100;
  const received = [];
  const subscriptions = new Set();
  const send = (m) => transport.send(m);
  const sessionState = { provider: 'copilotcli', title: 'Test', status: 33, lifecycle: 'ready', chats: [{ resource: CHAT, title: '', status: 1, modifiedAt: '' }], defaultChat: CHAT };
  const chatState = { resource: CHAT, title: '', status: 1, modifiedAt: '', turns: [] };
  (async () => {
    for (;;) {
      const f = await transport.recv();
      if (!f) return;
      const m = JSON.parse(f.text);
      received.push(m);
      const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'initialize') {
        reply({ protocolVersion: '0.9.0', serverSeq: seq, snapshots: [{ resource: 'ahp-root://', state: { agents: [{ provider: 'copilotcli', displayName: 'Copilot', description: '', models: [{ id: 'm1', name: 'Model 1', provider: 'copilotcli' }] }] }, fromSeq: seq }] });
      } else if (m.method === 'listSessions') {
        reply({ items: [{ resource: SESSION, provider: 'copilotcli', title: 'Test', status: 33, createdAt: '', modifiedAt: '2026-01-01T00:00:00Z', workingDirectories: ['file:///c%3A/work'] }] });
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

function setup(opts) {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  const conn = new EventTarget();
  conn.state = 'online';
  const store = new HostStore(conn, opts);
  const host = fakeHost(serverSide);
  conn.dispatchEvent(new CustomEvent('ready', { detail: { transport: clientSide } }));
  return { store, host };
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
