// An Agent Host Protocol server over GitHub Copilot SDK sessions. Each Copilot app / CLI session is
// attached by its Pocket Pilot extension process; the phone talks to this exactly like it talks to
// VS Code's agent host. State is kept with the official AHP reducers, so snapshots and live actions
// always agree with what clients compute.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionTranslator, fileKey, imageTypeOf } from './translate.mjs';

export const ROOT = 'ahp-root://';
export const PROVIDER = 'copilotcli';
const S = { Idle: 1, Error: 2, InProgress: 8, InputNeeded: 16, IsRead: 32, IsArchived: 64 };
const ACTIVITY = 31;
const REPLAY_LIMIT = 4000;
const MAX_READ = 2 * 1024 * 1024;
const MAX_PICTURE = 20 * 1024 * 1024;

const b64url = (s) => Buffer.from(s).toString('base64url');

export const SESSION_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string', title: 'Agent Mode', description: 'How the agent should approach this turn',
      enum: ['interactive', 'plan', 'autopilot'], enumLabels: ['Interactive', 'Plan', 'Autopilot'],
      enumDescriptions: ['Step-by-step collaboration', 'Plan first, execute when ready', 'Works autonomously within permissions'],
      default: 'interactive', sessionMutable: true,
    },
    autoApprove: {
      type: 'string', title: 'Approvals', description: 'Tool approval behavior for this session',
      enum: ['default', 'assisted', 'autoApprove'], enumLabels: ['Manual permissions', 'Assisted permissions', 'Allow all'],
      enumDescriptions: ["Asks when approval settings don't apply", 'Evaluates risk before running tools', 'Runs tool calls without asking'],
      default: 'default', sessionMutable: true,
    },
  },
};

const RPC = { ParseError: -32700, InvalidRequest: -32600, MethodNotFound: -32601, InvalidParams: -32602, Internal: -32603 };
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const EFFORT_LABELS = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };
const sizeLabel = (n) => (n >= 900000 ? `${Math.round(n / 1e6)}M` : `${Math.round(n / 1000)}K`);
const AUTO_TIER = {
  type: 'string', title: 'Optimize for', description: 'Biases which models Auto routes this session to.',
  enum: ['efficiency', 'balance', 'intelligence'], enumLabels: ['Efficiency', 'Balance', 'Intelligence'],
  enumDescriptions: ['Cheaper models for everyday tasks', 'Balances capability and cost', 'Most capable models, higher cost'], default: 'balance',
};

/**
 * Copilot runtime model list (raw CAPI entries or SDK `Model`s) -> AHP models with the same options
 * VS Code offers: thinking level from the model's reasoning efforts, context size from its pricing
 * tiers (the long tier is the default when it costs the same), and Auto's "Optimize for".
 */
export function toAhpModels(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m.id !== 'string') continue;
    const supports = m.capabilities?.supports || {};
    const limits = m.capabilities?.limits || {};
    const efforts = (Array.isArray(m.supportedReasoningEfforts) && m.supportedReasoningEfforts.length ? m.supportedReasoningEfforts : Array.isArray(supports.reasoning_effort) ? supports.reasoning_effort : []).filter((e) => typeof e === 'string');
    const prices = m.billing?.token_prices || {};
    const short = prices.default?.max_prompt_tokens;
    const long = prices.long_context?.max_prompt_tokens;
    const properties = {};
    if (m.id === 'auto') properties.tier = AUTO_TIER;
    if (efforts.length) {
      const preferred = m.defaultReasoningEffort || (m.vendor === 'Anthropic' ? 'high' : 'medium');
      properties.thinkingLevel = {
        type: 'string', title: 'Thinking Level', description: 'How much reasoning effort the model uses.',
        enum: efforts, enumLabels: efforts.map((e) => EFFORT_LABELS[e] || e[0].toUpperCase() + e.slice(1)),
        default: efforts.includes(preferred) ? preferred : efforts[Math.min(1, efforts.length - 1)],
      };
    }
    if (Number.isFinite(short) && Number.isFinite(long) && long > short) {
      properties.contextSize = {
        type: 'number', title: 'Context Size', description: 'How much of the conversation the model sees.',
        enum: [short, long], enumLabels: [sizeLabel(short), sizeLabel(long)],
        default: prices.long_context.input_price === prices.default.input_price ? long : short,
      };
    }
    const policy = m.policy?.state;
    out.push({
      id: m.id,
      provider: PROVIDER,
      name: String(m.name || m.id),
      ...(limits.max_context_window_tokens ? { maxContextWindow: limits.max_context_window_tokens } : {}),
      ...(limits.max_output_tokens ? { maxOutputTokens: limits.max_output_tokens } : {}),
      supportsVision: !!(supports.vision || limits.vision),
      ...(policy ? { policyState: policy === 'enabled' ? 'enabled' : policy === 'disabled' ? 'disabled' : 'unconfigured' } : {}),
      ...(Object.keys(properties).length ? { configSchema: { type: 'object', properties } } : {}),
      ...(m.billing?.multiplier !== undefined ? { _meta: { multiplier: m.billing.multiplier } } : {}),
    });
  }
  return out;
}

