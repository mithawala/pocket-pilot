import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '../pwa/vendor/ahp/client/index.js';
import { HostStore } from '../pwa/js/model/host-store.js';
import { TOO_LARGE } from '../pwa/js/net/host-connection.js';

const SESSION = 'copilotcli:/s1';
const CHAT = 'ahp-chat://default/s1';

/**
 * Scripted AHP server on one half of an in-memory transport pair. `errorFor(request)` may answer a
 * request with an error instead; `hang(request)` leaves it unanswered; `listReply(n, answer)` decides
 * when the n-th listSessions is answered (VS Code sometimes takes minutes).
 */
function fakeHost(transport, { errorFor, hang, listReply, protocolVersion = '0.9.0', sessionConfig, chatConfig, chatExtra, sessionExtra } = {}) {
  let seq = 100;
  const received = [];
  const subscriptions = new Set();
  const send = (m) => transport.send(m);
  const sessionState = { provider: 'copilotcli', title: 'Test', status: 33, lifecycle: 'ready', chats: [{ resource: CHAT, title: '', status: 1, modifiedAt: '' }], defaultChat: CHAT, ...(sessionConfig ? { config: sessionConfig } : {}), ...sessionExtra };
  const chatState = { resource: CHAT, title: '', status: 1, modifiedAt: '', turns: [], ...(chatConfig ? { config: chatConfig } : {}), ...chatExtra };
  const rootSnapshot = () => ({ resource: 'ahp-root://', state: { agents: [{ provider: 'copilotcli', displayName: 'Copilot', description: '', models: [{ id: 'm1', name: 'Model 1', provider: 'copilotcli' }] }] }, fromSeq: seq });
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
      if (m.id !== undefined && hang?.(m)) continue;
      if (m.method === 'initialize') {
        reply({ protocolVersion, serverSeq: seq, snapshots: [rootSnapshot()] });
      } else if (m.method === 'reconnect') {
        // A new agent host (it doesn't know this client): snapshots of what the client still has open.
        const open = (m.params.subscriptions || []).filter((c) => c === SESSION || c === CHAT);
        for (const c of open) subscriptions.add(c);
        reply({ type: 'snapshot', snapshots: [rootSnapshot(), ...open.map((c) => ({ resource: c, state: structuredClone(c === SESSION ? sessionState : chatState), fromSeq: seq }))] });
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
    transport,
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

const hostStopped = (conn, loading) => conn.dispatchEvent(new CustomEvent('control', { detail: { message: { t: 'ahp.status', connected: false, stopped: true, reason: 'The VS Code agent host stopped.', ...(loading ? { loading } : {}) } } }));
const reconnect = (conn, hostOpts) => {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  const host = fakeHost(serverSide, hostOpts);
  conn.dispatchEvent(new CustomEvent('ready', { detail: { transport: clientSide } }));
  return host;
};

test('a conversation that was opening when the agent host stopped is not opened again by itself, until Try again', async () => {
  // VS Code's agent host runs out of memory while it sends a very long chat: it stops before answering.
  const { store, host, conn } = setup({ unsubscribeDelayMs: 30 }, { hang: (m) => m.method === 'subscribe' && m.params.channel === CHAT });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => host.received.some((m) => m.method === 'subscribe' && m.params.channel === CHAT));
  hostStopped(conn, [CHAT]);
  assert.ok(store.isStalled(SESSION));
  assert.match(store.stalledText(SESSION), /stopped on your computer while this conversation was opening/);
  assert.equal(store.subscribed.has(SESSION) || store.subscribed.has(CHAT), false);
  assert.equal(store.sessionState.has(SESSION), false, 'not shown as if it were live');

  // VS Code starts it again and the phone connects again: the conversation is not asked for again...
  const host2 = reconnect(conn);
  await until(() => store.sessionsLoaded && host2.received.some((m) => m.method === 'listSessions'));
  const opened = (h) => h.received.filter((m) => [SESSION, CHAT].includes(m.params?.channel) || (m.params?.subscriptions || m.params?.initialSubscriptions || []).some((c) => c === SESSION || c === CHAT));
  assert.deepEqual(opened(host2), []);
  // ...nor when its chat is shown again (the person goes back and opens it from the list).
  stop();
  const again = store.watchSession(SESSION);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(opened(host2), []);
  assert.equal(store.errors.length, 0, 'no "transport closed" error');

  // Try again opens it.
  store.retryChat(SESSION);
  await until(() => store.chatState.get(CHAT));
  assert.equal(store.isStalled(SESSION), false);
  assert.equal(store.stalledText(SESSION), null);
  again();
});

test('what the computer saw opening counts too, and stalled sessions stay closed for a while only', async () => {
  const { store, conn } = setup({ unsubscribeDelayMs: 30 });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  // The phone has the chat, but the computer was sending it again (a reconnect) when its agent host stopped.
  hostStopped(conn, [CHAT, 'ahp-chat:/unknown', 42]);
  assert.ok(store.isStalled(SESSION));
  assert.equal(store.stalled.size, 1, 'only what this phone has open');
  // After a while it opens by itself again.
  store.stalled.set(SESSION, Date.now() - 16 * 60 * 1000);
  assert.equal(store.isStalled(SESSION), false);
  assert.equal(store.stalled.size, 0);
  // Without a word from the computer, a dropped connection marks nothing.
  const { store: s2, host: h2, conn: c2 } = setup({ unsubscribeDelayMs: 30 });
  await until(() => s2.sessionsLoaded);
  c2.dispatchEvent(new CustomEvent('control', { detail: { message: { t: 'ahp.status', connected: false, reason: 'The VS Code agent host is not running.', restartable: true } } }));
  assert.equal(s2.stalled.size, 0);
  assert.equal(s2.ahpRestartable, true);
  assert.ok(h2.received.length > 0);
  stop();
});

test('a dropped connection is not an error: what was open opens again when the connection is back', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 30 }, { hang: (m) => m.method === 'subscribe' && m.params.channel === CHAT });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => host.received.some((m) => m.method === 'subscribe' && m.params.channel === CHAT));
  // The phone's connection drops (the computer said nothing about its agent host).
  host.transport.close();
  await until(() => !store.loads.has(CHAT));
  assert.equal(store.errors.length, 0, 'no "Could not open chat: transport closed"');
  assert.ok(store.subscribed.has(CHAT));
  assert.equal(store.isStalled(SESSION), false);
  const host2 = reconnect(store.conn);
  await until(() => store.chatState.get(CHAT));
  assert.ok(host2.received.find((m) => m.method === 'reconnect').params.subscriptions.includes(CHAT));
  stop();
});

