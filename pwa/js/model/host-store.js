// Live mirror of one PC's agent host: session list, subscribed sessions and chats, and the
// user actions the phone can take. State is reduced with the official AHP reducers, so the
// phone renders exactly what VS Code renders.
import { AhpClient } from '../../vendor/ahp/client/index.js';
import { rootReducer, sessionReducer, chatReducer, SUPPORTED_PROTOCOL_VERSIONS } from '../../vendor/ahp/types/index.js';
import { S, has, uuid } from '../lib/format.js';

const ROOT = 'ahp-root://';
const DEFAULT_UNSUB_DELAY = 45000;

export class HostStore extends EventTarget {
  /** @param {import('../net/host-connection.js').HostConnection} conn */
  constructor(conn, { unsubscribeDelayMs = DEFAULT_UNSUB_DELAY } = {}) {
    super();
    this.unsubDelay = unsubscribeDelayMs;
    this.conn = conn;
    this.clientId = `pocket-pilot-${uuid().slice(0, 13)}`;
    this.client = null;
    this.initialized = false;
    this.lastSeq = 0;
    this.root = null;
    this.defaultDirectory = null;
    this.sessions = new Map();
    this.sessionsLoaded = false;
    this.sessionState = new Map();
    this.chatState = new Map();
    this.snapshotSeq = new Map();
    this.pending = new Map();
    this.watchers = new Map();
    this.subscribed = new Set();
    this._chatFor = new Map();
    this.kinds = new Map();
    this.unsubTimers = new Map();
    this.localTurns = new Map();
    this.draftModels = new Map();
    this.errors = [];
    this.ahpConnected = false;
    this.ahpReason = '';
    this.onReady = (e) => this._onReady(e.detail).catch((err) => this._error(`Could not load sessions: ${err.message}`));
    this.onControl = (e) => {
      const m = e.detail.message;
      if (m.t === 'ahp.status') {
        this.ahpConnected = !!m.connected;
        this.ahpReason = m.reason || '';
        this._emit('status');
      }
    };
    this.onState = () => this._emit('status');
    conn.addEventListener('ready', this.onReady);
    conn.addEventListener('control', this.onControl);
    conn.addEventListener('state', this.onState);
  }

  dispose() {
    this.conn.removeEventListener('ready', this.onReady);
    this.conn.removeEventListener('control', this.onControl);
    this.conn.removeEventListener('state', this.onState);
    this.client?.shutdown().catch(() => {});
  }

  _emit(kind, uri) {
    this._v = (this._v || 0) + 1;
    this.dispatchEvent(new CustomEvent('change', { detail: { kind, uri } }));
  }

  _error(message) {
    this.errors.push({ id: uuid(), message, at: Date.now() });
    if (this.errors.length > 5) this.errors.shift();
    this._emit('error');
  }

  get online() {
    return this.conn.state === 'online' && !!this.client;
  }

  // ------------------------------------------------------------------ connection

  async _onReady({ transport }) {
    this.client?.shutdown().catch(() => {});
    const client = new AhpClient(transport, { requestTimeoutMs: 45000 });
    this.client = client;
    client.connect();
    const events = client.events();
    this._pump(client, events);
    const subs = [ROOT, ...this.subscribed];
    let done = false;
    if (this.initialized) {
      try {
        const r = await client.reconnect({ clientId: this.clientId, lastSeenServerSeq: this.lastSeq, subscriptions: subs });
        if (r.type === 'replay') {
          for (const env of r.actions || []) this._apply(env);
          for (const uri of r.missing || []) {
            this.subscribed.delete(uri);
            this._drop(uri);
          }
        } else {
          // A snapshot restarts the sequence (the PC may be a new process with its own numbering).
          const seqs = (r.snapshots || []).map((s) => s.fromSeq).filter((n) => typeof n === 'number');
          if (seqs.length) this.lastSeq = Math.max(...seqs);
          for (const snap of r.snapshots || []) this._applySnapshot(snap);
        }
        done = true;
      } catch {
        this.clientId = `pocket-pilot-${uuid().slice(0, 13)}`;
      }
    }
    if (!done) {
      const init = await client.initialize({
        clientId: this.clientId,
        protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        initialSubscriptions: subs,
        locale: navigator.language,
      });
      this.lastSeq = init.serverSeq || 0;
      this.defaultDirectory = init.defaultDirectory || this.defaultDirectory;
      for (const snap of init.snapshots || []) this._applySnapshot(snap);
      this.initialized = true;
    }
    this.ahpConnected = true;
    await this.refreshSessions();
    this._emit('status');
  }

