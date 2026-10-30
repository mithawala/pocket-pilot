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

/**
 * How many requests a session is waiting on: the open ones in the chat this app follows, plus the
 * ones the PC reports for its other chats (sub-agents), which this app doesn't load.
 */
export function waitingOn(sessionState, chatUri, chatState) {
  const reported = (sessionState?.inputNeeded || []).filter((r) => r.kind !== 'toolClientExecution');
  if (!chatState) return reported.length;
  return openAsks(chatState.activeTurn).length + reported.filter((r) => r.chat !== chatUri).length;
}
