import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CopilotAgentHost, toAhpModels } from '../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib/agent-host.mjs';
import { SessionTranslator, schemaQuestions, toolLabels } from '../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib/translate.mjs';
import { rootReducer, sessionReducer, chatReducer, SUPPORTED_PROTOCOL_VERSIONS } from '../pwa/vendor/ahp/types/index.js';
import { HostStore } from '../pwa/js/model/host-store.js';

const require = createRequire(import.meta.url);
const agentHost = require('../extension/core/agentHost.js');

const CWD = path.join(os.tmpdir(), 'pp-copilot-test');
let clock = Date.parse('2026-09-28T10:00:00.000Z');
const ts = (s = 1) => new Date((clock += s * 1000)).toISOString();
let n = 0;
const ev = (type, data, extra = {}) => ({ type, data, id: `e${++n}`, timestamp: ts(), parentId: null, ...extra });

function history() {
  return [
    ev('session.start', { sessionId: 's1', selectedModel: 'gpt-5-mini' }),
    ev('user.message', { content: 'List the files', messageId: 'm1', interactionId: 'i1' }),
    ev('assistant.turn_start', { turnId: '0' }),
    ev('assistant.message', { messageId: 'a1', content: 'Listing the folder.', toolRequests: [{ toolCallId: 'c1', name: 'powershell', arguments: { command: 'Get-ChildItem', description: 'List files' }, intentionSummary: 'List files' }] }),
    ev('tool.execution_start', { toolCallId: 'c1', toolName: 'powershell', arguments: { command: 'Get-ChildItem' } }),
    ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'a.txt\nb.txt' } }),
    ev('assistant.turn_end', { turnId: '0' }),
    ev('assistant.message', { messageId: 'a2', content: 'There are **two** files.', toolRequests: [] }),
    ev('assistant.turn_end', { turnId: '1' }),
  ];
}

function fakeBridge(results = {}) {
  const calls = [];
  return {
    calls,
    request: async (op, params) => {
      calls.push({ op, params });
      const r = results[op];
      return typeof r === 'function' ? r(params) : r ?? true;
    },
  };
}

function fakeConnection(transport) {
  const conn = new EventTarget();
  conn.state = 'online';
  queueMicrotask(() => conn.dispatchEvent(new CustomEvent('ready', { detail: { transport } })));
  return conn;
}

async function until(fn, ms = 4000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeHost() {
  return new CopilotAgentHost({ reducers: { rootReducer, sessionReducer, chatReducer }, supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] });
}

test('translator: history becomes one completed AHP turn with markdown and a tool call', () => {
  const actions = [];
  const t = new SessionTranslator({ emit: (a) => actions.push(a) });
  t.replay(history());
  let chat = { resource: 'c', title: '', status: 1, modifiedAt: '', turns: [] };
  for (const a of actions) chat = chatReducer(chat, a);
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.activeTurn, undefined);
  const turn = chat.turns[0];
  assert.equal(turn.message.text, 'List the files');
  assert.equal(turn.message.model.id, 'gpt-5-mini');
  assert.deepEqual(turn.responseParts.map((p) => p.kind), ['markdown', 'toolCall', 'markdown']);
  const tc = turn.responseParts[1].toolCall;
  assert.equal(tc.status, 'completed');
  assert.equal(tc.displayName, 'Run Shell Command');
  assert.equal(tc.pastTenseMessage.markdown, 'Ran `Get-ChildItem`');
  assert.equal(tc.content[0].text, 'a.txt\nb.txt');
  assert.equal(turn.responseParts[2].content, 'There are **two** files.');
});

