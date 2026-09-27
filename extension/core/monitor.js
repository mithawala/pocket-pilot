'use strict';
// The extension's own AHP client: watches the session list and turns status transitions
// ("needs input", "finished", "error") into notifications for paired phones.
const { EventEmitter } = require('events');
const path = require('path');
const { pathToFileURL } = require('url');
const agentHost = require('./agentHost');

const BIT = { Idle: 1, Error: 2, InProgress: 8, Input: 16, IsRead: 32, IsArchived: 64 };
const VENDOR = path.join(__dirname, '..', '..', 'pwa', 'vendor', 'ahp');

let ahpPromise;
function loadAhp() {
  if (!ahpPromise) {
    ahpPromise = Promise.all([
      import(pathToFileURL(path.join(VENDOR, 'client', 'index.js')).href),
      import(pathToFileURL(path.join(VENDOR, 'types', 'index.js')).href),
    ]).then(([c, t]) => ({ AhpClient: c.AhpClient, SUPPORTED: t.SUPPORTED_PROTOCOL_VERSIONS }));
  }
  return ahpPromise;
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
    this.protectedResources = [];
    this.connected = false;
    this.stopped = true;
    this.client = null;
    this.conn = null;
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
    const { AhpClient, SUPPORTED } = await loadAhp();
    const conn = await agentHost.openConnection(ep);
    this.conn = conn;
    const client = new AhpClient(agentHost.transportFor(conn), { requestTimeoutMs: 30000 });
    this.client = client;
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
    const seen = new Map();
    for (const a of agents) for (const r of a.protectedResources || []) if (!seen.has(r.resource)) seen.set(r.resource, r);
    this.protectedResources = [...seen.values()];
    this.agents = agents;
  }

  _onEvent({ channel, event }) {
    const p = event.params;
    if (event.type === 'sessionAdded') {
      this.sessions.set(p.summary.resource, p.summary);
      this.emit('sessions');
    } else if (event.type === 'sessionRemoved') {
      this.sessions.delete(p.session);
      this.emit('sessions');
    } else if (event.type === 'sessionSummaryChanged') {
      const prev = this.sessions.get(p.session);
      const next = { ...(prev || { resource: p.session }), ...p.changes };
      this.sessions.set(p.session, next);
      if (prev) this._detect(prev, next);
      this.emit('sessions');
    } else if (event.type === 'action' && channel === 'ahp-root://' && p.action?.type === 'root/agentsChanged') {
      this._setAgents(p.action.agents || []);
    }
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

  /** Temporarily subscribes to a channel to read its snapshot. */
  async _peek(uri) {
    const client = this.client;
    if (!client) return null;
    try {
      const { result } = await client.subscribe(uri);
      return result?.snapshot?.state || null;
    } catch {
      return null;
    } finally {
      client.unsubscribe(uri).catch(() => {});
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
      if (has(s.status, BIT.IsArchived)) continue;
      if (has(s.status, BIT.Input)) inputNeeded++;
      else if (has(s.status, BIT.InProgress)) running++;
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

module.exports = { SessionMonitor, plain, BIT };
