// Translates GitHub Copilot SDK session events (the Copilot app and CLI runtime) into Agent Host
// Protocol chat actions, so the Pocket Pilot phone app renders these sessions exactly like the ones
// VS Code hosts. Pure logic: no I/O, driven by `replay()` (history) and `handle()` (live events).
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MAX_TEXT = 6000;
/** Tools that are implementation details of the agent loop (their effect is shown another way). */
export const HIDDEN_TOOLS = new Set(['report_intent', 'ask_user', 'exit_plan_mode', 'update_todo', 'think']);

const KIND = {
  powershell: 'terminal', bash: 'terminal', shell: 'terminal', write_powershell: 'terminal', read_powershell: 'terminal', stop_powershell: 'terminal',
  write_bash: 'terminal', read_bash: 'terminal', stop_bash: 'terminal', list_powershell: 'terminal', list_bash: 'terminal',
  view: 'read', read: 'read', read_file: 'read', show_file: 'read',
  edit: 'edit', str_replace: 'edit', str_replace_editor: 'edit', apply_patch: 'edit', insert: 'edit', multi_edit: 'edit',
  create: 'create', write_file: 'create',
  grep: 'search', glob: 'search', rg: 'search', search: 'search', web_search: 'search', search_code: 'search',
  web_fetch: 'fetch', fetch: 'fetch', fetch_copilot_cli_documentation: 'fetch',
  task: 'subagent', agent: 'subagent', read_agent: 'subagent', write_agent: 'subagent',
};
const DISPLAY = {
  terminal: 'Run Shell Command', read: 'Read', edit: 'Edit File', create: 'Create File', search: 'Search', fetch: 'Fetch', subagent: 'Agent',
};

export const PLAN_ACTIONS = {
  interactive: 'Approve and start working',
  autopilot: 'Approve and work autonomously (autopilot)',
  autopilot_fleet: 'Approve and run with parallel agents',
  exit_only: 'Approve the plan only',
};

const md = (markdown) => ({ markdown });
const clip = (s, n = MAX_TEXT) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}\n… (truncated)` : t;
};
const tail = (s, n = 3000) => {
  const t = String(s ?? '');
  return t.length > n ? `…${t.slice(-n)}` : t;
};
const oneLine = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/`/g, "'");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const same = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();

export function fileUri(p) {
  try {
    return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) ? pathToFileURL(p).href : null;
  } catch {
    return null;
  }
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif' };
/** Inline pictures up to this size (base64) travel with the chat; bigger ones show as a chip. */
const MAX_INLINE_PICTURE = 4 * 1024 * 1024;

export function imageTypeOf(file) {
  return IMAGE_TYPES[String(file || '').split('.').pop().toLowerCase()] || '';
}

/** How a local path is compared (Windows paths ignore case). */
export function fileKey(p) {
  const abs = path.resolve(String(p));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * The runtime's message attachments as Agent Host Protocol attachments: files (pasted pictures among
 * them) by URI, pictures sent inline as they are, and the rest (folders, selections) as labels.
 * `onFile(path)` hears about every attached file, which the phone may then read.
 */