/** The runtime's model state ({ id, reasoningEffort, contextTier, autoTier }) as an AHP model selection. */
export function toSelection(models, raw) {
  if (!raw?.id) return null;
  const props = models.find((m) => m.id === raw.id)?.configSchema?.properties || {};
  const config = {};
  if (props.thinkingLevel && raw.reasoningEffort && props.thinkingLevel.enum.includes(raw.reasoningEffort)) config.thinkingLevel = raw.reasoningEffort;
  if (props.contextSize && raw.contextTier) config.contextSize = raw.contextTier === 'long_context' ? props.contextSize.enum[1] : props.contextSize.enum[0];
  if (props.tier && raw.autoTier && props.tier.enum.includes(raw.autoTier)) config.tier = raw.autoTier;
  return { id: raw.id, ...(Object.keys(config).length ? { config } : {}) };
}

/** An AHP model selection as the runtime's setModel arguments. */
export function toRuntime(models, sel) {
  if (!sel?.id) return null;
  const props = models.find((m) => m.id === sel.id)?.configSchema?.properties || {};
  const c = sel.config || {};
  return {
    id: sel.id,
    ...(props.thinkingLevel && props.thinkingLevel.enum.includes(c.thinkingLevel) ? { reasoningEffort: c.thinkingLevel } : {}),
    ...(props.contextSize && props.contextSize.enum.includes(c.contextSize) ? { contextTier: c.contextSize === props.contextSize.enum[1] ? 'long_context' : 'default' } : {}),
    ...(props.tier && props.tier.enum.includes(c.tier) ? { autoTier: c.tier } : {}),
  };
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The in-process pipe the relay and the notification monitor use instead of a WebSocket. */
class Pipe extends EventEmitter {
  constructor(deliver, onClose) {
    super();
    this.deliver = deliver;
    this.onClose = onClose;
    this.closed = false;
  }

  send(text) {
    if (this.closed) return;
    const t = typeof text === 'string' ? text : JSON.stringify(text);
    queueMicrotask(() => this.deliver(t));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => {
      this.onClose();
      this.emit('close', 1000, '');
    });
  }
}

export class CopilotAgentHost extends EventEmitter {
  /**
   * @param {{ reducers: { rootReducer: Function, sessionReducer: Function, chatReducer: Function }, supportedVersions: string[],
   *   log?: (level: string, msg: string) => void, defaultDirectory?: string }} o
   */
  constructor(o) {
    super();
    this.o = o;
    this.log = o.log || (() => {});
    // Unique per hub instance (and above any earlier one), so a phone reconnecting after a hub
    // failover never gets a replay from another hub's sequence space: it gets fresh snapshots.
    this.seq = Date.now() * 1000;
    this.buffer = [];
    this.conns = new Set();
    this.sessions = new Map();
    this.byChat = new Map();
    this.root = { agents: [{ provider: PROVIDER, displayName: 'Copilot', description: 'GitHub Copilot app and CLI sessions on this PC', models: [] }], activeSessions: 0 };
  }

  // ------------------------------------------------------------------ sessions

  get sessionCount() {
    return this.sessions.size;
  }

