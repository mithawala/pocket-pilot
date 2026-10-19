import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { slimForPhone, SLIM_ABOVE, OLDER_ABOVE, RECENT_TURNS } = require('../extension/core/slim.js');

const NOTE = /\n… \(trimmed: \d+(?:\.\d)? [KM]B more on your computer\)$/;
const tool = (id, status, { text = 'ok', data, input = { command: 'npm test' }, ...extra } = {}) => ({
  kind: 'toolCall',
  toolCall: { status, toolCallId: id, toolName: 'run', displayName: 'Run', invocationMessage: 'Run `npm test`', pastTenseMessage: 'Ran `npm test`', toolInput: typeof input === 'string' ? input : JSON.stringify(input), content: [{ type: 'text', text }, ...(data ? [{ type: 'embeddedResource', data, contentType: 'image/png' }] : [])], ...extra },
});
const turn = (i, parts, extra = {}) => ({ id: `t${i}`, message: { text: `message ${i}` }, responseParts: parts, state: 'complete', ...extra });
const reply = (state) => {
  const msg = { jsonrpc: '2.0', id: 9, result: { snapshot: { resource: 'ahp-chat://default/c', fromSeq: 5, state } } };
  return slimForPhone(msg, JSON.stringify(msg));
};
const stateOf = (text) => JSON.parse(text).result.snapshot.state;
const padding = (n) => ({ kind: 'markdown', id: 'pad', content: 'p'.repeat(n) });

test('small messages pass through untouched', () => {
  const msg = { jsonrpc: '2.0', id: 1, result: { snapshot: { state: { turns: [turn(0, [tool('a', 'completed', { text: 'x'.repeat(50000) })])] } } } };
  const text = JSON.stringify(msg);
  assert.ok(text.length < SLIM_ABOVE);
  assert.equal(slimForPhone(msg, text), text);
});

test('finished tool calls lose what the phone never shows; everything else stays', () => {
  const screenshot = 'iVBOR'.repeat(40000);
  const longInput = { path: 'src/app.ts', file_text: 'const a = 1;\n'.repeat(5000) };
  const attachment = { type: 'embeddedResource', label: 'photo.jpg', data: 'A'.repeat(300000), contentType: 'image/jpeg' };
  const state = {
    turns: [
      turn(0, [
        { kind: 'markdown', id: 'm', content: 'An answer '.repeat(30000) },
        { kind: 'reasoning', id: 'r', content: 'thinking '.repeat(20000) },
        tool('done', 'completed', { text: 'out\n'.repeat(100000), data: screenshot, input: longInput, structuredContent: { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) }, edits: { items: [{ uri: 'file:///a', after: 'z'.repeat(100000) }] } }),
        tool('small', 'completed', { data: 'iVBORsmall' }),
        tool('skipped', 'cancelled', { text: 'c'.repeat(100000) }),
      ], { message: { text: 'look at this', attachments: [attachment] } }),
    ],
    activeTurn: turn(1, [tool('live', 'running', { text: 'r'.repeat(200000) }), tool('ask', 'pending-confirmation', { input: longInput })]),
  };
  const before = structuredClone(state);
  const out = reply(state);
  const st = stateOf(out);
  const [md, reasoning, done, small, skipped] = st.turns[0].responseParts;
  assert.equal(md.content, before.turns[0].responseParts[0].content, 'answers are never trimmed');
  assert.equal(reasoning.content, before.turns[0].responseParts[1].content, 'reasoning stays in a chat this size');
  assert.deepEqual(st.turns[0].message, before.turns[0].message, 'your messages and their pictures stay');
  const tc = done.toolCall;
  assert.ok(tc.content[0].text.length < 6100 && NOTE.test(tc.content[0].text), 'output keeps what the phone shows (6,000 characters)');
  assert.ok(tc.content[0].text.startsWith('out\nout\n'));
  assert.equal(tc.content[1].data, '', 'screenshots are dropped');
  assert.equal(tc.content[1].contentType, 'image/png');
  const input = JSON.parse(tc.toolInput);
  assert.equal(input.path, 'src/app.ts', 'the input stays JSON with its short values');
  assert.ok(input.file_text.length < 4200 && NOTE.test(input.file_text));
  assert.equal(tc.structuredContent, undefined);
  assert.ok(tc.edits.items[0].after.length < 16500);
  assert.equal(tc.pastTenseMessage, 'Ran `npm test`');
  assert.equal(small.toolCall.content[1].data, 'iVBORsmall', 'small data stays');
  assert.ok(skipped.toolCall.content[0].text.length < 6100);
  assert.deepEqual(st.activeTurn, before.activeTurn, 'running tool calls and approvals are left alone');
  assert.ok(out.length < JSON.stringify(before).length - 700000, 'the tool output bulk is gone');
});