// VS Code 1.143's settings schema: mode and approvals can be set per chat, the folder only per session.
const VSCODE_CONFIG = {
  schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', title: 'Agent Mode', enum: ['interactive', 'plan', 'autopilot'], enumLabels: ['Interactive', 'Plan', 'Autopilot'], default: 'interactive', sessionMutable: true, chatMutable: true },
      autoApprove: { type: 'string', title: 'Approvals', enum: ['default', 'assisted', 'autoApprove'], enumLabels: ['Manual permissions', 'Assisted permissions', 'Allow all'], default: 'default', sessionMutable: true, chatMutable: true },
      isolation: { type: 'string', title: 'Isolation', enum: ['folder', 'worktree'], sessionMutable: true },
    },
  },
  values: { mode: 'interactive', autoApprove: 'autoApprove', isolation: 'folder' },
};
const dispatched = (host) => host.received.filter((m) => m.method === 'dispatchAction').map((m) => ({ channel: m.params.channel, ...m.params.action }));

test('a chat set to Autopilot in VS Code shows Autopilot, and changing the mode on the phone changes it for that chat', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 30 }, { protocolVersion: '1.1.0', sessionConfig: VSCODE_CONFIG, chatConfig: { values: { mode: 'autopilot', isolation: 'worktree' } } });
  await until(() => store.sessionsLoaded);
  assert.equal(store.protocolVersion, '1.1.0');
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  const cfg = store.configFor(SESSION);
  assert.equal(cfg.values.mode, 'autopilot', 'the chat\'s own mode, not the session\'s "interactive"');
  assert.equal(cfg.values.autoApprove, 'autoApprove', 'the session\'s approvals where the chat has none of its own');
  assert.equal(cfg.values.isolation, 'folder', 'a setting a chat can\'t have stays the session\'s');
  assert.deepEqual(cfg.schema, VSCODE_CONFIG.schema);

  store.setConfig(SESSION, { mode: 'interactive', isolation: 'worktree' });
  await until(() => store.configFor(SESSION).values.mode === 'interactive');
  assert.deepEqual(dispatched(host), [
    { channel: CHAT, type: 'chat/configChanged', config: { mode: 'interactive' } },
    { channel: SESSION, type: 'session/configChanged', config: { isolation: 'worktree' } },
  ], 'like VS Code: per-chat settings to the chat, the rest to the session');
  await until(() => store.configFor(SESSION).values.isolation === 'worktree');

  // A change made in VS Code shows on the phone.
  host.push(CHAT, { type: 'chat/configChanged', config: { mode: 'plan' } });
  await until(() => store.configFor(SESSION).values.mode === 'plan');
  host.push(CHAT, { type: 'chat/configChanged', config: { autoApprove: 'default' }, replace: true });
  await until(() => store.configFor(SESSION).values.autoApprove === 'default');
  assert.equal(store.configFor(SESSION).values.mode, 'interactive', 'replace drops the chat\'s other own settings: back to the session\'s');
  stop();
});

