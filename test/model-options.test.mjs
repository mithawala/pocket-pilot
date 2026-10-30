// Model options as VS Code 1.144 lists them: the effort level twice (thinkingLevel, and a copy named
// reasoningEffort without a default), Auto's tier twice (tier, autoTier). The phone showed both, so
// the effort level appeared twice, and a choice in one could be overruled by the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDefaults, modelSummary, modelChip, optionsChip, hasOptions, chooseOption } from '../pwa/js/ui/model-picker.js';

// Copied from VS Code 1.144's agent host (root state, provider copilotcli).
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const effort = (def) => ({ type: 'string', title: 'Effort Level', description: 'Controls how much reasoning effort the model uses.', ...(def ? { default: def } : {}), enum: LEVELS, enumLabels: ['Low', 'Medium', 'High', 'Extra High', 'Max'], enumDescriptions: ['Faster responses with less reasoning', 'Balanced reasoning and speed', 'Greater reasoning depth but slower', 'Highest reasoning depth but slowest', 'Absolute maximum capability with no constraints'] });
const TIER = { type: 'string', title: 'Optimize for', enum: ['efficiency', 'balance', 'intelligence'], enumLabels: ['Efficiency', 'Balance', 'Intelligence'] };
const OPUS = {
  id: 'claude-opus-5.5', name: 'Claude Opus 5.5', provider: 'copilotcli',
  configSchema: { type: 'object', properties: {
    thinkingLevel: effort('medium'),
    contextSize: { type: 'number', title: 'Context Size', default: 1000000, enum: [200000, 1000000], enumLabels: ['200K', '1M'], enumDescriptions: ['Default', 'Longer sessions'] },
    reasoningEffort: effort(),
  } },
};
const AUTO = { id: 'auto', name: 'Auto', provider: 'copilotcli', configSchema: { type: 'object', properties: { tier: { ...TIER, default: 'balance' }, autoTier: TIER } } };
// VS Code 1.143 and the Copilot app plugin: no copies.
const OLD_OPUS = { ...OPUS, configSchema: { type: 'object', properties: { thinkingLevel: OPUS.configSchema.properties.thinkingLevel, contextSize: OPUS.configSchema.properties.contextSize } } };
const models = [OPUS, AUTO];

test('each option shows once: the effort level, the context size, Auto\'s tier', () => {
  assert.equal(optionsChip(models, { id: OPUS.id }), 'Medium 1M', 'not "Medium 1M Low" or a second effort level');
  assert.equal(optionsChip(models, { id: AUTO.id }), 'Balance');
  assert.equal(optionsChip([OLD_OPUS], { id: OPUS.id }), 'Medium 1M');
  assert.ok(hasOptions(models, { id: OPUS.id }));
});

test('the effort level shown is the one VS Code uses: thinkingLevel, else its copy', () => {
  // The state the phone left behind before: a stale "medium" (which VS Code uses) and "max" in the copy.
  assert.equal(optionsChip(models, { id: OPUS.id, config: { thinkingLevel: 'medium', contextSize: 1000000, reasoningEffort: 'max' } }), 'Medium 1M');
  // Set only under the new name (another client): VS Code uses it.
  assert.equal(optionsChip(models, { id: OPUS.id, config: { contextSize: 200000, reasoningEffort: 'max' } }), 'Max 200K');
  assert.equal(modelSummary(models, { id: OPUS.id, config: { reasoningEffort: 'xhigh' } }), 'Claude Opus 5.5 · Extra High');
  // A value the model doesn't offer is ignored.
  assert.equal(optionsChip(models, { id: OPUS.id, config: { thinkingLevel: 'ultra', reasoningEffort: 'high' } }), 'High 1M');
  assert.deepEqual(modelChip(models, { id: AUTO.id, config: { autoTier: 'intelligence' } }), { name: 'Auto', tag: 'Intelligence' });
});

test('picking a model sets each option under both names, keeping what the new model supports', () => {
  assert.deepEqual(modelDefaults(OPUS), { thinkingLevel: 'medium', reasoningEffort: 'medium', contextSize: 1000000 }, 'the copy gets the default, not its first choice ("low")');
  assert.deepEqual(modelDefaults(OPUS, { thinkingLevel: 'max', contextSize: 272000 }), { thinkingLevel: 'max', reasoningEffort: 'max', contextSize: 1000000 });
  assert.deepEqual(modelDefaults(OPUS, { reasoningEffort: 'high' }), { thinkingLevel: 'high', reasoningEffort: 'high', contextSize: 1000000 });
  assert.deepEqual(modelDefaults(AUTO, { thinkingLevel: 'max' }), { tier: 'balance', autoTier: 'balance' });
  assert.deepEqual(modelDefaults(OLD_OPUS, { thinkingLevel: 'xhigh' }), { thinkingLevel: 'xhigh', contextSize: 1000000 }, 'no copy where VS Code lists none');
});

test('two options that only look alike are both shown', () => {
  const m = { id: 'x', configSchema: { type: 'object', properties: {
    speed: { type: 'string', title: 'Level', enum: ['a', 'b'], default: 'a' },
    depth: { type: 'string', title: 'Level', enum: ['a', 'b', 'c'] },
    other: { type: 'string', title: 'Other', enum: ['a', 'b'] },
  } } };
  assert.equal(optionsChip([m], { id: 'x', config: { depth: 'c', other: 'b' } }), 'a c b');
});

/**
 * How VS Code 1.144 sends a model choice to apps that aren't VS Code (agentHostMain.js, QMe with an
 * unknown clientInfo): under the second names only.
 */
function asSentToPhone(sel) {
  const config = { ...sel.config };
  for (const [first, second] of [['thinkingLevel', 'reasoningEffort'], ['tier', 'autoTier']]) {
    if (Object.hasOwn(config, first)) {
      config[second] = config[first] ?? config[second] ?? config[first];
      delete config[first];
    }
  }
  return { ...sel, config };
}

test('a tapped effort level sticks after the round trip through VS Code (it came back as the default)', () => {
  // What VS Code sent the phone: Max, under reasoningEffort.
  let sel = asSentToPhone({ id: OPUS.id, config: { thinkingLevel: 'max', contextSize: 1000000 } });
  assert.deepEqual(sel.config, { reasoningEffort: 'max', contextSize: 1000000 });
  assert.equal(optionsChip(models, sel), 'Max 1M', 'was "Medium 1M Max": the first group fell back to the default');
  for (const level of ['low', 'high', 'max', 'medium']) {
    sel = asSentToPhone(chooseOption(models, sel, 'thinkingLevel', level));
    const label = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' }[level];
    assert.equal(optionsChip(models, sel), `${label} 1M`, `tapping ${label}`);
    assert.equal(sel.config.reasoningEffort, level, 'and that is what VS Code runs');
  }
  sel = asSentToPhone(chooseOption(models, sel, 'contextSize', 200000));
  assert.equal(optionsChip(models, sel), 'Medium 200K', 'another option leaves the effort level alone');
  let auto = asSentToPhone(chooseOption(models, { id: AUTO.id, config: modelDefaults(AUTO) }, 'tier', 'intelligence'));
  assert.deepEqual(auto.config, { autoTier: 'intelligence' });
  assert.equal(optionsChip(models, auto), 'Intelligence');
  auto = chooseOption(models, auto, 'autoTier', 'balance');
  assert.equal(auto.config.autoTier, 'intelligence', 'a copy is not an option of its own');
});
