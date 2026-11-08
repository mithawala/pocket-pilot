import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsks, waitingOn, isAsk, subagentAsks, serverName, signInKey } from '../pwa/js/lib/asks.js';
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

test('asks: a sign-in counts once per MCP server, however many calls and chats wait on it', () => {
  const chat = 'ahp-chat://main';
  const sub = 'ahp-chat://sub-agent';
  const gh = (id) => tool(id, 'auth-required', mcp('github-mcp-server')).toolCall;
  // As seen live: 4 searches in one sub-agent wait for the same sign-in.
  const session = { inputNeeded: ['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'toolAuthentication', chat: sub, turnId: 's', toolCall: gh(id) })) };
  const idle = { turns: [] };
  assert.equal(waitingOn(session, chat, idle), 1);
  assert.equal(waitingOn(session, chat, null), 1);
  const active = (parts) => ({ activeTurn: { id: 't', responseParts: parts } });
  assert.equal(waitingOn(session, chat, active([{ kind: 'toolCall', toolCall: gh('m') }, { kind: 'toolCall', toolCall: gh('n') }])), 1, 'the chat waits for the same sign-in');
  const more = { inputNeeded: [...session.inputNeeded, { id: 'q', kind: 'chatInput', chat: sub, request: { id: 'q1' } }, { id: 'x', kind: 'toolConfirmation', chat: sub, turnId: 's', toolCall: { toolCallId: 'x', status: 'pending-confirmation' } }] };
  assert.equal(waitingOn(more, chat, idle), 3, 'a sign-in, a question and an approval');
});

test('asks: the sub-agents\' requests become cards: each approval and question, and one sign-in per server', () => {
  const chat = 'ahp-chat://main';
  const sub = 'ahp-chat://sub-agent';
  const gh = (id) => tool(id, 'auth-required', mcp('github-mcp-server')).toolCall;
  const approval = { id: 'x', kind: 'toolConfirmation', chat: sub, turnId: 's', toolCall: { toolCallId: 'x', status: 'pending-confirmation' } };
  const question = { id: 'q', kind: 'chatInput', chat: sub, request: { id: 'q1' } };
  const session = { inputNeeded: [
    ...['a', 'b'].map((id) => ({ id, kind: 'toolAuthentication', chat: sub, turnId: 's', toolCall: gh(id) })),
    approval,
    question,
    { id: 'own', kind: 'toolConfirmation', chat, turnId: 't', toolCall: { toolCallId: 'own', status: 'pending-confirmation' } },
    { id: 'run', kind: 'toolClientExecution', chat: sub, turnId: 's', toolCall: { toolCallId: 'run', status: 'running' } },
  ] };
  const cards = subagentAsks(session, chat, { turns: [] });
  assert.deepEqual(cards.map((c) => c.kind), ['signIn', 'tool', 'question'], 'not the open chat\'s own request, nor a client-run tool');
  assert.equal(cards[0].key, 'github-mcp-server');
  assert.equal(cards[0].server, 'github-mcp-server');
  assert.deepEqual(cards[0].calls.map((r) => r.toolCall.toolCallId), ['a', 'b']);
  assert.equal(cards[1].entry, approval);
  assert.equal(cards[2].entry, question);
  // The chat shows that sign-in already (it waits for it too): not a second card.
  const shown = subagentAsks(session, chat, { activeTurn: { id: 't', responseParts: [{ kind: 'toolCall', toolCall: gh('m') }] } });
  assert.deepEqual(shown.map((c) => c.kind), ['tool', 'question']);
  assert.deepEqual(subagentAsks(undefined, chat, null), []);
  // The name people know the server by, when the sign-in says it.
  assert.equal(serverName({ ...gh('a'), auth: { resource: { resource_name: 'GitHub MCP Server' } } }), 'GitHub MCP Server');
  assert.equal(signInKey(gh('a')), 'github-mcp-server');
});