test(`in a very long chat, turns before the last ${RECENT_TURNS} keep a preview of each tool call`, () => {
  const turns = Array.from({ length: 30 }, (_, i) => turn(i, [
    { kind: 'markdown', id: `m${i}`, content: `answer ${i}` },
    { kind: 'reasoning', id: `r${i}`, content: 'why '.repeat(5000) },
    tool(`c${i}`, 'completed', { text: 'o'.repeat(20000), input: { command: 'echo', note: 'n'.repeat(3000) } }),
  ]));
  turns.push(turn(30, [padding(OLDER_ABOVE)]));
  const st = stateOf(reply({ turns }));
  const recentFrom = turns.length - RECENT_TURNS;
  st.turns.slice(0, 30).forEach((t, i) => {
    const [md, reasoning, call] = t.responseParts;
    const older = i < recentFrom;
    assert.equal(md.content, `answer ${i}`);
    assert.ok(call.toolCall.content[0].text.length < (older ? 400 : 6100), `turn ${i}`);
    assert.equal(reasoning.content.length > 5000, !older, `turn ${i} reasoning`);
    assert.equal(JSON.parse(call.toolCall.toolInput).command, 'echo');
    assert.ok(JSON.parse(call.toolCall.toolInput).note.length < (older ? 300 : 3001));
    assert.equal(call.toolCall.toolCallId, `c${i}`);
  });
});

test('live tool results, paged-in turns, reconnect replays and initial snapshots are slimmed too', () => {
  const makeAction = () => ({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat://c', serverSeq: 3, action: { type: 'chat/toolCallComplete', turnId: 't', toolCallId: 'x', result: { success: true, pastTenseMessage: 'Took a screenshot', content: [{ type: 'embeddedResource', data: 'B'.repeat(2e6), contentType: 'image/png' }] } } } });
  const action = makeAction();
  const slimAction = JSON.parse(slimForPhone(action, JSON.stringify(action)));
  assert.equal(slimAction.params.action.result.content[0].data, '');
  assert.equal(slimAction.params.action.result.pastTenseMessage, 'Took a screenshot');

  const older = Array.from({ length: 3 }, (_, i) => turn(i, [tool(`p${i}`, 'completed', { text: 'q'.repeat(3e6) })]));
  const loaded = { jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat://c', serverSeq: 4, action: { type: 'chat/turnsLoaded', turns: older } } };
  const paged = JSON.parse(slimForPhone(loaded, JSON.stringify(loaded))).params.action.turns;
  for (const t of paged) assert.ok(t.responseParts[0].toolCall.content[0].text.length < 400, 'older turns paged into a large message get the preview');

  const replay = { jsonrpc: '2.0', id: 2, result: { type: 'replay', actions: [makeAction().params] } };
  const replayText = JSON.stringify(replay);
  assert.ok(replayText.length > SLIM_ABOVE);
  assert.equal(JSON.parse(slimForPhone(replay, replayText)).result.actions[0].action.result.content[0].data, '');

  const chat = { turns: [turn(0, [tool('i', 'completed', { data: 'C'.repeat(2e6) })])] };
  const init = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '1.0.0', snapshots: [{ resource: 'ahp-root://', state: { agents: [{ provider: 'copilotcli', description: 'd'.repeat(10) }] } }, { resource: 'ahp-chat://c', state: chat }] } };
  const slimInit = JSON.parse(slimForPhone(init, JSON.stringify(init)));
  assert.deepEqual(slimInit.result.snapshots[0], init.result.snapshots[0], 'non-chat snapshots are untouched');
  assert.equal(slimInit.result.snapshots[1].state.turns[0].responseParts[0].toolCall.content[1].data, '');
});

test('a tool input that is not JSON is cut as text', () => {
  const st = stateOf(reply({ turns: [turn(0, [tool('t', 'completed', { input: `not json ${'x'.repeat(40000)}` })]), turn(1, [padding(SLIM_ABOVE)])] }));
  const input = st.turns[0].responseParts[0].toolCall.toolInput;
  assert.ok(input.startsWith('not json xxx') && NOTE.test(input) && input.length < 16500);
});