  /** Summaries of the attached sessions (for the monitor, status and file-access checks). */
  summaries() {
    return [...this.sessions.values()].map((e) => e.summary);
  }

  workingDirectories() {
    return [...this.sessions.values()].map((e) => e.cwd).filter(Boolean);
  }

  /** Whether a paired device may read this local file: inside a session folder, or attached to a message. */
  canRead(file) {
    const abs = path.resolve(String(file));
    const key = fileKey(abs);
    if ([...this.sessions.values()].some((e) => e.translator?.files?.has(key))) return true;
    return this.workingDirectories().some((d) => isInside(abs, path.resolve(d)));
  }

  setModels(list) {
    const models = toAhpModels(list);
    if (!models.length) return;
    const agents = [{ ...this.root.agents[0], models }];
    this._dispatch(ROOT, { type: 'root/agentsChanged', agents });
    // Sessions attached before the list arrived only knew the bare model id: fill in its settings now.
    for (const entry of this.sessions.values()) if (entry.rawModel) this._modelChanged(entry, entry.rawModel);
  }

  get models() {
    return this.root.agents[0]?.models || [];
  }

  /** The runtime switched model (from the app, the CLI or a phone): every client's picker follows. */
  _modelChanged(entry, raw) {
    const model = toSelection(this.models, raw);
    if (!model) return;
    entry.rawModel = raw;
    entry.translator.model = model;
    if (JSON.stringify(entry.chat.draft?.model) === JSON.stringify(model)) return;
    const draft = { ...(entry.chat.draft || { text: '', origin: { kind: 'user' } }), model };
    if (entry.replaying) entry.chat = { ...entry.chat, draft };
    else this._dispatch(entry.chatUri, { type: 'chat/draftChanged', draft });
  }

  /**
   * Attaches a session. `bridge.request(op, params)` executes runtime calls in the session's process.
   * @param {{ sessionId: string, cwd?: string, gitRoot?: string, title?: string, createdAt?: string, mode?: string,
   *   autoApprove?: string, model?: object, changes?: object, history?: object[], processing?: boolean, bridge: { request: Function } }} info
   */
  attach(info) {
    const uri = `${PROVIDER}:/${info.sessionId}`;
    if (this.sessions.has(uri)) this.detach(info.sessionId, { quiet: true });
    const chatUri = `ahp-chat://default/${b64url(uri)}`;
    const now = new Date().toISOString();
    const cwd = info.cwd || '';
    const cwdUri = cwd ? toUri(cwd) : undefined;
    const projectDir = info.gitRoot || cwd;
    const entry = {
      id: info.sessionId,
      uri,
      chatUri,
      cwd,
      bridge: info.bridge,
      activity: undefined,
      queue: [],
      processing: false,
      summary: {
        resource: uri,
        provider: PROVIDER,
        title: info.title || 'New session',
        status: S.Idle | S.IsRead,
        createdAt: info.createdAt || now,
        modifiedAt: now,
        workingDirectories: cwdUri ? [cwdUri] : [],
        ...(projectDir ? { project: { uri: toUri(projectDir), displayName: path.basename(projectDir) || projectDir } } : {}),
        ...(info.changes ? { changes: info.changes } : {}),
      },
      state: null,
      chat: null,
    };
    entry.state = {
      provider: PROVIDER,
      title: entry.summary.title,
      status: entry.summary.status,
      lifecycle: 'ready',
      chats: [{ resource: chatUri, title: entry.summary.title, status: S.Idle, modifiedAt: now, origin: { kind: 'user' } }],
      defaultChat: chatUri,
      workingDirectories: entry.summary.workingDirectories,
      config: { schema: SESSION_CONFIG_SCHEMA, values: { mode: info.mode || 'interactive', autoApprove: info.autoApprove || 'default' } },
    };
    entry.chat = { resource: chatUri, title: entry.summary.title, status: S.Idle, modifiedAt: entry.summary.createdAt, origin: { kind: 'user' }, turns: [] };
    entry.translator = new SessionTranslator({
      emit: (action) => this._fromRuntime(entry, action),
      onActivity: (text) => this._setActivity(entry, text),
      onTitle: (title) => this._setTitle(entry, title),
      onConfig: (values) => this._dispatch(uri, { type: 'session/configChanged', config: values }),
      onModel: (raw) => this._modelChanged(entry, raw),
    });
    this.sessions.set(uri, entry);
    this.byChat.set(chatUri, entry);
    // History is reduced silently: clients only ever see it as part of snapshots.
    entry.replaying = true;
    try {
      entry.translator.replay(info.history || [], { processing: !!info.processing });
    } catch (err) {
      this.log('warn', `History of ${info.sessionId} could not be fully rebuilt: ${err.message}`);
    }
    if (info.model?.id) this._modelChanged(entry, info.model);
    entry.replaying = false;
    const last = entry.chat.turns[entry.chat.turns.length - 1];
    entry.summary.modifiedAt = entry.chat.modifiedAt || last?.startedAt || entry.summary.createdAt;
    this._syncStatus(entry, { notify: false });
    this._broadcastRoot('root/sessionAdded', { channel: ROOT, summary: entry.summary });
    this._dispatch(ROOT, { type: 'root/activeSessionsChanged', activeSessions: this.sessions.size });
    this.emit('sessions');
    return entry;
  }