test('computers before protocol 1.1.0 get settings on the session, as before', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 30 }, { protocolVersion: '1.0.0', sessionConfig: VSCODE_CONFIG });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  assert.equal(store.configFor(SESSION).values.mode, 'interactive');
  store.setConfig(SESSION, { mode: 'plan' });
  await until(() => store.configFor(SESSION).values.mode === 'plan');
  assert.deepEqual(dispatched(host), [{ channel: SESSION, type: 'session/configChanged', config: { mode: 'plan' } }]);
  stop();
});

// VS Code 1.144 (AHP 1.1.0) keeps every waiting message in queuedMessages with its kind, and the steering
// one again in steeringMessage. The phone showed a steering message twice (also as "Queued"), and Remove
// or Send Immediately on that copy did nothing, so a second copy got sent. Like the real chat: an
// orphaned copy (s0), the current steering message (s1), and a queued message (q1).
const msg = (text) => ({ text, origin: { kind: 'user' } });
const PENDING_1_1 = {
  activeTurn: { id: 't1', startedAt: '', message: msg('go'), responseParts: [] },
  steeringMessage: { id: 's1', kind: 'steering', message: msg('Also make the labs relevant') },
  queuedMessages: [
    { id: 's0', kind: 'steering', message: msg('Also make the labs relevant') },
    { id: 's1', kind: 'steering', message: msg('Also make the labs relevant') },
    { id: 'q1', kind: 'queued', message: msg('Then write the summary') },
  ],
};
const shown = (store) => store.pendingMessages(CHAT).map((m) => `${m.kind}:${m.id}:${m.message.text}`);

