// Which requests in a chat still hold the agent up: tool approvals, MCP sign-ins and questions.
// The PC reports them, but a PC can miss saying that one was dealt with (a sign-in completed some
// other way, say), which would leave "The agent is waiting for you" on screen while the agent
// carries on. So the latest signal wins: once the model writes or thinks again after a request, or
// a tool of the same MCP server runs again after a sign-in, that request is over.

const TOOL_ASKS = ['pending-confirmation', 'pending-result-confirmation', 'auth-required'];

/** Whether a response part asks the user for something. */
export function isAsk(part) {
  if (part?.kind === 'toolCall') return TOOL_ASKS.includes(part.toolCall?.status);
  return part?.kind === 'inputRequest' && !part.response;
}

/** The MCP server a tool call belongs to, if any. */
export function mcpServer(tc) {
  return tc?._meta?.mcpServerName || (tc?.contributor?.kind === 'mcp' ? tc.contributor.customizationId : null) || null;
}

/** The MCP server a sign-in is for, by the name people know it by ("GitHub MCP Server"). */
export function serverName(tc) {
  return tc?.auth?.resource?.resource_name || tc?._meta?.mcpServerName || String(mcpServer(tc) || '').split(':').pop() || tc?.displayName || tc?.toolName || 'an MCP server';
}

/** The server a waiting sign-in is for: one sign-in (or skipping it) lets every call waiting on it go on. */
export function signInKey(tc) {
  return mcpServer(tc) || serverName(tc);
}

const spoke = (p) => (p.kind === 'markdown' || p.kind === 'reasoning') && String(p.content || '').trim() !== '';

/** The requests in a turn that the agent is still waiting on. */
export function openAsks(turn) {
  const parts = turn?.responseParts || [];
  const open = [];
  let moved = false;
  const running = new Set();
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (isAsk(p) && !moved) {
      const server = p.toolCall?.status === 'auth-required' ? mcpServer(p.toolCall) : null;
      if (!server || !running.has(server)) open.unshift(p);
    }
    if (spoke(p)) moved = true;
    if (p.kind === 'toolCall' && p.toolCall?.status === 'running') {
      const server = mcpServer(p.toolCall);
      if (server) running.add(server);
    }
  }
  return open;
}

/** What a request is, for counting: a sign-in counts once per MCP server, however many calls wait on it. */
function askKey(chat, toolCall, id, signIn = toolCall?.status === 'auth-required') {
  return signIn ? `sign-in:${signInKey(toolCall)}` : `${chat}:${toolCall?.toolCallId ?? id}`;
}

/** The requests the PC reports that wait on the user (a client-run tool doesn't). */
const reportedAsks = (sessionState) => (sessionState?.inputNeeded || []).filter((r) => r.kind !== 'toolClientExecution');
const isSignIn = (r) => r.kind === 'toolAuthentication' || r.toolCall?.status === 'auth-required';

/**
 * How many requests a session is waiting on: the open ones in the chat this app follows, plus the
 * ones the PC reports for its other chats (sub-agents), which this app doesn't load.
 */
export function waitingOn(sessionState, chatUri, chatState) {
  const keys = new Set();
  for (const p of chatState ? openAsks(chatState.activeTurn) : []) keys.add(askKey(chatUri, p.toolCall, p.request?.id));
  for (const r of reportedAsks(sessionState)) {
    if (!chatState || r.chat !== chatUri) keys.add(askKey(r.chat, r.toolCall, r.request?.id ?? r.id, isSignIn(r)));
  }
  return keys.size;
}

/**
 * The requests of the session's sub-agents, as cards for the chat: each approval and question on its
 * own (with the sub-agent's chat, where the answer goes), and each MCP server's sign-in once, with the
 * calls waiting on it. A sign-in the open chat already shows isn't repeated.
 */
export function subagentAsks(sessionState, chatUri, chatState) {
  const shown = new Set(openAsks(chatState?.activeTurn).filter((p) => p.toolCall?.status === 'auth-required').map((p) => signInKey(p.toolCall)));
  const cards = [];
  const signIns = new Map();
  for (const r of reportedAsks(sessionState)) {
    if (r.chat === chatUri) continue;
    if (isSignIn(r)) {
      const key = signInKey(r.toolCall);
      if (shown.has(key)) continue;
      let card = signIns.get(key);
      if (!card) {
        card = { kind: 'signIn', key, server: serverName(r.toolCall), calls: [] };
        signIns.set(key, card);
        cards.push(card);
      }
      card.calls.push(r);
    } else if (r.kind === 'toolConfirmation' && r.toolCall) cards.push({ kind: 'tool', key: r.id, entry: r });
    else if (r.kind === 'chatInput' && r.request) cards.push({ kind: 'question', key: r.id, entry: r });
  }
  return cards;
}