  detach(sessionId, { quiet = false } = {}) {
    const uri = `${PROVIDER}:/${sessionId}`;
    const entry = this.sessions.get(uri);
    if (!entry) return;
    this.sessions.delete(uri);
    this.byChat.delete(entry.chatUri);
    if (quiet) return;
    this._broadcastRoot('root/sessionRemoved', { channel: ROOT, session: uri });
    this._dispatch(ROOT, { type: 'root/activeSessionsChanged', activeSessions: this.sessions.size });
    this.emit('sessions');
  }

  /** A live runtime event from a session's extension process. */
  event(sessionId, e) {
    const entry = this.sessions.get(`${PROVIDER}:/${sessionId}`);
    if (!entry) return;
    try {
      entry.translator.handle(e);
    } catch (err) {
      this.log('warn', `Could not translate ${e?.type}: ${err.message}`);
    }
    if (e?.type === 'session.idle') this._drainQueue(entry);
  }

  update(sessionId, changes) {
    const entry = this.sessions.get(`${PROVIDER}:/${sessionId}`);
    if (!entry) return;
    if (changes.changes) this._summary(entry, { changes: changes.changes });
    if (changes.title) this._setTitle(entry, changes.title);
  }

  // ------------------------------------------------------------------ state + fan-out

  _entryFor(channel) {
    return this.sessions.get(channel) || this.byChat.get(channel) || null;
  }

  _apply(channel, action) {
    const r = this.o.reducers;
    if (channel === ROOT) {
      this.root = r.rootReducer(this.root, action);
      return true;
    }
    const entry = this._entryFor(channel);
    if (!entry) return false;
    if (channel === entry.chatUri) entry.chat = r.chatReducer(entry.chat, action);
    else entry.state = r.sessionReducer(entry.state, action);
    return true;
  }

  _dispatch(channel, action, origin) {
    if (!this._apply(channel, action)) return;
    const entry = channel === ROOT ? null : this._entryFor(channel);
    if (entry?.replaying) {
      if (channel === entry.chatUri) this._syncStatus(entry, { notify: false });
      return;
    }
    const env = { channel, action, serverSeq: ++this.seq, ...(origin ? { origin } : {}) };
    this.buffer.push(env);
    if (this.buffer.length > REPLAY_LIMIT) this.buffer.splice(0, this.buffer.length - REPLAY_LIMIT);
    for (const c of this.conns) if (c.subs.has(channel)) c.notify('action', env);
    if (entry && channel === entry.chatUri) this._syncStatus(entry);
  }

  _reject(conn, channel, action, clientSeq, reason) {
    conn.notify('action', { channel, action, serverSeq: this.seq, origin: { clientId: conn.clientId, clientSeq }, rejectionReason: reason });
  }

  _broadcastRoot(method, params) {
    for (const c of this.conns) if (c.subs.has(ROOT)) c.notify(method, params);
  }