test('VS Code 1.144: each waiting message shows once with its kind, and Remove, Edit and Send Immediately work', async () => {
  const { store, host } = setup({ unsubscribeDelayMs: 30 }, { protocolVersion: '1.1.0', chatExtra: structuredClone(PENDING_1_1) });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  assert.deepEqual(shown(store), ['steering:s0:Also make the labs relevant', 'steering:s1:Also make the labs relevant', 'queued:q1:Then write the summary'], 'not s1 a second time as "Queued"');

  // Remove the orphaned copy: VS Code removes it only when the kind matches.
  store.removePending(CHAT, 'steering', 's0');
  await until(() => !store.pendingMessages(CHAT).some((m) => m.id === 's0'));
  assert.deepEqual(dispatched(host).at(-1), { channel: CHAT, type: 'chat/pendingMessageRemoved', kind: 'steering', id: 's0' });
  assert.equal(store.chatState.get(CHAT).steeringMessage.id, 's1', 'the current steering message stays');

  store.editPending(CHAT, 'queued', 'q1', 'Then write a short summary');
  await until(() => store.pendingMessages(CHAT).some((m) => m.id === 'q1' && m.message.text === 'Then write a short summary'));

  // Send Immediately: the queued message becomes steering, once.
  store.sendPendingNow(SESSION, CHAT, 'q1');
  await until(() => !store.pendingMessages(CHAT).some((m) => m.id === 'q1') && store.pendingMessages(CHAT).length === 2);
  const [first, second] = store.pendingMessages(CHAT);
  assert.equal(first.id, 's1');
  assert.equal(second.kind, 'steering');
  assert.equal(second.message.text, 'Then write a short summary');
  assert.equal(store.chatState.get(CHAT).steeringMessage.id, second.id);

  // The agent takes the steering messages (VS Code removes each one it hands over).
  host.push(CHAT, { type: 'chat/pendingMessageRemoved', kind: 'steering', id: 's1' });
  host.push(CHAT, { type: 'chat/pendingMessageRemoved', kind: 'steering', id: second.id });
  await until(() => store.pendingMessages(CHAT).length === 0);
  assert.equal(store.chatState.get(CHAT).queuedMessages, undefined);
  assert.equal(store.chatState.get(CHAT).steeringMessage, undefined);
  stop();
});

test('older VS Code: steering is only in steeringMessage, as before', async () => {
  const { store } = setup({ unsubscribeDelayMs: 30 }, { protocolVersion: '1.0.0', chatExtra: { activeTurn: PENDING_1_1.activeTurn, queuedMessages: [{ id: 'q1', message: msg('Then write the summary') }] } });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  store.steer(SESSION, { text: 'Use TypeScript' });
  await until(() => store.chatState.get(CHAT).steeringMessage);
  assert.deepEqual(shown(store), ['steering:' + store.chatState.get(CHAT).steeringMessage.id + ':Use TypeScript', 'queued:q1:Then write the summary']);
  assert.equal(store.chatState.get(CHAT).queuedMessages.length, 1, 'the 1.0.0 reducer: steering stays out of the queue list');
  store.removePending(CHAT, 'steering', store.chatState.get(CHAT).steeringMessage.id);
  await until(() => !store.chatState.get(CHAT).steeringMessage);
  assert.deepEqual(shown(store), ['queued:q1:Then write the summary']);
  stop();
});

test('Stop and send for a steering message the agent never took: removed, the turn stopped, sent as a new turn', async () => {
  const chatExtra = structuredClone(PENDING_1_1);
  chatExtra.activeTurn.startedAt = new Date().toISOString();
  const { store, host } = setup({ unsubscribeDelayMs: 30 }, { protocolVersion: '1.1.0', chatExtra });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT));
  const before = Date.now();
  assert.ok(store.waitingSince('s1') >= before - 5 && store.waitingSince('s1') === store.waitingSince('s1'), 'the time this phone first saw it, kept');
  await store.deliverSteeringNow(SESSION, CHAT, 's1');
  await until(() => store.chatState.get(CHAT).activeTurn?.message?.text === 'Also make the labs relevant');
  const sent = dispatched(host).map((a) => `${a.type}${a.kind ? `:${a.kind}` : ''}${a.id ? `:${a.id}` : ''}`);
  assert.deepEqual(sent, ['chat/pendingMessageRemoved:steering:s1', 'chat/turnCancelled', 'chat/turnStarted'], 'removed first, so VS Code does not run it a second time');
  assert.deepEqual(store.pendingMessages(CHAT).map((m) => m.id), ['s0', 'q1'], 'the others stay');
  await assert.rejects(() => Promise.resolve().then(() => store.deliverSteeringNow(SESSION, CHAT, 's1')), /already sent/);
  stop();
});