  async _pump(client, events) {
    try {
      for await (const { channel, event } of events) {
        if (client !== this.client) break;
        const p = event.params;
        if (event.type === 'action') this._apply(p);
        else if (event.type === 'sessionAdded') {
          this.sessions.set(p.summary.resource, p.summary);
          this._emit('sessions');
        } else if (event.type === 'sessionRemoved') {
          this.sessions.delete(p.session);
          this._emit('sessions');
        } else if (event.type === 'sessionSummaryChanged') {
          const prev = this.sessions.get(p.session);
          if (prev) this.sessions.set(p.session, { ...prev, ...p.changes });
          this._emit('sessions', p.session);
        }
        void channel;
      }
    } catch {
      /* transport closed */
    }
  }

  async refreshSessions() {
    if (!this.client) return;
    const r = await this.client.request('listSessions', { channel: ROOT });
    this.sessions = new Map((r.items || []).map((s) => [s.resource, s]));
    this.sessionsLoaded = true;
    this._emit('sessions');
  }

  // ------------------------------------------------------------------ state

  _kind(uri) {
    return this.kinds.get(uri) || (uri.startsWith('ahp-chat:') ? 'chat' : 'session');
  }

  _applySnapshot(snap) {
    const uri = snap.resource;
    if (uri === ROOT) {
      this.root = snap.state;
      this._emit('root');
      return;
    }
    const kind = this._kind(uri);
    (kind === 'chat' ? this.chatState : this.sessionState).set(uri, snap.state);
    this.snapshotSeq.set(uri, snap.fromSeq ?? 0);
    const queued = this.pending.get(uri) || [];
    this.pending.delete(uri);
    for (const env of queued) this._apply(env);
    if (kind === 'session') this._ensureChat(uri);
    this._emit(kind, uri);
  }

  _apply(env) {
    if (env.serverSeq > this.lastSeq) this.lastSeq = env.serverSeq;
    if (env.action?.type === 'chat/draftChanged' && this.draftModels.delete(env.channel)) this._emit('chat', env.channel);
    if (env.rejectionReason) {
      if (env.origin?.clientId === this.clientId) this._error(`The PC rejected that action: ${env.rejectionReason}`);
      return;
    }
    const uri = env.channel;
    if (uri === ROOT) {
      if (this.root) {
        this.root = rootReducer(this.root, env.action);
        this._emit('root');
      }
      return;
    }
    const kind = this._kind(uri);
    const map = kind === 'chat' ? this.chatState : this.sessionState;
    const cur = map.get(uri);
    if (!cur) {
      if (this.subscribed.has(uri)) {
        const q = this.pending.get(uri) || [];
        q.push(env);
        this.pending.set(uri, q);
      }
      return;
    }
    if (env.serverSeq <= (this.snapshotSeq.get(uri) ?? -1)) return;
    try {
      map.set(uri, kind === 'chat' ? chatReducer(cur, env.action) : sessionReducer(cur, env.action));
    } catch (err) {
      console.warn('reducer failed', env.action?.type, err);
      return;
    }
    if (kind === 'chat' && env.action.type === 'chat/turnStarted') this.localTurns.delete(env.action.turnId);
    if (kind === 'session' && /^session\/(chatAdded|defaultChatChanged|ready)$/.test(env.action.type)) this._ensureChat(uri);
    this._emit(kind, uri);
  }