  _summary(entry, changes) {
    let dirty = false;
    for (const [k, v] of Object.entries(changes)) {
      if (JSON.stringify(entry.summary[k]) !== JSON.stringify(v)) {
        dirty = true;
        if (v === undefined) delete entry.summary[k];
        else entry.summary[k] = v;
      }
    }
    if (dirty && !entry.replaying) {
      this._broadcastRoot('root/sessionSummaryChanged', { channel: ROOT, session: entry.uri, changes });
      this.emit('summary', entry.summary);
    }
  }

  /** Mirrors the chat's derived status into the session summary and the session's chat catalog. */
  _syncStatus(entry, { notify = true } = {}) {
    const flags = entry.state.status & (S.IsRead | S.IsArchived);
    const status = (entry.chat.status & ACTIVITY) | flags;
    const modifiedAt = entry.chat.modifiedAt || entry.summary.modifiedAt;
    const chatStatus = entry.chat.status & ACTIVITY;
    if (entry.state.status !== status) entry.state = { ...entry.state, status };
    const cat = entry.state.chats[0];
    if (notify && cat && (cat.status !== chatStatus || cat.modifiedAt !== modifiedAt || cat.activity !== entry.activity)) {
      this._dispatch(entry.uri, { type: 'session/chatUpdated', chat: entry.chatUri, changes: { status: chatStatus, modifiedAt, ...(entry.activity ? { activity: entry.activity } : {}) } });
    }
    if (notify) this._summary(entry, { status, modifiedAt });
    else Object.assign(entry.summary, { status, modifiedAt });
  }

  _setActivity(entry, text) {
    if (entry.activity === text) return;
    entry.activity = text;
    this._dispatch(entry.chatUri, { type: 'chat/activityChanged', ...(text ? { activity: text } : {}) });
    this._summary(entry, { activity: text });
  }

  _setTitle(entry, title) {
    if (!title || title === entry.summary.title) return;
    this._dispatch(entry.uri, { type: 'session/titleChanged', title });
    this._summary(entry, { title });
  }

  /** Runtime-originated chat action from the translator. */
  _fromRuntime(entry, action) {
    if (action.type === 'chat/turnStarted' && !entry.replaying) {
      const i = entry.queue.findIndex((q) => q.text.trim() === action.message.text.trim());
      if (i >= 0) {
        const [q] = entry.queue.splice(i, 1);
        this._dispatch(entry.chatUri, { type: 'chat/pendingMessageRemoved', kind: 'queued', id: q.id });
        action = { ...action, queuedMessageId: q.id };
      }
    }
    this._dispatch(entry.chatUri, action);
    const unread = ['chat/turnComplete', 'chat/turnCancelled', 'chat/error', 'chat/inputRequested'].includes(action.type)
      || (action.type === 'chat/toolCallReady' && !action.confirmed);
    if (unread && !entry.replaying && (entry.state.status & S.IsRead)) this._dispatch(entry.uri, { type: 'session/isReadChanged', isRead: false });
  }

  // ------------------------------------------------------------------ connections

  /** Opens an in-process AHP connection (same interface as a WebSocket from `wslite`). */
  openConnection() {
    let conn;
    const client = new Pipe((text) => this._onMessage(conn, text), () => this._onClose(conn));
    conn = {
      id: Math.random().toString(36).slice(2),
      clientId: null,
      subs: new Set(),
      closed: false,
      notify: (method, params) => this._send(conn, { jsonrpc: '2.0', method, params }),
      reply: (id, result) => this._send(conn, { jsonrpc: '2.0', id, result }),
      error: (id, code, message) => this._send(conn, { jsonrpc: '2.0', id, error: { code, message } }),
      client,
    };
    this.conns.add(conn);
    return client;
  }

  _send(conn, msg) {
    if (conn.closed) return;
    const text = JSON.stringify(msg);
    queueMicrotask(() => {
      if (!conn.closed) conn.client.emit('message', text, false);
    });
  }

  _onClose(conn) {
    conn.closed = true;
    this.conns.delete(conn);
  }

  /** Closes every client connection (e.g. when the hub shuts down). */
  closeAll() {
    for (const c of [...this.conns]) c.client.close();
  }