// A sub-agent waits for a GitHub MCP sign-in that only the computer can do (seen live: 4 searches, for
// 10 hours). Continue without signing in ends every call waiting on that server, in every chat, as
// VS Code's Cancel does, which releases the sign-in; other servers' sign-ins stay.
test('Continue without signing in skips every call waiting on that MCP server, in the sub-agents too', async () => {
  const SUB = 'ahp-chat:/sub1';
  const mcpCall = (id, server = 'github-mcp-server') => ({ toolCallId: id, toolName: `${server}-search_repositories`, displayName: 'Search repositories', status: 'auth-required', contributor: { kind: 'mcp', customizationId: `mcp-top-level:copilotcli:s1:${server}` }, _meta: { mcpServerName: server }, auth: { reason: 'insufficientScope', resource: { resource: 'https://example.test/mcp', resource_name: 'GitHub MCP Server' } } });
  const signIn = (chat, turnId, tc) => ({ id: `toolAuthentication:${chat}:${turnId}:${tc.toolCallId}`, kind: 'toolAuthentication', chat, turnId, toolCall: tc });
  const sessionExtra = {
    chats: [{ resource: CHAT, title: '', status: 8, modifiedAt: '' }, { resource: SUB, title: 'Research Wan2GP', status: 24, modifiedAt: '', origin: { kind: 'tool', chat: CHAT, toolCallId: 'task1' }, interactivity: 'read-only' }],
    inputNeeded: [
      ...['a', 'b', 'c', 'd'].map((id) => signIn(SUB, 'st', mcpCall(id))),
      signIn(SUB, 'st', mcpCall('e', 'other-server')),
      { id: 'toolConfirmation:sub', kind: 'toolConfirmation', chat: SUB, turnId: 'st', toolCall: { toolCallId: 'f', toolName: 'powershell', status: 'pending-confirmation' } },
    ],
  };
  const chatExtra = { activeTurn: { id: 't1', startedAt: new Date().toISOString(), message: msg('go'), responseParts: [{ kind: 'toolCall', toolCall: mcpCall('m') }] } };
  const { store, host } = setup({ unsubscribeDelayMs: 30 }, { protocolVersion: '1.1.0', sessionExtra, chatExtra });
  await until(() => store.sessionsLoaded);
  const stop = store.watchSession(SESSION);
  await until(() => store.chatState.get(CHAT) && store.sessionState.get(SESSION));
  assert.equal(store.skipSignIn(SESSION, 'github-mcp-server'), 5, 'the 4 in the sub-agent and the 1 in the chat');
  await until(() => dispatched(host).length === 5);
  const sent = dispatched(host);
  assert.deepEqual(sent.map((a) => `${a.channel === SUB ? 'sub' : 'chat'}:${a.turnId}:${a.toolCallId}`), ['sub:st:a', 'sub:st:b', 'sub:st:c', 'sub:st:d', 'chat:t1:m']);
  for (const a of sent) {
    assert.equal(a.type, 'chat/toolCallComplete');
    assert.equal(a.result.success, false, 'only a failed result is allowed from auth-required');
    assert.equal(a.result.error.code, 'cancelled');
    assert.equal(a.result.pastTenseMessage, 'Skipped Search repositories');
    assert.match(a.result.error.message, /continue without signing in to GitHub MCP Server/);
  }
  assert.throws(() => store.skipSignIn(SESSION, 'no-such-server'), /Nothing is waiting/);
  stop();
});