  _drop(uri) {
    this.sessionState.delete(uri);
    this.chatState.delete(uri);
    this.snapshotSeq.delete(uri);
  }

  // ------------------------------------------------------------------ subscriptions
  // Sessions are ref-counted by the screens watching them. A watched session owns exactly one
  // chat subscription (its default chat); `subscribed` holds every URI subscribed on the wire.

  _subscribe(uri, kind) {
    this.kinds.set(uri, kind);
    if (this.subscribed.has(uri)) return;
    this.subscribed.add(uri);
    if (this.client) {
      const client = this.client;
      client.subscribe(uri).then(({ result, subscription }) => {
        subscription.close();
        if (client === this.client && result?.snapshot) this._applySnapshot(result.snapshot);
      }).catch((err) => {
        this.subscribed.delete(uri);
        this._error(`Could not open ${kind}: ${err.message}`);
      });
    }
  }

  _release(uri) {
    if (!this.subscribed.delete(uri)) return;
    this.client?.unsubscribe(uri).catch(() => {});
    this._drop(uri);
  }

  /** Keeps the session and its default chat subscribed until the returned function is called. */
  watchSession(sessionUri) {
    const t = this.unsubTimers.get(sessionUri);
    if (t) {
      clearTimeout(t);
      this.unsubTimers.delete(sessionUri);
    }
    this.watchers.set(sessionUri, (this.watchers.get(sessionUri) || 0) + 1);
    this._subscribe(sessionUri, 'session');
    this._ensureChat(sessionUri);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.watchers.get(sessionUri) || 1) - 1;
      this.watchers.set(sessionUri, n);
      if (n > 0) return;
      this.unsubTimers.set(sessionUri, setTimeout(() => {
        this.unsubTimers.delete(sessionUri);
        if ((this.watchers.get(sessionUri) || 0) > 0) return;
        this.watchers.delete(sessionUri);
        const chat = this._chatFor.get(sessionUri);
        this._chatFor.delete(sessionUri);
        this._release(sessionUri);
        if (chat) this._release(chat);
      }, this.unsubDelay));
    };
  }

  _ensureChat(sessionUri) {
    if (!this.watchers.has(sessionUri)) return;
    const st = this.sessionState.get(sessionUri);
    const chat = st?.defaultChat || st?.chats?.[0]?.resource;
    if (!chat) return;
    const prev = this._chatFor.get(sessionUri);
    if (prev && prev !== chat) this._release(prev);
    this._chatFor.set(sessionUri, chat);
    this._subscribe(chat, 'chat');
  }

  chatFor(sessionUri) {
    const st = this.sessionState.get(sessionUri);
    return this._chatFor.get(sessionUri) || st?.defaultChat || st?.chats?.[0]?.resource || null;
  }

  // ------------------------------------------------------------------ queries

  agents() {
    return this.root?.agents || [];
  }

  models(provider) {
    return this.agents().find((a) => a.provider === provider)?.models || [];
  }

  sortedSessions() {
    const arr = [...this.sessions.values()].filter((s) => !has(s.status, S.IsArchived));
    const rank = (s) => (has(s.status, S.Input) ? 0 : has(s.status, S.InProgress) ? 1 : 2);
    return arr.sort((a, b) => rank(a) - rank(b) || String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  }

  recentFolders() {
    const seen = new Map();
    for (const s of [...this.sessions.values()].sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))) {
      for (const d of s.workingDirectories || []) if (!seen.has(d)) seen.set(d, s.modifiedAt);
    }
    return [...seen.keys()];
  }

  // ------------------------------------------------------------------ actions

  _dispatch(channel, action) {
    if (!this.client) throw new Error('Not connected to your PC');
    this.client.dispatch(channel, action);
  }

  /**
   * The model (with its options) the chat's next message uses. It is the chat's shared draft — the
   * same selection VS Code's model picker shows — so both sides always agree.
   */
  modelFor(chat) {
    const pending = this.draftModels.get(chat);
    if (pending && Date.now() - pending.at < 15000) return pending.model;
    const cs = this.chatState.get(chat);
    if (cs?.draft?.model) return cs.draft.model;
    const last = [...(cs?.turns || [])].reverse().find((t) => t.message?.model)?.message.model;
    return cs?.activeTurn?.message?.model || last || null;
  }

  /** Picks the model and its options for the chat on every client (VS Code's picker follows). */
  setModel(chat, model) {
    const cs = this.chatState.get(chat);
    if (!cs) throw new Error('This session is still loading');
    const draft = { ...(cs.draft || { text: '', origin: { kind: 'user' } }), model };
    this.draftModels.set(chat, { model, at: Date.now() });
    this._dispatch(chat, { type: 'chat/draftChanged', draft });
    this._emit('chat', chat);
  }

  sendMessage(sessionUri, { text, attachments, model }) {
    const chat = this.chatFor(sessionUri);
    if (!chat) throw new Error('This session is still loading');
    const cs = this.chatState.get(chat);
    const message = { text, origin: { kind: 'user' } };
    if (attachments?.length) message.attachments = attachments;
    if (model) message.model = model;
    if (cs?.activeTurn) {
      this._dispatch(chat, { type: 'chat/pendingMessageSet', kind: 'queued', id: uuid(), message });
      return 'queued';
    }
    const turnId = uuid();
    this.localTurns.set(turnId, { chat, message, at: Date.now() });
    this._dispatch(chat, { type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message });
    this._emit('chat', chat);
    return 'sent';
  }

  /** Adds guidance to the running turn (VS Code's "Steer with Message"). */
  steer(sessionUri, { text, attachments }) {
    const chat = this.chatFor(sessionUri);
    if (!chat) throw new Error('This session is still loading');
    const message = { text, origin: { kind: 'user' } };
    if (attachments?.length) message.attachments = attachments;
    this._dispatch(chat, { type: 'chat/pendingMessageSet', kind: 'steering', id: uuid(), message });
  }

  /**
   * Stops the running turn, then sends the message as a new turn — what VS Code's "Stop and Send" does.
   * (Not through the queue: VS Code's agent host only drains it after a turn that finished normally.)
   */
  stopAndSend(sessionUri, { text, attachments, model }, { timeoutMs = 15000 } = {}) {
    const chat = this.chatFor(sessionUri);
    if (!chat) throw new Error('This session is still loading');
    const turn = this.chatState.get(chat)?.activeTurn;
    const send = () => this.sendMessage(sessionUri, { text, attachments, model });
    if (!turn) return Promise.resolve(send());
    return new Promise((resolve, reject) => {
      let timer = null;
      let done = false;
      const stopped = () => this.chatState.get(chat)?.activeTurn?.id !== turn.id;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.removeEventListener('change', onChange);
        try {
          resolve(send());
        } catch (err) {
          reject(err);
        }
      };
      // Deferred: the host may confirm the stop while it is still handling it.
      const onChange = (e) => {
        if (e.detail.uri === chat && stopped()) queueMicrotask(finish);
      };
      this.addEventListener('change', onChange);
      // The PC never confirmed the stop (e.g. the connection dropped): the message goes to the queue.
      timer = setTimeout(finish, timeoutMs);
      try {
        this.cancelTurn(chat);
      } catch (err) {
        done = true;
        clearTimeout(timer);
        this.removeEventListener('change', onChange);
        reject(err);
        return;
      }
      if (stopped()) queueMicrotask(finish);
    });
  }

  removePending(chat, kind, id) {
    this._dispatch(chat, { type: 'chat/pendingMessageRemoved', kind, id });
  }

  confirmTool(chat, turnId, toolCallId, approved, option) {
    if (approved) this._dispatch(chat, { type: 'chat/toolCallConfirmed', turnId, toolCallId, approved: true, confirmed: 'user-action', ...(option ? { selectedOptionId: option } : {}) });
    else this._dispatch(chat, { type: 'chat/toolCallConfirmed', turnId, toolCallId, approved: false, reason: 'denied', ...(option ? { selectedOptionId: option } : {}) });
  }

  confirmResult(chat, turnId, toolCallId, approved) {
    this._dispatch(chat, { type: 'chat/toolCallResultConfirmed', turnId, toolCallId, approved });
  }

  answerInput(chat, requestId, response, answers) {
    this._dispatch(chat, { type: 'chat/inputCompleted', requestId, response, ...(answers ? { answers } : {}) });
  }

  cancelTurn(chat) {
    const t = this.chatState.get(chat)?.activeTurn;
    if (!t) return;
    this._dispatch(chat, { type: 'chat/turnCancelled', turnId: t.id, duration: Math.max(0, Date.now() - Date.parse(t.startedAt || new Date().toISOString())) });
  }

  resumeTurn(chat, turnId) {
    this._dispatch(chat, { type: 'chat/turnResume', turnId });
  }

  setConfig(sessionUri, config) {
    this._dispatch(sessionUri, { type: 'session/configChanged', config });
  }

  markRead(sessionUri) {
    const s = this.sessions.get(sessionUri);
    if (s && !has(s.status, S.IsRead)) this._dispatch(sessionUri, { type: 'session/isReadChanged', isRead: true });
  }

  rename(sessionUri, title) {
    this._dispatch(sessionUri, { type: 'session/titleChanged', title });
  }

  archive(sessionUri, archived = true) {
    this._dispatch(sessionUri, { type: 'session/isArchivedChanged', isArchived: archived });
  }

  async loadOlder(chat) {
    const cursor = this.chatState.get(chat)?.turnsNextCursor;
    if (!cursor || !this.client) return;
    await this.client.request('fetchTurns', { channel: chat, cursor });
  }

  async listDirectory(uri) {
    const r = await this.client.request('resourceList', { channel: ROOT, uri });
    return (r.entries || []).filter((e) => e.type === 'directory' && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  }

  async readFile(uri) {
    return this.client.request('resourceRead', { channel: ROOT, uri });
  }

  /** Creates a session, waits until it is ready and sends the first message. */
  async createSession({ provider, folder, config, text, model, attachments }) {
    if (!this.client) throw new Error('Not connected to your PC');
    const uri = `${provider}:/${uuid()}`;
    await this.client.request('createSession', { channel: uri, provider, workingDirectories: [folder], ...(config ? { config } : {}) });
    const stop = this.watchSession(uri);
    try {
      const chat = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.removeEventListener('change', check);
          reject(new Error('The new session did not open in time'));
        }, 60000);
        const check = () => {
          const st = this.sessionState.get(uri);
          if (st?.lifecycle === 'creationFailed') {
            clearTimeout(timer);
            this.removeEventListener('change', check);
            reject(new Error(st.creationError?.message || 'The PC could not create the session'));
            return;
          }
          const c = this.chatFor(uri);
          // VS Code's host materialises the backend lazily on the first turn, so a session can
          // stay in 'creating' until we send the first message; the default chat exists already.
          if (st && c && this.chatState.get(c)) {
            clearTimeout(timer);
            this.removeEventListener('change', check);
            resolve(c);
          }
        };
        this.addEventListener('change', check);
        check();
      });
      if (text) this.sendMessage(uri, { text, model, attachments });
      void chat;
      return uri;
    } finally {
      setTimeout(stop, 1000);
    }
  }

  async disposeSession(uri) {
    await this.client.request('disposeSession', { channel: uri });
    this.sessions.delete(uri);
    this._emit('sessions');
  }
}
