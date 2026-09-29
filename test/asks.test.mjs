import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsks, waitingOn, isAsk } from '../pwa/js/lib/asks.js';
import { createDemo } from '../pwa/js/demo/demo.js';
import { S } from '../pwa/js/lib/format.js';

const tool = (id, status, extra = {}) => ({ kind: 'toolCall', toolCall: { toolCallId: id, toolName: id, status, ...extra } });
const md = (content) => ({ kind: 'markdown', content });
const think = (content) => ({ kind: 'reasoning', content });
const mcp = (server) => ({ contributor: { kind: 'mcp', customizationId: `mcp-top-level:copilotcli:x:${server}` }, _meta: { mcpServerName: server } });

test('asks: a sign-in stays open until the agent moves on', () => {
  // As seen live: an MCP tool waits for a sign-in on the PC and nothing comes after it.
  const signIn = tool('github-mcp-server-actions_list', 'auth-required', mcp('github-mcp-server'));
  const parts = [md('Pushed. Let me check CI.'), tool('tool_search_tool', 'completed'), signIn];
  assert.deepEqual(openAsks({ responseParts: parts }), [signIn]);
  // The PC never said the sign-in was done, but the model thought or wrote again: the latest signal wins.
  assert.deepEqual(openAsks({ responseParts: [...parts, think('CI is green, so')] }), []);
  assert.deepEqual(openAsks({ responseParts: [...parts, md('All checks pass.')] }), []);
  // A tool of the same MCP server running again means the sign-in went through; another server's doesn't.
  assert.deepEqual(openAsks({ responseParts: [...parts, tool('github-mcp-server-actions_get', 'running', mcp('github-mcp-server'))] }), []);
  assert.deepEqual(openAsks({ responseParts: [...parts, tool('other', 'running', mcp('other-server'))] }), [signIn]);
  assert.deepEqual(openAsks({ responseParts: [...parts, md('   ')] }), [signIn], 'empty text is no signal');
});

test('asks: an approval stays open while parallel tool calls around it run', () => {
  const approve = tool('edit', 'pending-confirmation');
  assert.deepEqual(openAsks({ responseParts: [md('Editing and searching.'), tool('view', 'completed'), approve, tool('grep', 'running'), tool('powershell', 'completed')] }), [approve]);
  const question = { kind: 'inputRequest', request: { id: 'q' } };
  assert.deepEqual(openAsks({ responseParts: [question] }), [question]);
  assert.deepEqual(openAsks({ responseParts: [{ ...question, response: 'accept' }] }), []);
  assert.deepEqual(openAsks(undefined), []);
  assert.equal(isAsk(tool('x', 'pending-result-confirmation')), true);
  assert.equal(isAsk(tool('x', 'completed')), false);
});

test('asks: a session waits on what is open in its chat, and on what the PC reports for other chats', () => {
  const chat = 'ahp-chat://main';
  const signIn = tool('actions_list', 'auth-required', mcp('github-mcp-server'));
  const session = { inputNeeded: [{ id: '1', kind: 'toolAuthentication', chat, turnId: 't', toolCall: signIn.toolCall }] };
  const active = (parts) => ({ activeTurn: { id: 't', responseParts: parts } });
  assert.equal(waitingOn(session, chat, active([signIn])), 1);
  assert.equal(waitingOn(session, chat, active([signIn, md('Done.')])), 0, 'the PC still lists it, but the chat has moved on');
  assert.equal(waitingOn(session, chat, { turns: [] }), 0, 'no active turn, nothing to wait on');
  assert.equal(waitingOn(session, chat, null), 1, 'without the chat, trust the PC');
  const more = { inputNeeded: [...session.inputNeeded, { id: '2', kind: 'toolConfirmation', chat: 'ahp-chat://sub-agent' }, { id: '3', kind: 'toolClientExecution', chat }] };
  assert.equal(waitingOn(more, chat, active([signIn, md('Done.')])), 1, 'a sub-agent still waits; a client-run tool is not waiting on you');
});

test('asks: "needs you" in the list and header follows the chat the app shows', () => {
  const { store } = createDemo();
  try {
    const uri = 'copilotcli:/demo-auth';
    const summary = store.sessions.get(uri);
    assert.ok(store.statusFor(summary) & S.Input, 'the demo approval is open');
    const chat = store.chatFor(uri);
    const cs = store.chatState.get(chat);
    store.chatState.set(chat, { ...cs, activeTurn: { ...cs.activeTurn, responseParts: [...cs.activeTurn.responseParts, md('Tests pass.')] } });
    assert.equal(store.statusFor(summary) & 31, S.InProgress, 'the agent moved on: working, not waiting');
    assert.equal(store.sortedSessions().find((s) => s.resource === uri).status & 31, S.InProgress);
    store.chatState.set(chat, { ...cs, activeTurn: undefined });
    assert.equal(store.statusFor(summary) & 31, S.Idle);
    store.chatState.delete(chat);
    assert.ok(store.statusFor(summary) & S.Input, 'without the chat, the PC decides');
  } finally {
    store.dispose();
  }
});