export function messageAttachments(list, onFile) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    const label = String(a.displayName || a.title || (a.path ? path.basename(a.path) : '') || 'Attachment');
    if (a.type === 'file' && a.path) {
      const uri = fileUri(a.path);
      if (!uri) continue;
      onFile?.(a.path);
      const type = /^image\//.test(a.mimeType || '') ? a.mimeType : imageTypeOf(a.path);
      out.push({ type: 'resource', uri, label, ...(type ? { displayKind: 'image', _meta: { contentType: type } } : {}) });
    } else if (a.type === 'blob' && /^image\//.test(a.mimeType || '') && typeof a.data === 'string' && a.data.length <= MAX_INLINE_PICTURE) {
      out.push({ type: 'embeddedResource', label: a.displayName || 'Pasted image', data: a.data, contentType: a.mimeType, displayKind: 'image' });
    } else if (a.type === 'blob' || a.type === 'directory' || a.type === 'selection' || a.type === 'file') {
      out.push({ type: 'simple', label, ...(a.type === 'blob' && /^image\//.test(a.mimeType || '') ? { displayKind: 'image' } : {}) });
    }
  }
  return out;
}

function fileLink(p) {
  const name = String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const uri = fileUri(p);
  return uri ? `[${name.replace(/[[\]]/g, '')}](${uri})` : `\`${oneLine(p)}\``;
}

export function toolKind(name) {
  return KIND[name] || (/(^|_)(bash|powershell|shell)$/.test(name) ? 'terminal' : 'tool');
}

function prettyName(name) {
  return String(name || 'tool').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The progress and past-tense lines VS Code shows for a tool call. */
export function toolLabels(name, args, title) {
  const a = args && typeof args === 'object' ? args : {};
  const kind = toolKind(name);
  const p = a.path || a.file_path || a.filePath || a.filename;
  const what = title || prettyName(name);
  if (kind === 'terminal' && typeof a.command === 'string') return [`Running \`${oneLine(a.command)}\``, `Ran \`${oneLine(a.command)}\``];
  if (kind === 'read' && p) return [`Reading ${fileLink(p)}`, `Read ${fileLink(p)}`];
  if (kind === 'edit' && p) return [`Editing ${fileLink(p)}`, `Edited ${fileLink(p)}`];
  if (kind === 'create' && p) return [`Creating ${fileLink(p)}`, `Created ${fileLink(p)}`];
  if (kind === 'search') {
    const q = a.pattern || a.query || a.glob || a.q;
    if (q) return [`Searching for \`${oneLine(q, 60)}\``, `Searched for \`${oneLine(q, 60)}\``];
  }
  if (kind === 'fetch' && a.url) return [`Fetching ${oneLine(a.url, 100)}`, `Fetched ${oneLine(a.url, 100)}`];
  if (kind === 'subagent' && (a.description || a.name)) return [`Running agent: ${oneLine(a.description || a.name, 80)}`, `Agent: ${oneLine(a.description || a.name, 80)}`];
  return [`Running ${what}`, `Ran ${what}`];
}

function toolInputOf(args) {
  if (args === undefined || args === null) return undefined;
  return clip(typeof args === 'string' ? args : JSON.stringify(args));
}

/** Confirmation prompt for a Copilot permission request, VS Code style. */
export function permissionPrompt(pr = {}) {
  const intention = pr.intention ? oneLine(pr.intention, 200) : '';
  switch (pr.kind) {
    case 'shell':
      return { title: 'Run command?', message: intention || `Run \`${oneLine(pr.fullCommandText, 120)}\``, input: JSON.stringify({ command: pr.fullCommandText, ...(intention ? { description: intention } : {}) }), warning: pr.warning };
    case 'write':
      return { title: pr.newFileContents !== undefined && !pr.diff ? 'Create file?' : 'Edit file?', message: `${intention ? `${intention} — ` : ''}${fileLink(pr.fileName)}`, input: pr.diff ? clip(pr.diff) : JSON.stringify({ path: pr.fileName }) };
    case 'read':
      return { title: 'Read file?', message: `${intention ? `${intention} — ` : ''}${fileLink(pr.path)}`, input: JSON.stringify({ path: pr.path }) };
    case 'url':
      return { title: 'Open URL?', message: `${intention ? `${intention} — ` : ''}${oneLine(pr.url, 160)}`, input: JSON.stringify({ url: pr.url }) };
    case 'mcp':
      return { title: `Run ${pr.toolTitle || pr.toolName}?`, message: `${pr.toolTitle || pr.toolName} (MCP server **${pr.serverName}**)`, input: toolInputOf(pr.args) };
    case 'custom-tool':
      return { title: `Run ${pr.toolName}?`, message: oneLine(pr.toolDescription || pr.toolName, 200), input: toolInputOf(pr.args) };
    case 'memory':
      return { title: 'Save to memory?', message: intention || 'The agent wants to remember something for later sessions.', input: toolInputOf(pr.fact ?? pr.content ?? pr) };
    default:
      return { title: `Allow ${prettyName(pr.kind || 'action').toLowerCase()}?`, message: intention || 'The agent is asking for permission.', input: toolInputOf(pr) };
  }
}

export function permissionOptions(pr = {}) {
  const opts = [{ id: 'approve-once', label: 'Allow once', kind: 'approve', group: 0 }];
  if (pr.canOfferSessionApproval) opts.push({ id: 'approve-session', label: 'Allow in this session', kind: 'approve', group: 0 });
  opts.push({ id: 'reject', label: 'Deny', kind: 'deny', group: 1 });
  return opts;
}

/** JSON-schema form (elicitation) -> AHP input questions. */
export function schemaQuestions(schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const out = [];
  for (const [id, p] of Object.entries(props)) {
    if (!p || typeof p !== 'object') continue;
    const base = { id, title: p.title || undefined, message: p.description || p.title || id, required: required.has(id) };
    const labels = Array.isArray(p.enumNames) ? p.enumNames : null;
    if (Array.isArray(p.enum)) out.push({ ...base, kind: 'single-select', options: p.enum.map((v, i) => ({ id: String(v), label: String(labels?.[i] ?? v) })) });
    else if (Array.isArray(p.oneOf) && p.oneOf.every((o) => o && 'const' in o)) out.push({ ...base, kind: 'single-select', options: p.oneOf.map((o) => ({ id: String(o.const), label: String(o.title ?? o.const) })) });
    else if (p.type === 'array' && Array.isArray(p.items?.enum)) out.push({ ...base, kind: 'multi-select', options: p.items.enum.map((v) => ({ id: String(v), label: String(v) })) });
    else if (p.type === 'boolean') out.push({ ...base, kind: 'boolean', ...(typeof p.default === 'boolean' ? { defaultValue: p.default } : {}) });
    else if (p.type === 'number' || p.type === 'integer') out.push({ ...base, kind: p.type, ...(typeof p.default === 'number' ? { defaultValue: p.default } : {}) });
    else out.push({ ...base, kind: 'text', ...(typeof p.default === 'string' ? { defaultValue: p.default } : {}) });
  }
  return out;
}

const answer = (kind, value) => ({ state: 'submitted', value: { kind, value } });

export class SessionTranslator {
  /**
   * @param {{ emit: (action: object) => void, onActivity?: (text?: string) => void, onTitle?: (t: string) => void,
   *   onConfig?: (values: object) => void, onModel?: (m: {id: string, config?: object}) => void, now?: () => number }} o
   */
  constructor(o) {
    this.o = o;
    this.now = o.now || Date.now;
    this.turn = null;
    this.phoneTurn = null;
    this.model = null;
    this.requests = new Map();
    this.phoneResolved = new Set();
    this.partialAt = new Map();
    this.live = false;
    this.seq = 0;
    /** Files attached to this chat's messages (the phone may read them). */
    this.files = new Set();
  }

  get activeTurnId() {
    return this.turn?.id || null;
  }

  _emit(action) {
    this.o.emit(action);
  }

  // ------------------------------------------------------------------ public API

  /** Rebuilds the chat from persisted history. `processing` = the session is mid-turn right now. */
  replay(events, { processing = false } = {}) {
    this.live = false;
    for (const e of events) this.handle(e);
    this.live = true;
    if (this.turn && !processing) this._endTurn(this._lastTs || this.now(), 'complete');
  }

  /** The phone started a turn (already echoed to clients): bind the next user message to it. */
  beginPhoneTurn({ turnId, text, startedAt }) {
    if (this.turn) this._endTurn(this.now(), 'complete');
    this.phoneTurn = { turnId, text };
    this.turn = this._newTurn(turnId, Date.parse(startedAt) || this.now());
  }

  /** The phone answered a request itself; skip the runtime's matching "completed" event. */
  markResolvedByPhone(requestId) {
    this.phoneResolved.add(requestId);
  }

  pendingRequest(requestId) {
    return this.requests.get(requestId) || null;
  }

  handle(e) {
    if (!e || typeof e.type !== 'string') return;
    if (e.timestamp) this._lastTs = Date.parse(e.timestamp) || this._lastTs;
    // Sub-agent internals are summarized by their parent `task` tool call.
    if (e.agentId || e.data?.parentToolCallId) return;
    const d = e.data || {};
    switch (e.type) {
      case 'user.message':
        return this._userMessage(e, d);
      case 'assistant.turn_start':
        return void this._ensureTurn(e);
      case 'assistant.intent':
        if (this.live && d.intent) this.o.onActivity?.(oneLine(d.intent, 120));
        return;
      case 'assistant.reasoning_delta':
        return this._text('reasoning', `rs-${d.reasoningId}`, d.deltaContent, true, e);
      case 'assistant.reasoning':
        return this._text('reasoning', `rs-${d.reasoningId}`, d.content, false, e);
      case 'assistant.message_delta':
        return this._text('markdown', `md-${d.messageId}`, d.deltaContent, true, e);
      case 'assistant.message':
        this._text('markdown', `md-${d.messageId}`, d.content, false, e);
        for (const tr of d.toolRequests || []) this._toolRequested(tr, e);
        return;
      case 'tool.execution_start':
        return this._toolStart(d, e);
      case 'tool.execution_partial_result':
        return this._toolPartial(d);
      case 'tool.execution_complete':
        return this._toolComplete(d, e);
      case 'permission.requested':
        return this._permissionRequested(d, e);
      case 'permission.completed':
        return this._permissionCompleted(d);
      case 'user_input.requested':
        return this._question(d, e);
      case 'user_input.completed':
        return this._questionDone(d);
      case 'elicitation.requested':
        return this._elicitation(d, e);
      case 'elicitation.completed':
        return this._elicitationDone(d);
      case 'exit_plan_mode.requested':
        return this._plan(d, e);
      case 'exit_plan_mode.completed':
        return this._planDone(d);
      case 'session.idle':
        return this._idle(d, e);
      case 'abort':
        if (this.turn) this.turn.aborted = true;
        return;
      case 'session.error':
        return this._error(d, e);
      case 'session.title_changed':
        if (d.title) this.o.onTitle?.(String(d.title));
        return;
      case 'session.mode_changed':
        if (d.newMode) this.o.onConfig?.({ mode: d.newMode });
        return;
      case 'session.permissions_changed':
        if (d.mode) this.o.onConfig?.({ autoApprove: d.mode === 'allow-all' ? 'autoApprove' : d.mode === 'assisted' ? 'assisted' : 'default' });
        return;
      case 'session.model_change':
        if (d.newModel) {
          this.model = { id: d.newModel };
          this.o.onModel?.({ id: d.newModel, reasoningEffort: d.reasoningEffort || undefined, contextTier: d.contextTier || undefined, autoTier: d.autoTier || undefined });
        }
        return;
      case 'session.start':
        if (d.selectedModel || d.model) this.model = { id: d.selectedModel || d.model };
        return;
      case 'assistant.usage':
        if (this.turn && (d.inputTokens || d.outputTokens)) {
          this.turn.usage.inputTokens += d.inputTokens || 0;
          this.turn.usage.outputTokens += d.outputTokens || 0;
        }
        return;
      default:
    }
  }

  // ------------------------------------------------------------------ turns

  _newTurn(id, startedAtMs) {
    return { id, startedAt: startedAtMs, parts: new Map(), tools: new Map(), hidden: new Set(), usage: { inputTokens: 0, outputTokens: 0 }, aborted: false };
  }

  _startTurn(id, ts, text, attachments) {
    this.turn = this._newTurn(id, ts);
    const message = { text: String(text ?? ''), origin: { kind: 'user' }, ...(this.model ? { model: this.model } : {}), ...(attachments?.length ? { attachments } : {}) };
    this._emit({ type: 'chat/turnStarted', turnId: id, startedAt: new Date(ts).toISOString(), message });
  }

  _ensureTurn(e) {
    if (this.turn) return this.turn;
    const ts = Date.parse(e?.timestamp) || this.now();
    this._startTurn(`t-${e?.id || ++this.seq}`, ts, '');
    return this.turn;
  }

  _userMessage(e, d) {
    const ts = Date.parse(e.timestamp) || this.now();
    const content = d.content ?? '';
    const system = d.isAutopilotContinuation || (d.source && d.source !== 'user');
    if (this.phoneTurn && this.turn?.id === this.phoneTurn.turnId && !this.turn.bound) {
      // The phone's turn is already on screen: keep its id and message.
      this.turn.bound = true;
      this.phoneTurn = null;
      return;
    }
    if (this.turn && d.delivery === 'steering') {
      // Guidance injected into the running turn ("Steer with Message"): it stays part of this turn.
      if (!system && String(content).trim()) this._emit({ type: 'chat/responsePart', turnId: this.turn.id, part: { kind: 'systemNotification', content: `Steering: ${oneLine(content, 300)}` } });
      return;
    }
    if (this.turn && system) return;
    if (this.turn) this._endTurn(ts, this.turn.aborted ? 'cancelled' : 'complete');
    this._startTurn(`u-${d.messageId || e.id || ++this.seq}`, ts, content, messageAttachments(d.attachments, (p) => this.files.add(fileKey(p))));
    this.turn.bound = true;
  }

  _endTurn(ts, how) {
    const t = this.turn;
    if (!t) return;
    for (const [requestId, r] of this.requests) if (r.turnId === t.id) this.requests.delete(requestId);
    const duration = Math.max(0, (ts || this.now()) - t.startedAt);
    if (t.usage.inputTokens || t.usage.outputTokens) this._emit({ type: 'chat/usage', turnId: t.id, usage: { ...t.usage } });
    this._emit(how === 'cancelled' ? { type: 'chat/turnCancelled', turnId: t.id, duration } : { type: 'chat/turnComplete', turnId: t.id, duration });
    this.turn = null;
    if (this.phoneTurn?.turnId === t.id) this.phoneTurn = null;
    if (this.live) this.o.onActivity?.(undefined);
  }

  _idle(d, e) {
    if (!this.turn) return;
    // A phone turn that the runtime has not picked up yet is not over.
    if (this.phoneTurn && this.turn.id === this.phoneTurn.turnId && !this.turn.bound) return;
    this._endTurn(Date.parse(e.timestamp) || this.now(), d.aborted || this.turn.aborted ? 'cancelled' : 'complete');
  }

  _error(d, e) {
    const t = this.turn;
    if (!t) return;
    const ts = Date.parse(e.timestamp) || this.now();
    for (const [requestId, r] of this.requests) if (r.turnId === t.id) this.requests.delete(requestId);
    this._emit({
      type: 'chat/error',
      turnId: t.id,
      duration: Math.max(0, ts - t.startedAt),
      part: { kind: 'error', error: { errorType: d.errorType || 'error', message: String(d.message || 'The agent stopped with an error.') }, resumable: false },
    });
    this.turn = null;
    if (this.phoneTurn?.turnId === t.id) this.phoneTurn = null;
    if (this.live) this.o.onActivity?.(undefined);
  }

  // ------------------------------------------------------------------ text

  _text(kind, partId, content, isDelta, e) {
    if (!content) return;
    const t = this._ensureTurn(e);
    const have = t.parts.get(partId);
    if (have === undefined) {
      if (!isDelta && !String(content).trim()) return;
      t.parts.set(partId, String(content));
      this._emit({ type: 'chat/responsePart', turnId: t.id, part: { kind, id: partId, content: String(content) } });
      return;
    }
    let add = String(content);
    if (!isDelta) {
      if (!add.startsWith(have) || add.length <= have.length) return;
      add = add.slice(have.length);
    }
    t.parts.set(partId, have + add);
    this._emit({ type: kind === 'reasoning' ? 'chat/reasoning' : 'chat/delta', turnId: t.id, partId, content: add });
  }

  // ------------------------------------------------------------------ tools

  _toolRequested(tr, e) {
    const id = tr.toolCallId;
    if (!id) return;
    const t = this._ensureTurn(e);
    if (HIDDEN_TOOLS.has(tr.name)) {
      t.hidden.add(id);
      return;
    }
    this._startTool(t, id, tr.name, tr.arguments, tr.toolTitle, tr.intentionSummary);
  }

  _startTool(t, id, name, args, title, intention) {
    if (t.tools.has(id)) return t.tools.get(id);
    const kind = toolKind(name);
    const displayName = DISPLAY[kind] || title || prettyName(name);
    const [running, past] = toolLabels(name, args, title);
    const tool = { status: 'streaming', name, args, running, past };
    t.tools.set(id, tool);
    this._emit({
      type: 'chat/toolCallStart',
      turnId: t.id,
      toolCallId: id,
      toolName: name,
      displayName,
      ...(intention ? { intention: oneLine(intention, 200) } : {}),
      _meta: { toolKind: kind, ...(kind === 'terminal' ? { language: /bash/.test(name) ? 'bash' : 'powershell' } : {}) },
    });
    return tool;
  }

  _run(t, id, tool) {
    if (tool.status === 'streaming') {
      this._emit({ type: 'chat/toolCallReady', turnId: t.id, toolCallId: id, invocationMessage: md(tool.running), toolInput: toolInputOf(tool.args), confirmed: 'not-needed' });
    } else if (tool.status === 'pending') {
      this._emit({ type: 'chat/toolCallConfirmed', turnId: t.id, toolCallId: id, approved: true, confirmed: 'user-action' });
      for (const [rid, r] of this.requests) if (r.toolCallId === id) this.requests.delete(rid);
    }
    tool.status = 'running';
  }

  _toolStart(d, e) {
    const t = this._ensureTurn(e);
    const id = d.toolCallId;
    if (!id || t.hidden.has(id) || HIDDEN_TOOLS.has(d.toolName)) {
      if (id) t.hidden.add(id);
      return;
    }
    const tool = t.tools.get(id) || this._startTool(t, id, d.toolName, d.arguments, d.toolTitle);
    if (d.arguments && !tool.args) tool.args = d.arguments;
    if (tool.status !== 'done' && tool.status !== 'running') this._run(t, id, tool);
  }

  _toolPartial(d) {
    const t = this.turn;
    const tool = t?.tools.get(d.toolCallId);
    if (!this.live || !tool || tool.status !== 'running' || !d.partialOutput) return;
    const last = this.partialAt.get(d.toolCallId) || 0;
    if (this.now() - last < 400) return;
    this.partialAt.set(d.toolCallId, this.now());
    this._emit({ type: 'chat/toolCallContentChanged', turnId: t.id, toolCallId: d.toolCallId, content: [{ type: 'text', text: tail(d.partialOutput) }] });
  }

  _toolComplete(d, e) {
    const t = this._ensureTurn(e);
    const id = d.toolCallId;
    if (!id || t.hidden.has(id)) return;
    const tool = t.tools.get(id) || this._startTool(t, id, d.toolName || 'tool', d.arguments);
    if (tool.status === 'done') return;
    // Denied on the PC while its "completed" event is still on its way.
    if (tool.status === 'pending' && !d.success && /den(y|ied)|reject|declin|not (allowed|permitted)|permission/i.test(`${d.error?.message || ''} ${d.result?.content || ''}`)) {
      for (const [rid, r] of this.requests) if (r.toolCallId === id) this.requests.delete(rid);
      this._emit({ type: 'chat/toolCallConfirmed', turnId: t.id, toolCallId: id, approved: false, reason: 'denied' });
      tool.status = 'done';
      return;
    }
    if (tool.status !== 'running') this._run(t, id, tool);
    this.partialAt.delete(id);
    const r = d.result || {};
    const text = r.detailedContent || r.content || '';
    const result = {
      success: !!d.success,
      pastTenseMessage: md(d.success ? tool.past : `${tool.past} (failed)`),
      ...(text ? { content: [{ type: 'text', text: clip(text) }] } : {}),
      ...(d.error?.message ? { error: { message: String(d.error.message), ...(d.error.code ? { code: String(d.error.code) } : {}) } } : {}),
    };
    this._emit({ type: 'chat/toolCallComplete', turnId: t.id, toolCallId: id, result });
    tool.status = 'done';
  }

  // ------------------------------------------------------------------ permissions

  _permissionRequested(d, e) {
    if (d.resolvedByHook || !d.requestId) return;
    const pr = d.permissionRequest || {};
    const t = this._ensureTurn(e);
    const id = pr.toolCallId && !t.hidden.has(pr.toolCallId) ? pr.toolCallId : `perm-${d.requestId}`;
    const prompt = permissionPrompt(pr);
    const guessName = pr.kind === 'shell' ? 'powershell' : pr.kind === 'mcp' ? pr.toolName : pr.kind === 'write' ? 'edit' : pr.kind === 'read' ? 'view' : pr.kind || 'permission';
    const guessArgs = pr.kind === 'shell' ? { command: pr.fullCommandText } : pr.kind === 'write' ? { path: pr.fileName } : pr.kind === 'read' ? { path: pr.path } : undefined;
    const tool = t.tools.get(id) || this._startTool(t, id, guessName, guessArgs, pr.toolTitle);
    if (tool.status === 'done') return;
    tool.status = 'pending';
    this.requests.set(d.requestId, { kind: 'permission', turnId: t.id, toolCallId: id });
    this._emit({
      type: 'chat/toolCallReady',
      turnId: t.id,
      toolCallId: id,
      invocationMessage: md(prompt.message + (prompt.warning ? `\n\n⚠️ ${oneLine(prompt.warning, 300)}` : '')),
      ...(prompt.input ? { toolInput: prompt.input } : {}),
      confirmationTitle: prompt.title,
      options: permissionOptions(pr),
    });
  }

  _permissionCompleted(d) {
    const r = this.requests.get(d.requestId);
    this.requests.delete(d.requestId);
    if (!r || this.phoneResolved.delete(d.requestId)) return;
    const t = this.turn;
    const tool = t?.tools.get(r.toolCallId);
    if (!t || t.id !== r.turnId || !tool || tool.status !== 'pending') return;
    const approved = /^approved/.test(d.result?.kind || '');
    this._emit(approved
      ? { type: 'chat/toolCallConfirmed', turnId: t.id, toolCallId: r.toolCallId, approved: true, confirmed: 'user-action' }
      : { type: 'chat/toolCallConfirmed', turnId: t.id, toolCallId: r.toolCallId, approved: false, reason: 'denied' });
    tool.status = approved ? 'running' : 'done';
  }

  /** Called after the phone's approve/deny was accepted by the runtime. */
  phoneConfirmed(requestId, approved) {
    const r = this.requests.get(requestId);
    if (!r) return;
    this.requests.delete(requestId);
    this.phoneResolved.add(requestId);
    const tool = this.turn?.tools.get(r.toolCallId);
    if (tool) tool.status = approved ? 'running' : 'done';
  }

  /** What the phone's approve/deny maps to in the runtime (for `permissions.handlePendingPermissionRequest`). */
  static permissionDecision(approved, optionId) {
    if (!approved) return { kind: 'reject' };
    return optionId === 'approve-session' ? { kind: 'approve-for-session' } : { kind: 'approve-once' };
  }

  // ------------------------------------------------------------------ questions

  _openInput(requestId, kind, request, e, extra = {}) {
    const t = this._ensureTurn(e);
    this.requests.set(requestId, { kind, turnId: t.id, ...extra });
    this._emit({ type: 'chat/inputRequested', request: { id: requestId, ...request } });
  }

  _closeInput(requestId, response, answers) {
    const r = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (!r || this.phoneResolved.delete(requestId)) return;
    if (!this.turn || this.turn.id !== r.turnId) return;
    this._emit({ type: 'chat/inputCompleted', requestId, response, ...(answers ? { answers } : {}) });
  }

  /** Called after the phone's answer was accepted by the runtime. */
  phoneAnswered(requestId) {
    this.requests.delete(requestId);
    this.phoneResolved.add(requestId);
  }

  _question(d, e) {
    if (!d.requestId) return;
    const choices = Array.isArray(d.choices) ? d.choices.filter((c) => typeof c === 'string' && c) : [];
    const q = { id: 'answer', message: String(d.question || 'The agent has a question.'), required: true };
    const question = choices.length
      ? { ...q, kind: 'single-select', options: choices.map((c) => ({ id: c, label: c })), allowFreeformInput: d.allowFreeform !== false }
      : { ...q, kind: 'text' };
    this._openInput(d.requestId, 'question', { questions: [question] }, e, { choices });
  }

  _questionDone(d) {
    if (d.answer === undefined || d.answer === null) return this._closeInput(d.requestId, 'cancel');
    const r = this.requests.get(d.requestId);
    const picked = !d.wasFreeform && r?.choices?.includes(d.answer);
    this._closeInput(d.requestId, 'accept', { answer: answer(picked ? 'selected' : 'text', String(d.answer)) });
  }

  _elicitation(d, e) {
    if (!d.requestId) return;
    const questions = schemaQuestions(d.requestedSchema);
    this._openInput(d.requestId, 'elicitation', { message: String(d.message || ''), ...(d.url ? { url: d.url } : {}), ...(questions.length ? { questions } : {}) }, e, { questions });
  }

  _elicitationDone(d) {
    const action = d.action === 'accept' || d.action === 'decline' ? d.action : 'cancel';
    const r = this.requests.get(d.requestId);
    let answers;
    if (action === 'accept' && d.content && r?.questions) {
      answers = {};
      for (const q of r.questions) {
        const v = d.content[q.id];
        if (v === undefined) continue;
        const kind = q.kind === 'boolean' ? 'boolean' : q.kind === 'single-select' ? 'selected' : q.kind === 'multi-select' ? 'selected-many' : q.kind === 'number' || q.kind === 'integer' ? 'number' : 'text';
        answers[q.id] = answer(kind, v);
      }
    }
    this._closeInput(d.requestId, action, answers);
  }

  _plan(d, e) {
    if (!d.requestId) return;
    const actions = (Array.isArray(d.actions) && d.actions.length ? d.actions : ['interactive', 'exit_only']).filter((a) => PLAN_ACTIONS[a]);
    const message = [`**The plan is ready.** ${d.summary ? oneLine(d.summary, 400) : ''}`.trim(), d.planContent ? clip(d.planContent, 8000) : ''].filter(Boolean).join('\n\n');
    this._openInput(d.requestId, 'plan', {
      message,
      questions: [
        { id: 'action', kind: 'single-select', message: 'How should the agent continue?', required: false, options: actions.map((a) => ({ id: a, label: PLAN_ACTIONS[a], ...(a === d.recommendedAction ? { recommended: true } : {}) })) },
        { id: 'feedback', kind: 'text', message: 'Or tell the agent what to change in the plan', required: false },
      ],
    }, e);
  }

  _planDone(d) {
    const answers = {};
    if (d.selectedAction) answers.action = answer('selected', d.selectedAction);
    if (d.feedback) answers.feedback = answer('text', String(d.feedback));
    this._closeInput(d.requestId, d.approved || d.feedback ? 'accept' : 'decline', Object.keys(answers).length ? answers : undefined);
  }

  /** Phone answer (AHP `chat/inputCompleted`) -> the runtime call that resolves the request. */
  static inputResolution(req, response, answers = {}) {
    const val = (id) => (answers?.[id]?.state === 'submitted' ? answers[id].value : undefined);
    if (req.kind === 'question') {
      const v = val('answer');
      if (response !== 'accept' || !v) return { op: 'input', response: { answer: '', wasFreeform: true } };
      const text = Array.isArray(v.value) ? v.value.join(', ') : String(v.value);
      return { op: 'input', response: { answer: text, wasFreeform: v.kind !== 'selected' || !(req.choices || []).includes(text) } };
    }
    if (req.kind === 'elicitation') {
      if (response !== 'accept') return { op: 'elicitation', response: { action: response === 'decline' ? 'decline' : 'cancel' } };
      const content = {};
      for (const [id, a] of Object.entries(answers || {})) if (a?.state === 'submitted') content[id] = a.value.value;
      return { op: 'elicitation', response: { action: 'accept', content } };
    }
    if (req.kind === 'plan') {
      const action = val('action')?.value;
      const feedback = val('feedback')?.value;
      if (response === 'accept' && action) return { op: 'plan', response: { approved: true, selectedAction: action, ...(feedback ? { feedback: String(feedback) } : {}) } };
      return { op: 'plan', response: { approved: false, ...(feedback ? { feedback: String(feedback) } : {}) } };
    }
    return null;
  }
}
