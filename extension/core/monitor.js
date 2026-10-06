'use strict';
// The extension's own AHP client: watches the session list and turns status transitions
// ("needs input", "finished", "error") into notifications for paired phones.
const { EventEmitter } = require('events');
const path = require('path');
const { pathToFileURL } = require('url');
const agentHost = require('./agentHost');

const BIT = { Idle: 1, Error: 2, InProgress: 8, Input: 16, IsRead: 32, IsArchived: 64 };
const VENDOR = path.join(__dirname, '..', '..', 'pwa', 'vendor', 'ahp');
const PROTOCOL = path.join(__dirname, '..', '..', 'pwa', 'js', 'core', 'protocol.js');

let ahpPromise;
function loadAhp() {
  if (!ahpPromise) {
    ahpPromise = Promise.all([
      import(pathToFileURL(path.join(VENDOR, 'client', 'index.js')).href),
      import(pathToFileURL(path.join(VENDOR, 'types', 'index.js')).href),
      import(pathToFileURL(PROTOCOL).href),
    ]).then(([c, t, p]) => ({ AhpClient: c.AhpClient, SUPPORTED: p.PROTOCOL_VERSIONS, sessionReducer: t.sessionReducer }));
  }
  return ahpPromise;
}

const ACTIVITY = 31;

/**
 * A session's real state for people: its main chat's activity, promoting "needs input" from any chat.
 * The protocol also promotes an error from *any* chat (for example a sub-agent that failed long ago)
 * to the whole session, which would show a working session as failed.
 */
function effectiveStatus(raw, state) {
  const chats = state?.chats || [];
  if (typeof raw !== 'number' || !chats.length) return raw;
  const main = chats.find((c) => c.resource === state.defaultChat) || [...chats].sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))[0];
  if (!main || typeof main.status !== 'number') return raw;
  let activity = main.status & ACTIVITY;
  if (chats.some((c) => typeof c.status === 'number' && (c.status & BIT.Input) === BIT.Input)) activity = BIT.Input;
  return (raw & ~ACTIVITY) | (activity || BIT.Idle);
}

