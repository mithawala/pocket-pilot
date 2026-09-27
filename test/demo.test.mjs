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
    assert.equal(list.length, 5);
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
