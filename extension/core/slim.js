'use strict';
// Slims what the agent host sends on to the phone. A long chat can carry hundreds of megabytes of tool
// output (screenshots as base64, whole files read or written, thousands of tool calls) that the phone
// never shows: it displays at most 6,000 characters of a tool's output, never its binary data. Only
// finished tool calls are trimmed, since their content can't change anymore; in a very long chat the
// latest turns keep all the phone can show and older turns a preview. Answers and messages pass
// untouched, and small messages aren't looked at.

const SLIM_ABOVE = 1024 * 1024;
// Past this size, older turns keep a preview only.
const OLDER_ABOVE = 8 * 1024 * 1024;
const RECENT_TURNS = 10;
const DATA_MAX = 8 * 1024;
const STRUCTURED_MAX = 16 * 1024;
const MAX_DEPTH = 32;
const FINISHED = new Set(['completed', 'cancelled', 'pending-result-confirmation']);

// What a tool call keeps: its output text, its input (whole, and each string in it), any other string.
const RECENT = { text: 6000, input: 16 * 1024, inputString: 4 * 1024, other: 16 * 1024, reasoning: Infinity };
const OLDER = { text: 300, input: 1024, inputString: 200, other: 1024, reasoning: 4 * 1024 };

const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function cut(s, max) {
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${s.slice(0, end)}\n… (trimmed: ${sizeText(s.length - end)} more on your computer)`;
}

/** Cuts every string longer than `max` inside `v`, in place. Returns true if anything changed. */
function capStrings(v, max, depth = 0) {
  if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return false;
  let changed = false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (typeof x === 'string') {
      if (x.length > max) {
        v[k] = cut(x, max);
        changed = true;
      }
    } else if (x && typeof x === 'object' && capStrings(x, max, depth + 1)) changed = true;
  }
  return changed;
}

function slimInput(s, tier) {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object') {
      capStrings(v, tier.inputString);
      const out = JSON.stringify(v);
      if (out.length <= tier.input * 4) return out;
    }
  } catch {
    /* not JSON */
  }
  return cut(s, tier.input);
}

/** Trims the result fields of a finished tool call (or of a chat/toolCallComplete action), in place. */
function slimResult(r, tier) {
  let changed = false;
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.data === 'string' && item.data.length > DATA_MAX) {
        item.data = '';
        changed = true;
      }
      if (capStrings(item, tier.text)) changed = true;
    }
  }
  if (typeof r.toolInput === 'string' && r.toolInput.length > tier.input) {
    const input = slimInput(r.toolInput, tier);
    if (input !== r.toolInput) {
      r.toolInput = input;
      changed = true;
    }
  }
  if (r.structuredContent !== undefined && JSON.stringify(r.structuredContent).length > STRUCTURED_MAX) {
    delete r.structuredContent;
    changed = true;
  }
  for (const k of Object.keys(r)) {
    if (k === 'content' || k === 'toolInput') continue;
    const x = r[k];
    if (typeof x === 'string') {
      if (x.length > tier.other) {
        r[k] = cut(x, tier.other);
        changed = true;
      }
    } else if (x && typeof x === 'object' && capStrings(x, tier.other)) changed = true;
  }
  return changed;
}

function slimTurn(turn, tier) {
  let changed = false;
  for (const part of turn?.responseParts || []) {
    if (!part || typeof part !== 'object') continue;
    if (part.kind === 'toolCall') {
      const tc = part.toolCall;
      if (tc && typeof tc === 'object' && FINISHED.has(tc.status) && slimResult(tc, tier)) changed = true;
    } else if (part.kind === 'reasoning' && typeof part.content === 'string' && part.content.length > tier.reasoning) {
      part.content = cut(part.content, tier.reasoning);
      changed = true;
    }
  }
  return changed;
}

/** In a large message, older turns get a shorter preview; the last RECENT_TURNS keep all the phone shows. */
function slimTurns(turns, { large = false, allOlder = false } = {}) {
  let changed = false;
  if (!Array.isArray(turns)) return false;
  const recentFrom = !large ? 0 : allOlder ? turns.length : turns.length - RECENT_TURNS;
  for (let i = 0; i < turns.length; i++) if (slimTurn(turns[i], i < recentFrom ? OLDER : RECENT)) changed = true;
  return changed;
}

function slimChatState(state, large) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.turns)) return false;
  const a = slimTurns(state.turns, { large });
  const b = !!state.activeTurn && slimTurn(state.activeTurn, RECENT);
  return a || b;
}

function slimAction(action, large) {
  if (!action || typeof action !== 'object') return false;
  if (action.type === 'chat/toolCallComplete' && action.result && typeof action.result === 'object') return slimResult(action.result, RECENT);
  // Older turns paged in.
  if (action.type === 'chat/turnsLoaded') return slimTurns(action.turns, { large, allOlder: true });
  return false;
}

/**
 * The text to pass on to the phone for an agent host message: `text` itself, or the slimmed message.
 * `msg` is `JSON.parse(text)`; it is modified in place.
 */
function slimForPhone(msg, text) {
  if (text.length <= SLIM_ABOVE || !msg || typeof msg !== 'object') return text;
  const large = text.length > OLDER_ABOVE;
  let changed = false;
  const r = msg.result;
  if (r && typeof r === 'object') {
    if (r.snapshot && slimChatState(r.snapshot.state, large)) changed = true;
    if (Array.isArray(r.snapshots)) for (const s of r.snapshots) if (slimChatState(s?.state, large)) changed = true;
    if (Array.isArray(r.actions)) for (const env of r.actions) if (slimAction(env?.action, large)) changed = true;
    if (slimTurns(r.turns, { large, allOlder: true })) changed = true;
  }
  if (msg.method === 'action' && slimAction(msg.params?.action, large)) changed = true;
  return changed ? JSON.stringify(msg) : text;
}

module.exports = { slimForPhone, SLIM_ABOVE, OLDER_ABOVE, RECENT_TURNS };