/** Plain text from AHP StringOrMarkdown. */
function plain(v, max = 200) {
  let s = typeof v === 'string' ? v : v && typeof v.markdown === 'string' ? v.markdown : '';
  s = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const has = (s, bit) => (s & bit) === bit;

class SessionMonitor extends EventEmitter {
  /** @param {{getEndpoint: () => object|null, log?: (l:string,m:string)=>void}} o */
  constructor(o) {
    super();
    this.o = o;
    this.log = o.log || (() => {});
    this.sessions = new Map();
    this.connected = false;
    this.stopped = true;
    this.client = null;
    this.conn = null;
    // Sessions whose summary says "error": their session state tells whether that is really the case.
    this.tracked = new Map();
    this.effective = new Map();
    this.pushed = new Map();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._loop();
  }

  stop() {
    this.stopped = true;
    if (this.conn) this.conn.close();
    if (this._wake) this._wake();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this._wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  _setConnected(v, reason) {
    if (this.connected === v) return;
    this.connected = v;
    this.emit('status', { connected: v, reason });
  }

  async _loop() {
    let backoff = 2000;
    while (!this.stopped) {
      const ep = this.o.getEndpoint();
      if (ep) {
        try {
          await this._run(ep);
          backoff = 2000;
        } catch (err) {
          this.log('warn', `Agent host monitor: ${err.message}`);
        }
      }
      this._setConnected(false, ep ? 'disconnected' : 'VS Code agent host not found');
      if (this.stopped) break;
      await this._sleep(backoff);
      backoff = Math.min(30000, backoff * 1.6);
    }
  }

  async _run(ep) {
    const { AhpClient, SUPPORTED, sessionReducer } = await loadAhp();
    this.sessionReducer = sessionReducer;
    const conn = await (this.o.openConnection ? this.o.openConnection(ep) : agentHost.openConnection(ep));
    this.conn = conn;
    const client = new AhpClient(agentHost.transportFor(conn), { requestTimeoutMs: 30000 });
    this.client = client;
    this.tracked.clear();
    client.connect();
    try {
      const init = await client.initialize({
        clientId: `pocket-pilot-monitor-${process.pid}-${Date.now().toString(36)}`,
        protocolVersions: [...SUPPORTED],
        initialSubscriptions: ['ahp-root://'],
      });
      const root = init.snapshots.find((s) => s.resource === 'ahp-root://')?.state;
      this._setAgents(root?.agents || []);
      this.defaultDirectory = init.defaultDirectory;
      const { items } = await client.request('listSessions', { channel: 'ahp-root://' });
      this.sessions = new Map(items.map((s) => [s.resource, s]));
      for (const s of items) {
        this.effective.set(s.resource, s.status);
        this._maybeTrack(s);
      }
      this._setConnected(true);
      this.emit('sessions');
      const closed = new Promise((resolve) => conn.on('close', resolve));
      const pump = (async () => {
        for await (const ev of client.events()) this._onEvent(ev);
      })();
      await Promise.race([closed, pump]);
    } finally {
      this.client = null;
      this.conn = null;
      await client.shutdown().catch(() => {});
    }
  }

  _setAgents(agents) {
    this.agents = agents;
  }

  _onEvent({ channel, event }) {
    const p = event.params;
    if (event.type === 'sessionAdded') {
      this.sessions.set(p.summary.resource, p.summary);
      this.effective.set(p.summary.resource, this.statusFor(p.summary.resource, p.summary.status));
      this._maybeTrack(p.summary);
      this.emit('sessions');
    } else if (event.type === 'sessionRemoved') {
      this.sessions.delete(p.session);
      this._untrack(p.session);
      this.effective.delete(p.session);
      this.pushed.delete(p.session);
      this.emit('sessions');
    } else if (event.type === 'sessionSummaryChanged') {
      const prev = this.sessions.get(p.session);
      const next = { ...(prev || { resource: p.session }), ...p.changes };
      this.sessions.set(p.session, next);
      this._maybeTrack(next);
      this._settle(p.session, next);
      this.emit('sessions');
    } else if (event.type === 'action' && channel === 'ahp-root://' && p.action?.type === 'root/agentsChanged') {
      this._setAgents(p.action.agents || []);
    } else if (event.type === 'action' && this.tracked.has(channel)) {
      const t = this.tracked.get(channel);
      if (!this.sessionReducer) return;
      if (!t.state) {
        // The snapshot is on its way: keep the action and apply it once the snapshot is in (see _track).
        if (t.pending.length < 1000) t.pending.push(p);
        return;
      }
      if (typeof p.serverSeq === 'number' && p.serverSeq <= t.fromSeq) return;
      try {
        t.state = this.sessionReducer(t.state, p.action);
      } catch {
        return;
      }
      const s = this.sessions.get(channel);
      if (s) this._settle(channel, s);
    }
  }

  /** The status a person should see for a session (see `effectiveStatus`). */
  statusFor(uri, raw) {
    if (typeof raw !== 'number' || (raw & ACTIVITY) !== BIT.Error) return raw;
    const t = this.tracked.get(uri);
    if (t?.state) return effectiveStatus(raw, t.state);
    // Not known yet: keep what the session was doing (an error from a sub-agent must not look like a failure).
    const prev = this.effective.get(uri);
    return typeof prev === 'number' && (prev & ACTIVITY) !== BIT.Error ? (raw & ~ACTIVITY) | (prev & ACTIVITY) : raw;
  }

  /** A session summary with its status corrected, for clients (returns the same object if unchanged). */
  adjustSummary(summary) {
    if (!summary || typeof summary.status !== 'number') return summary;
    const status = this.statusFor(summary.resource, summary.status);
    return status === summary.status ? summary : { ...summary, status };
  }

  _settle(uri, summary) {
    const next = this.statusFor(uri, summary.status);
    const prev = this.effective.get(uri);
    this.effective.set(uri, next);
    if (prev !== undefined && prev !== next) this._detect({ ...summary, status: prev }, { ...summary, status: next });
    // Clients only see summary changes: tell them when the corrected status moves on its own.
    if (this.tracked.get(uri)?.state && this.pushed.get(uri) !== next) {
      this.pushed.set(uri, next);
      this.emit('effective', { uri, status: next });
    }
  }

  _maybeTrack(summary) {
    const uri = summary?.resource;
    if (!uri) return;
    const erroring = typeof summary.status === 'number' && (summary.status & ACTIVITY) === BIT.Error;
    if (erroring && !this.tracked.has(uri)) this._track(uri);
    else if (!erroring && this.tracked.has(uri)) this._untrack(uri);
  }

  _track(uri) {
    const client = this.client;
    if (!client) return;
    const t = { state: null, fromSeq: -1, pending: [] };
    this.tracked.set(uri, t);
    client.subscribe(uri).then(({ result, subscription }) => {
      subscription.close();
      if (client !== this.client || this.tracked.get(uri) !== t) return;
      const snap = result?.snapshot;
      let state = snap?.state || null;
      t.fromSeq = typeof snap?.fromSeq === 'number' ? snap.fromSeq : -1;
      // Actions that arrived with (or right after) the snapshot, before this callback ran.
      if (state && this.sessionReducer) {
        for (const p of t.pending) {
          if (typeof p.serverSeq === 'number' && p.serverSeq <= t.fromSeq) continue;
          try {
            state = this.sessionReducer(state, p.action);
          } catch {
            /* skip an action the reducer rejects */
          }
        }
      }
      t.pending = [];
      t.state = state;
      const s = this.sessions.get(uri);
      if (s) this._settle(uri, s);
    }).catch(() => {
      if (this.tracked.get(uri) === t) this.tracked.delete(uri);
    });
  }

  _untrack(uri) {
    if (!this.tracked.delete(uri)) return;
    this.pushed.delete(uri);
    this.client?.unsubscribe(uri).catch(() => {});
  }

  _detect(prev, next) {
    const a = prev.status;
    const b = next.status;
    if (a === b || typeof b !== 'number') return;
    if (has(b, BIT.IsArchived)) return;
    let kind = null;
    if (!has(a, BIT.Input) && has(b, BIT.Input)) kind = 'input';
    else if (!has(a, BIT.Error) && has(b, BIT.Error)) kind = 'error';
    else if (has(a, BIT.InProgress) && !has(b, BIT.InProgress) && has(b, BIT.Idle)) kind = 'done';
    if (kind) this.emit('transition', { kind, session: next });
  }

  /** Temporarily subscribes to a channel to read its snapshot (tracked sessions are read in place). */
  async _peek(uri) {
    const client = this.client;
    if (!client) return null;
    const t = this.tracked.get(uri);
    if (t) {
      for (let i = 0; i < 30 && !t.state && this.tracked.get(uri) === t; i++) await new Promise((r) => setTimeout(r, 100));
      if (t.state) return t.state;
    }
    try {
      const { result } = await client.subscribe(uri);
      return result?.snapshot?.state || null;
    } catch {
      return null;
    } finally {
      if (!this.tracked.has(uri)) client.unsubscribe(uri).catch(() => {});
    }
  }

  /** Human text describing why a session is blocked. */
  async describeInput(sessionUri) {
    const st = await this._peek(sessionUri);
    let req = st?.inputNeeded?.[0];
    if (!req) {
      // Some hosts do not maintain the session-level roll-up: look at the default chat's active turn.
      const chat = st?.defaultChat || st?.chats?.[0]?.resource;
      const cs = chat ? await this._peek(chat) : null;
      for (const p of cs?.activeTurn?.responseParts || []) {
        if (p.kind === 'toolCall' && ['pending-confirmation', 'pending-result-confirmation'].includes(p.toolCall.status)) req = { kind: 'toolConfirmation', toolCall: p.toolCall, chat };
        else if (p.kind === 'inputRequest' && !p.response) req = { kind: 'chatInput', request: p.request, chat };
      }
    }
    if (!req) return { text: 'The agent is waiting for you.' };
    if (req.kind === 'toolConfirmation') {
      const tc = req.toolCall || {};
      const title = plain(tc.confirmationTitle, 60) || tc.displayName || 'Approve tool';
      return { text: `${title}: ${plain(tc.invocationMessage, 160) || tc.toolName}`, chat: req.chat, kind: 'tool' };
    }
    if (req.kind === 'chatInput') {
      const q = req.request?.questions?.[0];
      return { text: plain(req.request?.message || q?.title || q?.message, 180) || 'The agent has a question for you.', chat: req.chat, kind: 'question' };
    }
    if (req.kind === 'toolAuthentication') return { text: `Sign-in required for ${req.toolCall?.displayName || 'a tool'}.`, chat: req.chat, kind: 'auth' };
    return { text: 'The agent is waiting for you.', chat: req.chat };
  }

  /** Last assistant sentence of the most recent turn. */
  async describeDone(sessionUri) {
    const st = await this._peek(sessionUri);
    const chat = st?.defaultChat || st?.chats?.[0]?.resource;
    if (!chat) return { text: 'Finished.' };
    const cs = await this._peek(chat);
    const turn = cs?.turns?.[cs.turns.length - 1];
    const md = turn ? [...turn.responseParts].reverse().find((p) => p.kind === 'markdown' && p.content?.trim()) : null;
    return { text: md ? plain(md.content, 220) : 'Finished.', chat };
  }

  counts() {
    let inputNeeded = 0;
    let running = 0;
    for (const s of this.sessions.values()) {
      const st = this.statusFor(s.resource, s.status);
      if (has(st, BIT.IsArchived)) continue;
      if (has(st, BIT.Input)) inputNeeded++;
      else if (has(st, BIT.InProgress)) running++;
    }
    return { total: this.sessions.size, inputNeeded, running };
  }

  /** Working directories of known sessions (used to restrict phone file reads). */
  workingDirectories() {
    const dirs = new Set();
    for (const s of this.sessions.values()) for (const d of s.workingDirectories || []) dirs.add(d);
    return [...dirs];
  }
}

module.exports = { SessionMonitor, plain, BIT, effectiveStatus };
