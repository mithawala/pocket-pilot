import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo } from '../pwa/js/demo/demo.js';
import { modelDefaults, modelSummary } from '../pwa/js/ui/model-picker.js';

async function until(fn, ms = 15000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('demo: approving the pending tool call completes the turn through the real reducers', async () => {
  const { store } = createDemo();
  try {
    const list = store.sortedSessions();
    assert.equal(list.length, 6);
    assert.equal(list[0].resource, 'copilotcli:/demo-auth', '"Needs you" sorts first');
    const chat = store.chatFor('copilotcli:/demo-auth');
    const turn = store.chatState.get(chat).activeTurn;
    const pending = turn.responseParts.find((p) => p.kind === 'toolCall' && p.toolCall.status === 'pending-confirmation');
    assert.ok(pending, 'the demo starts with a pending approval');
    store.confirmTool(chat, turn.id, pending.toolCall.toolCallId, true, 'allow-once');
    const done = await until(() => {
      const cs = store.chatState.get(chat);
      return !cs.activeTurn && cs.turns.length === 1 && cs;
    });
    assert.match(JSON.stringify(done.turns[0].responseParts), /42 tests pass/);
    assert.equal(store.sessions.get('copilotcli:/demo-auth').status & 24, 0, 'no longer needs input or in progress');
  } finally {
    store.dispose();
  }
});

test('demo: answering the agent\'s question completes the turn with the chosen option', async () => {
  const { store } = createDemo();
  try {
    const chat = store.chatFor('copilotcli:/demo-dates');
    const part = store.chatState.get(chat).activeTurn.responseParts.find((p) => p.kind === 'inputRequest');
    assert.equal(part.request.questions[0].kind, 'single-select');
    store.answerInput(chat, part.request.id, 'accept', { lib: { state: 'submitted', value: { kind: 'selected', value: 'dayjs' } } });
    const done = await until(() => {
      const cs = store.chatState.get(chat);
      return !cs.activeTurn && cs.turns.length === 1 && cs;
    });
    const parts = done.turns[0].responseParts;
    assert.equal(parts.find((p) => p.kind === 'inputRequest').response, 'accept');
    assert.match(JSON.stringify(parts), /npm install dayjs/);
    assert.match(JSON.stringify(parts), /Going with \*\*Day\.js\*\*/);
  } finally {
    store.dispose();
  }
});

test('ui helpers: code languages and the composer model label', async () => {
  const { canonicalLanguage, rawLanguage } = await import('../pwa/js/lib/highlight.js');
  const { modelChip, optionsChip } = await import('../pwa/js/ui/model-picker.js');
  assert.equal(rawLanguage({ className: 'language-TS' }), 'ts');
  assert.equal(canonicalLanguage('ts'), 'typescript');
  assert.equal(canonicalLanguage('ps1'), 'powershell');
  assert.equal(canonicalLanguage('html'), 'xml');
  assert.equal(canonicalLanguage('brainfuck'), null);
  const { store } = createDemo();
  try {
    const models = store.models('copilotcli');
    assert.deepEqual(modelChip(models, { id: 'claude-opus-5.5', config: { thinkingLevel: 'xhigh', contextSize: 200000 } }), { name: 'Claude Opus 5.5', tag: 'Extra High 200K' });
    assert.equal(optionsChip(models, { id: 'claude-opus-5.5' }), 'High 1M', 'the model defaults when no option was chosen, like VS Code');
    assert.equal(optionsChip(models, { id: 'gpt-5-mini', config: { thinkingLevel: 'low' } }), 'Low');
    assert.deepEqual(modelChip(models, null), { name: 'Default model', tag: '' });
  } finally {
    store.dispose();
  }
});

test('demo: the model choice is the chat draft shared with the PC', async () => {
  const { store } = createDemo();
  try {
    const chat = store.chatFor('copilotcli:/demo-flaky');
    assert.equal(store.modelFor(chat).id, 'claude-opus-5.5', 'without a draft: the last turn\'s model');
    store.setModel(chat, { id: 'gpt-5.6-sol', config: { thinkingLevel: 'high', contextSize: 272000 } });
    assert.equal(store.chatState.get(chat).draft.model.id, 'gpt-5.6-sol');
    assert.equal(store.modelFor(chat).id, 'gpt-5.6-sol');
    // A change made on the PC (another client's draft) wins.
    store._apply({ channel: chat, action: { type: 'chat/draftChanged', draft: { text: 'typing on the PC', origin: { kind: 'user' }, model: { id: 'claude-sonnet-5' } } }, serverSeq: 999999, origin: { clientId: 'vscode', clientSeq: 1 } });
    assert.equal(store.modelFor(chat).id, 'claude-sonnet-5');
    // Picking on the phone keeps what the PC is typing.
    store.setModel(chat, { id: 'gpt-5-mini', config: { thinkingLevel: 'low' } });
    assert.equal(store.chatState.get(chat).draft.text, 'typing on the PC');
    assert.equal(store.chatState.get(chat).draft.model.id, 'gpt-5-mini');
  } finally {
    store.dispose();
  }
});

test('demo: steering reaches the running agent; stop and send restarts with the message', async () => {
  const { store } = createDemo();
  try {
    const uri = 'copilotcli:/demo-dark';
    const chat = store.chatFor(uri);
    store.steer(uri, { text: 'Use CSS variables' });
    await until(() => !store.chatState.get(chat).steeringMessage && JSON.stringify(store.chatState.get(chat).activeTurn?.responseParts || []).includes('Use CSS variables'));
    const sent = [];
    const dispatch = store._dispatch.bind(store);
    store._dispatch = (channel, action) => {
      sent.push(action);
      return dispatch(channel, action);
    };
    assert.equal(await store.stopAndSend(uri, { text: 'Actually, just add a comment' }), 'sent');
    const cs = await until(() => {
      const c = store.chatState.get(chat);
      return !c.activeTurn && c.turns.some((t) => t.message.text === 'Actually, just add a comment') && c;
    });
    assert.equal(cs.turns.find((t) => t.id === 'demo-dark-t1').state, 'cancelled', 'the running turn was stopped');
    assert.equal(cs.queuedMessages?.length || 0, 0);
    // Like VS Code: stop, then a new turn — never the queue (VS Code's host doesn't drain it after a stop).
    assert.deepEqual(sent.map((a) => a.type), ['chat/turnCancelled', 'chat/turnStarted']);
    assert.equal(sent[1].message.text, 'Actually, just add a comment');

    // If the PC never confirms the stop, the message still isn't lost: it waits in the queue.
    store.sendMessage(uri, { text: 'Another run' });
    await until(() => store.chatState.get(chat).activeTurn);
    sent.length = 0;
    store._dispatch = (channel, action) => {
      sent.push(action);
      return action.type === 'chat/turnCancelled' ? undefined : dispatch(channel, action);
    };
    assert.equal(await store.stopAndSend(uri, { text: 'Queued instead' }, { timeoutMs: 50 }), 'queued');
    assert.deepEqual(sent.map((a) => a.type), ['chat/turnCancelled', 'chat/pendingMessageSet']);
  } finally {
    store.dispose();
  }
});

test('demo: a queued message can be edited in place, sent immediately or removed, like VS Code', async () => {
  const { store } = createDemo();
  try {
    const uri = 'copilotcli:/demo-dark';
    const chat = store.chatFor(uri);
    assert.ok(store.chatState.get(chat).activeTurn, 'the agent is working');
    const long = `Please ${'also check the layout on narrow screens and '.repeat(8)}then commit.`;
    assert.equal(store.sendMessage(uri, { text: long, attachments: [{ type: 'simple', label: 'a.png' }] }), 'queued');
    store.sendMessage(uri, { text: 'Second' });
    const [first, second] = store.chatState.get(chat).queuedMessages;
    store.editPending(chat, 'queued', first.id, 'Shorter, please');
    let q = store.chatState.get(chat).queuedMessages;
    assert.deepEqual(q.map((m) => m.message.text), ['Shorter, please', 'Second'], 'edited where it was in the queue');
    assert.equal(q[0].id, first.id);
    assert.equal(q[0].message.attachments.length, 1, 'attachments stay');
    // Send Immediately: steers the running agent and leaves the queue.
    store.sendPendingNow(uri, chat, second.id);
    q = store.chatState.get(chat).queuedMessages;
    assert.deepEqual(q.map((m) => m.message.text), ['Shorter, please']);
    await until(() => JSON.stringify(store.chatState.get(chat).activeTurn?.responseParts || []).includes('Second'));
    // An emptied message is removed; one the agent already took can't be edited.
    store.editPending(chat, 'queued', first.id, '   ');
    assert.equal(store.chatState.get(chat).queuedMessages?.length || 0, 0);
    assert.throws(() => store.editPending(chat, 'queued', first.id, 'late'), /already sent/);
  } finally {
    store.dispose();
  }
});

test('status: a working session shows as working even when an old sub-agent failed', async () => {
  const { effectiveStatus, S } = await import('../pwa/js/lib/format.js');
  const { createRequire } = await import('node:module');
  const monitor = createRequire(import.meta.url)('../extension/core/monitor.js');
  const cases = [
    [32 | 2, { defaultChat: 'a', chats: [{ resource: 'a', status: 8 }, { resource: 'b', status: 2 }] }],
    [2, { defaultChat: 'a', chats: [{ resource: 'a', status: 1 }, { resource: 'b', status: 16 }] }],
    [2, { defaultChat: 'a', chats: [{ resource: 'a', status: 2 }] }],
    [2 | 64, { chats: [{ resource: 'x', status: 1, modifiedAt: '2026-01-02' }, { resource: 'y', status: 2, modifiedAt: '2026-01-01' }] }],
    [2, undefined],
  ];
  for (const [raw, state] of cases) assert.equal(effectiveStatus(raw, state), monitor.effectiveStatus(raw, state), 'the app and the extension agree');
  assert.equal(effectiveStatus(34, cases[0][1]), 32 | S.InProgress);

  const { store } = createDemo();
  try {
    const uri = 'copilotcli:/demo-dark';
    const raw = store.sessions.get(uri);
    // What an older extension sends for this session while its main chat works.
    store.sessions.set(uri, { ...raw, status: (raw.status & ~31) | S.Error });
    store.sessionState.set(uri, { ...store.sessionState.get(uri), defaultChat: 'c1', chats: [{ resource: 'c1', status: S.InProgress }, { resource: 'c2', status: S.Error }] });
    assert.equal(store.statusFor(store.sessions.get(uri)) & 31, S.InProgress);
    assert.equal(store.sortedSessions().find((s) => s.resource === uri).status & 31, S.InProgress);
    store.sessionState.delete(uri);
    assert.equal(store.statusFor(store.sessions.get(uri)) & 31, S.Error, 'without the state there is nothing to correct with');
  } finally {
    store.dispose();
  }
});

test('sessions: folder grouping follows the project; folders that need you or are working come first', async () => {
  const { folderGroups, projectOf } = await import('../pwa/js/ui/sessions.js');
  const { store } = createDemo();
  try {
    const groups = folderGroups(store.sortedSessions());
    assert.deepEqual(groups.map((g) => g.name), ['acme-web', 'acme-api', 'infra']);
    const web = groups[0];
    assert.deepEqual(web.items.map((s) => s.resource), ['copilotcli:/demo-dates', 'copilotcli:/demo-dark', 'copilotcli:/demo-flaky', 'copilotcli:/demo-notes'], 'needs input, then working, then newest');
    assert.equal(web.needs, 1);
    assert.equal(web.running, 1);
    assert.equal(groups[1].needs, 1);
    assert.equal(store.sessions.get('copilotcli:/demo-flaky').changes.additions, 18);
  } finally {
    store.dispose();
  }
  const at = (m) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
  const s = (id, dir, status, m) => ({ resource: `copilotcli:/${id}`, provider: 'copilotcli', status, modifiedAt: at(m), workingDirectories: [`file:///c%3A/code/${dir}`] });
  const order = folderGroups([s('a', 'old-but-busy', 8, 1), s('b', 'recent', 1, 50), s('c', 'waiting', 16, 2)]).map((g) => g.name);
  assert.deepEqual(order, ['waiting', 'old-but-busy', 'recent']);
  assert.equal(projectOf({ provider: 'copilotcli', workingDirectories: ['file:///c%3A/code/My%20App'] }).name, 'My App');
  assert.equal(projectOf({ provider: 'copilotcli', project: { uri: 'file:///c%3A/code/app', displayName: 'app (main)' }, workingDirectories: [] }).name, 'app (main)');
  assert.deepEqual(projectOf({ provider: 'claude' }), { key: 'provider:claude', uri: '', name: 'Claude' });
});

test('ui modules all parse (catches syntax errors in components the other tests do not render)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pwa', 'js');
  for (const sub of ['ui', 'lib', 'model', 'net', 'demo', 'core']) {
    for (const f of fs.readdirSync(path.join(dir, sub)).filter((x) => x.endsWith('.js'))) {
      assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(dir, sub, f)], { stdio: 'pipe' }), `${sub}/${f}`);
    }
  }
});

test('demo: new sessions keep the chosen model options and mode', async () => {
  const { store } = createDemo();
  try {
    const models = store.models('copilotcli');
    const sol = models.find((m) => m.id === 'gpt-5.6-sol');
    // Carries over options the new model supports, falls back to its defaults otherwise.
    const model = { id: sol.id, config: modelDefaults(sol, { thinkingLevel: 'max', contextSize: 1000000 }) };
    assert.deepEqual(model.config, { thinkingLevel: 'max', contextSize: 272000 });
    assert.equal(modelSummary(models, model), 'GPT-5.6 Sol · Max · 272K');

    const uri = await store.createSession({ provider: 'copilotcli', folder: 'file:///c%3A/Users/you/code/acme-web', text: 'Add a health check', model, config: { mode: 'plan', autoApprove: 'default' } });
    assert.equal(store.sessionState.get(uri).config.values.mode, 'plan');
    const chat = store.chatFor(uri);
    const cs = await until(() => {
      const c = store.chatState.get(chat);
      return !c.activeTurn && c.turns.length === 1 && c;
    });
    assert.deepEqual(cs.turns[0].message.model, model);
  } finally {
    store.dispose();
  }
});