  async _onMessage(conn, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return conn.error(null, RPC.ParseError, 'Parse error');
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') return;
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = await this._handle(conn, msg.method, msg.params || {});
      if (isRequest) conn.reply(msg.id, result ?? {});
    } catch (err) {
      if (isRequest) conn.error(msg.id, err.code || RPC.Internal, err.message || String(err));
      else this.log('warn', `AHP ${msg.method}: ${err.message}`);
    }
  }

  _snapshot(uri) {
    if (uri === ROOT) return { resource: ROOT, state: this.root, fromSeq: this.seq };
    const entry = this._entryFor(uri);
    if (!entry) return null;
    return { resource: uri, state: uri === entry.chatUri ? entry.chat : entry.state, fromSeq: this.seq };
  }

  _pickVersion(offered) {
    const mine = this.o.supportedVersions;
    for (const v of Array.isArray(offered) ? offered : []) if (mine.includes(v)) return v;
    throw new RpcError(RPC.InvalidParams, `No common protocol version (server supports ${mine.join(', ')})`);
  }

  async _handle(conn, method, p) {
    switch (method) {
      case 'initialize': {
        const protocolVersion = this._pickVersion(p.protocolVersions);
        conn.clientId = String(p.clientId || conn.id);
        const snapshots = [];
        for (const uri of p.initialSubscriptions || []) {
          const s = this._snapshot(uri);
          if (s) {
            conn.subs.add(uri);
            snapshots.push(s);
          }
        }
        return { protocolVersion, serverSeq: this.seq, snapshots, ...(this.o.defaultDirectory ? { defaultDirectory: this.o.defaultDirectory } : {}) };
      }
      case 'reconnect': {
        conn.clientId = String(p.clientId || conn.id);
        const subs = (p.subscriptions || []).filter((u) => typeof u === 'string');
        const oldest = this.buffer.length ? this.buffer[0].serverSeq : this.seq + 1;
        const last = Number(p.lastSeenServerSeq);
        conn.subs = new Set(subs.filter((u) => this._snapshot(u)));
        const missing = subs.filter((u) => !conn.subs.has(u));
        if (Number.isFinite(last) && last >= oldest - 1 && last <= this.seq) {
          return { type: 'replay', actions: this.buffer.filter((e) => e.serverSeq > last && conn.subs.has(e.channel)), missing };
        }
        return { type: 'snapshot', snapshots: [...conn.subs].map((u) => this._snapshot(u)) };
      }
      case 'subscribe': {
        const s = this._snapshot(p.channel);
        if (!s) throw new RpcError(RPC.InvalidParams, `Unknown resource: ${p.channel}`);
        conn.subs.add(p.channel);
        return { snapshot: s };
      }
      case 'unsubscribe':
        conn.subs.delete(p.channel);
        return undefined;
      case 'ping':
        return {};
      case 'listSessions':
        return { items: this.summaries() };
      case 'fetchTurns':
        return {};
      case 'dispatchAction':
        return this._clientAction(conn, p.channel, p.action, p.clientSeq);
      case 'resourceRead':
        return this._read(p.uri, p.encoding);
      case 'createSession':
        throw new RpcError(RPC.MethodNotFound, 'Start new sessions in the GitHub Copilot app or CLI on your PC; they appear here right away.');
      default:
        throw new RpcError(RPC.MethodNotFound, `"${method}" is not supported for GitHub Copilot app sessions`);
    }
  }

  _read(uri, encoding) {
    let file;
    try {
      file = fileURLToPath(String(uri));
    } catch {
      throw new RpcError(RPC.InvalidParams, 'Only local files can be opened');
    }
    file = path.resolve(file);
    if (!this.canRead(file)) throw new RpcError(RPC.InvalidParams, 'Reading files outside your session folders is not allowed');
    const st = fs.statSync(file);
    if (!st.isFile()) throw new RpcError(RPC.InvalidParams, 'Not a file');
    const picture = imageTypeOf(file);
    if (st.size > (picture ? MAX_PICTURE : MAX_READ)) throw new RpcError(RPC.InvalidParams, 'The file is too large to preview');
    const buf = fs.readFileSync(file);
    if (picture || encoding === 'base64') return { data: buf.toString('base64'), encoding: 'base64', ...(picture ? { contentType: picture } : {}) };
    const binary = buf.subarray(0, 8000).includes(0);
    return binary ? { data: buf.toString('base64'), encoding: 'base64' } : { data: buf.toString('utf8'), encoding: 'utf-8', contentType: 'text/plain' };
  }

  // ------------------------------------------------------------------ phone actions

  async _clientAction(conn, channel, action, clientSeq) {
    const origin = { clientId: conn.clientId, clientSeq };
    const entry = this._entryFor(channel);
    if (!entry || !action || typeof action.type !== 'string') return this._reject(conn, channel, action, clientSeq, 'This session is no longer open on your PC');
    const t = entry.translator;
    const fail = (err) => this._reject(conn, channel, action, clientSeq, err?.message || String(err));
    const run = async (op, params) => entry.bridge.request(op, params);
    try {
      switch (action.type) {
        case 'chat/turnStarted': {
          const text = String(action.message?.text ?? '').trim();
          if (!text) return fail('Type a message first');
          if (t.activeTurnId) return fail('The agent is still working — your message was not sent');
          this._dispatch(entry.chatUri, action, origin);
          t.beginPhoneTurn({ turnId: action.turnId, text, startedAt: action.startedAt });
          this._summary(entry, { modifiedAt: new Date().toISOString() });
          try {
            await run('send', { prompt: text, model: toRuntime(this.models, action.message.model), attachments: action.message.attachments });
          } catch (err) {
            if (t.activeTurnId === action.turnId) {
              t.turn = null;
              t.phoneTurn = null;
              this._dispatch(entry.chatUri, { type: 'chat/error', turnId: action.turnId, duration: 0, part: { kind: 'error', error: { errorType: 'send', message: `Could not send: ${err.message}` }, resumable: false } });
            }
          }
          return;
        }
        case 'chat/pendingMessageSet': {
          const text = String(action.message?.text ?? '').trim();
          if (!text) return fail('Type a message first');
          if (action.kind === 'steering') {
            await run('send', { prompt: text, mode: 'immediate', attachments: action.message.attachments });
            this._dispatch(entry.chatUri, action, origin);
            this._dispatch(entry.chatUri, { type: 'chat/pendingMessageRemoved', kind: 'steering', id: action.id });
            return;
          }
          this._dispatch(entry.chatUri, action, origin);
          const q = entry.queue.find((m) => m.id === action.id);
          if (q) Object.assign(q, { text, model: action.message.model, attachments: action.message.attachments });
          else entry.queue.push({ id: action.id, text, model: action.message.model, attachments: action.message.attachments });
          if (!t.activeTurnId) this._drainQueue(entry);
          return;
        }
        case 'chat/pendingMessageRemoved': {
          entry.queue = entry.queue.filter((m) => m.id !== action.id);
          this._dispatch(entry.chatUri, action, origin);
          return;
        }
        case 'chat/toolCallConfirmed': {
          const req = [...t.requests.entries()].find(([, r]) => r.kind === 'permission' && r.toolCallId === action.toolCallId);
          if (!req) return fail('This approval is no longer pending');
          const [requestId] = req;
          const ok = await run('permission', { requestId, decision: SessionTranslator.permissionDecision(action.approved, action.selectedOptionId) });
          if (ok === false) return fail('Already answered on your PC');
          // The runtime's own "completed" event may have been translated already (it shares the pipe).
          if (!t.requests.has(requestId)) return;
          t.phoneConfirmed(requestId, !!action.approved);
          this._dispatch(entry.chatUri, action, origin);
          return;
        }
        case 'chat/inputAnswerChanged':
          this._dispatch(entry.chatUri, action, origin);
          return;
        case 'chat/draftChanged': {
          // A new model or model option chosen on a phone switches the runtime (the app's picker follows).
          const next = action.draft?.model;
          const cur = entry.chat.draft?.model;
          if (next?.id && JSON.stringify(toRuntime(this.models, next)) !== JSON.stringify(toRuntime(this.models, cur))) {
            await run('model', { model: toRuntime(this.models, next) });
            entry.translator.model = next;
          }
          this._dispatch(entry.chatUri, action, origin);
          return;
        }
        case 'chat/inputCompleted': {
          const req = t.pendingRequest(action.requestId);
          if (!req) return fail('This question is no longer open');
          const r = SessionTranslator.inputResolution(req, action.response, action.answers);
          if (!r) return fail('Unsupported question');
          const ok = await run(r.op, { requestId: action.requestId, response: r.response });
          if (ok === false) return fail('Already answered on your PC');
          if (!t.requests.has(action.requestId)) return;
          t.phoneAnswered(action.requestId);
          this._dispatch(entry.chatUri, action, origin);
          return;
        }
        case 'chat/turnCancelled': {
          const turn = t.turn;
          if (!turn || turn.id !== action.turnId) return fail('Nothing is running');
          if (t.phoneTurn && t.phoneTurn.turnId === turn.id && !turn.bound) {
            t.turn = null;
            t.phoneTurn = null;
            this._dispatch(entry.chatUri, action, origin);
          }
          turn.aborted = true;
          await run('abort', {});
          return;
        }
        case 'session/configChanged': {
          const c = action.config || {};
          if (c.mode !== undefined) {
            if (!SESSION_CONFIG_SCHEMA.properties.mode.enum.includes(c.mode)) return fail('Unknown mode');
            await run('mode', { mode: c.mode });
          }
          if (c.autoApprove !== undefined) {
            if (!SESSION_CONFIG_SCHEMA.properties.autoApprove.enum.includes(c.autoApprove)) return fail('Unknown approval setting');
            await run('approvals', { mode: c.autoApprove === 'autoApprove' ? 'allow-all' : c.autoApprove === 'assisted' ? 'assisted' : 'manual' });
          }
          const known = Object.fromEntries(Object.entries(c).filter(([k]) => k === 'mode' || k === 'autoApprove'));
          this._dispatch(entry.uri, { ...action, config: known }, origin);
          return;
        }
        case 'session/titleChanged': {
          const title = String(action.title || '').trim().slice(0, 200);
          if (!title) return fail('Enter a title');
          await run('rename', { name: title });
          this._dispatch(entry.uri, { ...action, title }, origin);
          this._summary(entry, { title });
          return;
        }
        case 'session/isReadChanged':
        case 'session/isArchivedChanged':
          this._dispatch(entry.uri, action, origin);
          this._syncStatus(entry);
          return;
        default:
          return fail(`"${action.type}" is not supported for GitHub Copilot app sessions yet`);
      }
    } catch (err) {
      return fail(err);
    }
  }

  /** Sends the next queued phone message once the agent is idle (AHP queue semantics). */
  _drainQueue(entry) {
    const t = entry.translator;
    if (t.activeTurnId || !entry.queue.length || entry.draining) return;
    const q = entry.queue.shift();
    entry.draining = true;
    const turnId = `q-${q.id}`;
    const startedAt = new Date().toISOString();
    this._dispatch(entry.chatUri, { type: 'chat/pendingMessageRemoved', kind: 'queued', id: q.id });
    this._dispatch(entry.chatUri, { type: 'chat/turnStarted', turnId, startedAt, message: { text: q.text, origin: { kind: 'user' }, ...(q.model ? { model: q.model } : {}), ...(q.attachments?.length ? { attachments: q.attachments } : {}) }, queuedMessageId: q.id });
    t.beginPhoneTurn({ turnId, text: q.text, startedAt });
    entry.bridge.request('send', { prompt: q.text, model: toRuntime(this.models, q.model), attachments: q.attachments }).catch((err) => {
      if (t.activeTurnId === turnId) {
        t.turn = null;
        t.phoneTurn = null;
        this._dispatch(entry.chatUri, { type: 'chat/error', turnId, duration: 0, part: { kind: 'error', error: { errorType: 'send', message: `Could not send: ${err.message}` }, resumable: false } });
      }
    }).finally(() => {
      entry.draining = false;
    });
  }
}

function toUri(p) {
  try {
    return new URL(`file://${p.startsWith('/') ? '' : '/'}${p.replace(/\\/g, '/')}`).href.replace(/^file:\/\/\/([A-Za-z]):/, (m, d) => `file:///${d.toLowerCase()}%3A`);
  } catch {
    return `file:///${encodeURIComponent(p)}`;
  }
}

export { toUri, S as STATUS };