test('translator: helpers for labels, forms and phone answers', () => {
  assert.deepEqual(toolLabels('grep', { pattern: 'TODO' }), ['Searching for `TODO`', 'Searched for `TODO`']);
  assert.match(toolLabels('view', { path: path.join(CWD, 'src', 'app.ts') })[1], /^Read \[app\.ts\]\(file:\/\//);
  const qs = schemaQuestions({ type: 'object', properties: { env: { type: 'string', enum: ['dev', 'prod'], title: 'Environment' }, dry: { type: 'boolean', default: true } }, required: ['env'] });
  assert.deepEqual(qs.map((q) => [q.id, q.kind, q.required]), [['env', 'single-select', true], ['dry', 'boolean', false]]);
  assert.deepEqual(SessionTranslator.inputResolution({ kind: 'question', choices: ['Yes', 'No'] }, 'accept', { answer: { state: 'submitted', value: { kind: 'selected', value: 'No' } } }), { op: 'input', response: { answer: 'No', wasFreeform: false } });
  assert.deepEqual(SessionTranslator.inputResolution({ kind: 'plan' }, 'accept', { action: { state: 'submitted', value: { kind: 'selected', value: 'autopilot' } } }), { op: 'plan', response: { approved: true, selectedAction: 'autopilot' } });
  assert.deepEqual(SessionTranslator.permissionDecision(true, 'approve-session'), { kind: 'approve-for-session' });
  assert.deepEqual(toAhpModels([{ id: 'gpt-5-mini', name: 'GPT-5 mini', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', policy: { state: 'enabled' } }])[0].configSchema.properties.thinkingLevel.enum, ['low', 'high']);
});

test('copilot host: the phone lists, opens, chats, approves and answers through the real AHP client', async () => {
  const host = makeHost();
  const bridge = fakeBridge();
  host.setModels([{ id: 'gpt-5-mini', name: 'GPT-5 mini', policy: { state: 'enabled' } }]);
  host.attach({ sessionId: 's1', cwd: CWD, title: 'List the files', history: history(), bridge });
  const store = new HostStore(fakeConnection(agentHost.transportFor(host.openConnection())), { unsubscribeDelayMs: 10 });
  try {
    await until(() => store.sessionsLoaded);
    const [s] = store.sortedSessions();
    assert.equal(s.resource, 'copilotcli:/s1');
    assert.equal(s.title, 'List the files');
    assert.equal(s.project.displayName, 'pp-copilot-test');
    assert.deepEqual(store.models('copilotcli').map((m) => m.id), ['gpt-5-mini']);

    const release = store.watchSession(s.resource);
    const chat = await until(() => store.chatFor(s.resource) && store.chatState.get(store.chatFor(s.resource)) && store.chatFor(s.resource));
    assert.equal(store.chatState.get(chat).turns.length, 1);
    assert.equal(store.sessionState.get(s.resource).config.values.mode, 'interactive');

    // The phone sends a message: it shows up at once and reaches the session's process.
    assert.equal(store.sendMessage(s.resource, { text: 'Now delete b.txt' }), 'sent');
    await until(() => bridge.calls.some((c) => c.op === 'send'));
    assert.equal(bridge.calls.find((c) => c.op === 'send').params.prompt, 'Now delete b.txt');
    const turnId = await until(() => store.chatState.get(chat).activeTurn?.id);

    // The runtime runs it: streaming text, then a shell command that needs approval.
    host.event('s1', ev('user.message', { content: 'Now delete b.txt', messageId: 'm2' }));
    host.event('s1', ev('assistant.message_delta', { messageId: 'a3', deltaContent: 'Deleting ' }));
    host.event('s1', ev('assistant.message_delta', { messageId: 'a3', deltaContent: 'the file.' }));
    host.event('s1', ev('assistant.message', { messageId: 'a3', content: 'Deleting the file.', toolRequests: [{ toolCallId: 'c2', name: 'powershell', arguments: { command: 'Remove-Item b.txt' } }] }));
    host.event('s1', ev('permission.requested', { requestId: 'p1', permissionRequest: { kind: 'shell', toolCallId: 'c2', fullCommandText: 'Remove-Item b.txt', intention: 'Delete b.txt', canOfferSessionApproval: true } }));
    const pending = await until(() => store.chatState.get(chat).activeTurn?.responseParts.find((p) => p.kind === 'toolCall' && p.toolCall.status === 'pending-confirmation'));
    assert.equal(store.chatState.get(chat).activeTurn.id, turnId, 'runtime events join the phone turn');
    assert.equal(store.chatState.get(chat).activeTurn.responseParts[0].content, 'Deleting the file.');
    assert.equal(pending.toolCall.confirmationTitle, 'Run command?');
    assert.deepEqual(pending.toolCall.options.map((o) => o.id), ['approve-once', 'approve-session', 'reject']);
    await until(() => store.sessions.get(s.resource).status & 16);

    // Approve from the phone.
    store.confirmTool(chat, turnId, 'c2', true, 'approve-once');
    await until(() => bridge.calls.some((c) => c.op === 'permission'));
    assert.deepEqual(bridge.calls.find((c) => c.op === 'permission').params, { requestId: 'p1', decision: { kind: 'approve-once' } });
    await until(() => store.chatState.get(chat).activeTurn.responseParts.find((p) => p.toolCall?.toolCallId === 'c2')?.toolCall.status === 'running');
    host.event('s1', ev('permission.completed', { requestId: 'p1', result: { kind: 'approved' }, toolCallId: 'c2' }));
    host.event('s1', ev('tool.execution_start', { toolCallId: 'c2', toolName: 'powershell', arguments: { command: 'Remove-Item b.txt' } }));
    host.event('s1', ev('tool.execution_complete', { toolCallId: 'c2', success: true, result: { content: '' } }));

    // Then a question, answered from the phone.
    host.event('s1', ev('user_input.requested', { requestId: 'q1', question: 'Also delete a.txt?', choices: ['Yes', 'No'], allowFreeform: true }));
    const q = await until(() => store.chatState.get(chat).activeTurn.responseParts.find((p) => p.kind === 'inputRequest'));
    assert.equal(q.request.questions[0].kind, 'single-select');
    store.answerInput(chat, 'q1', 'accept', { answer: { state: 'submitted', value: { kind: 'selected', value: 'No' } } });
    await until(() => bridge.calls.some((c) => c.op === 'input'));
    assert.deepEqual(bridge.calls.find((c) => c.op === 'input').params, { requestId: 'q1', response: { answer: 'No', wasFreeform: false } });
    host.event('s1', ev('user_input.completed', { requestId: 'q1', answer: 'No', wasFreeform: false }));
    host.event('s1', ev('assistant.message', { messageId: 'a4', content: 'Done: b.txt is gone.' }));
    host.event('s1', ev('session.idle', {}, { ephemeral: true }));

    const done = await until(() => !store.chatState.get(chat).activeTurn && store.chatState.get(chat).turns.length === 2 && store.chatState.get(chat));
    const parts = done.turns[1].responseParts;
    assert.equal(parts.find((p) => p.toolCall?.toolCallId === 'c2').toolCall.status, 'completed');
    assert.equal(parts.find((p) => p.kind === 'inputRequest').response, 'accept');
    assert.equal(parts[parts.length - 1].content, 'Done: b.txt is gone.');
    await until(() => (store.sessions.get(s.resource).status & 31) === 1);
    assert.equal(store.sessions.get(s.resource).status & 32, 0, 'finished work marks the session unread');
    release();
  } finally {
    store.dispose();
    host.closeAll();
  }
});

test('copilot host: approvals answered on the PC reach the phone, and unsupported actions are rejected', async () => {
  const host = makeHost();
  const bridge = fakeBridge({ permission: false });
  host.attach({ sessionId: 's2', cwd: CWD, title: 'Build', history: [], bridge });
  const store = new HostStore(fakeConnection(agentHost.transportFor(host.openConnection())), { unsubscribeDelayMs: 10 });
  try {
    await until(() => store.sessionsLoaded);
    const uri = 'copilotcli:/s2';
    store.watchSession(uri);
    const chat = await until(() => store.chatFor(uri) && store.chatState.get(store.chatFor(uri)) && store.chatFor(uri));
    // A turn started on the PC.
    host.event('s2', ev('user.message', { content: 'npm run build', messageId: 'm9' }));
    host.event('s2', ev('permission.requested', { requestId: 'p9', permissionRequest: { kind: 'write', toolCallId: 'w1', fileName: path.join(CWD, 'x.js'), diff: '+hello', intention: 'Write x.js' } }));
    const turn = await until(() => store.chatState.get(chat).activeTurn);
    assert.equal(turn.message.text, 'npm run build');
    await until(() => turn.id && store.chatState.get(chat).activeTurn.responseParts.some((p) => p.toolCall?.status === 'pending-confirmation'));
    // The phone is too late: the PC already answered.
    store.confirmTool(chat, turn.id, 'w1', true, 'approve-once');
    await until(() => store.errors.length);
    assert.match(store.errors[0].message, /Already answered on your PC/);
    host.event('s2', ev('permission.completed', { requestId: 'p9', result: { kind: 'denied-interactively-by-user' } }));
    await until(() => store.chatState.get(chat).activeTurn.responseParts.find((p) => p.toolCall?.toolCallId === 'w1')?.toolCall.status === 'cancelled');
    host.event('s2', ev('session.idle', { aborted: false }, { ephemeral: true }));
    await until(() => !store.chatState.get(chat).activeTurn);
    // New sessions must be started on the PC.
    await assert.rejects(store.client.request('createSession', { channel: 'copilotcli:/new' }), /Start new sessions in the GitHub Copilot app/);
  } finally {
    store.dispose();
    host.closeAll();
  }
});

test('copilot host: after a hub failover the phone gets fresh snapshots, not a replay from another sequence', async () => {
  const bridge = fakeBridge();
  const host1 = makeHost();
  host1.attach({ sessionId: 's4', cwd: CWD, title: 'Failover', history: history(), bridge });
  let emitReady;
  const conn = new EventTarget();
  conn.state = 'online';
  emitReady = (transport) => conn.dispatchEvent(new CustomEvent('ready', { detail: { transport } }));
  const store = new HostStore(conn, { unsubscribeDelayMs: 10 });
  try {
    queueMicrotask(() => emitReady(agentHost.transportFor(host1.openConnection())));
    await until(() => store.sessionsLoaded);
    const uri = 'copilotcli:/s4';
    store.watchSession(uri);
    const chat = await until(() => store.chatFor(uri) && store.chatState.get(store.chatFor(uri)) && store.chatFor(uri));
    // Lots of activity on the first hub pushes the phone's sequence number up.
    for (let i = 0; i < 30; i++) host1.event('s4', ev('session.title_changed', { title: `t${i}` }, { ephemeral: true }));
    await until(() => store.sessions.get(uri)?.title === 't29');
    host1.closeAll();

    await new Promise((r) => setTimeout(r, 5));
    const host2 = makeHost();
    host2.attach({ sessionId: 's4', cwd: CWD, title: 'Failover', history: [...history(), ev('user.message', { content: 'two', messageId: 'm2' })], processing: true, bridge });
    emitReady(agentHost.transportFor(host2.openConnection()));
    const active = await until(() => store.chatState.get(chat)?.activeTurn?.message.text === 'two' && store.chatState.get(chat).activeTurn);
    assert.ok(active, 'the running turn from the new hub is visible');
    host2.closeAll();
  } finally {
    store.dispose();
  }
});

test('copilot host: queued phone messages keep their attachments', async () => {
  const host = makeHost();
  const bridge = fakeBridge();
  host.attach({ sessionId: 's5', cwd: CWD, title: 'Queue', history: [], bridge });
  const store = new HostStore(fakeConnection(agentHost.transportFor(host.openConnection())), { unsubscribeDelayMs: 10 });
  try {
    await until(() => store.sessionsLoaded);
    const uri = 'copilotcli:/s5';
    store.watchSession(uri);
    await until(() => store.chatFor(uri) && store.chatState.get(store.chatFor(uri)));
    host.event('s5', ev('user.message', { content: 'busy', messageId: 'm1' }));
    await until(() => store.chatState.get(store.chatFor(uri)).activeTurn);
    const attachments = [{ type: 'simple', label: 'shot.jpg', modelRepresentation: 'The user sent a file from their phone. It is saved on this machine at: C:\\x\\shot.jpg' }];
    assert.equal(store.sendMessage(uri, { text: 'look at this screenshot', attachments }), 'queued');
    await until(() => store.chatState.get(store.chatFor(uri)).queuedMessages?.length === 1);
    host.event('s5', ev('session.idle', {}, { ephemeral: true }));
    const send = await until(() => bridge.calls.find((c) => c.op === 'send'));
    assert.equal(send.params.prompt, 'look at this screenshot');
    assert.deepEqual(send.params.attachments, attachments);
    await until(() => !store.chatState.get(store.chatFor(uri)).queuedMessages?.length);
  } finally {
    store.dispose();
    host.closeAll();
  }
});

test('copilot host: reconnect replays missed actions; detach removes the session', async () => {
  const host = makeHost();
  host.attach({ sessionId: 's3', cwd: CWD, title: 'One', history: [], bridge: fakeBridge() });
  const client = new (await import('../pwa/vendor/ahp/client/index.js')).AhpClient(agentHost.transportFor(host.openConnection()));
  client.connect();
  const init = await client.initialize({ clientId: 'c1', protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], initialSubscriptions: ['ahp-root://'] });
  const seq = init.serverSeq;
  host.event('s3', ev('user.message', { content: 'hi' }));
  const second = new (await import('../pwa/vendor/ahp/client/index.js')).AhpClient(agentHost.transportFor(host.openConnection()));
  second.connect();
  const chatUri = [...host.sessions.values()][0].chatUri;
  const r = await second.reconnect({ clientId: 'c1', lastSeenServerSeq: seq, subscriptions: ['ahp-root://', chatUri, 'copilotcli:/gone'] });
  assert.equal(r.type, 'replay');
  assert.ok(r.actions.some((e) => e.action.type === 'chat/turnStarted' && e.channel === chatUri));
  assert.deepEqual(r.missing, ['copilotcli:/gone']);
  host.detach('s3');
  const { items } = await second.request('listSessions', { channel: 'ahp-root://' });
  assert.equal(items.length, 0);
  await client.shutdown().catch(() => {});
  await second.shutdown().catch(() => {});
  host.closeAll();
});
