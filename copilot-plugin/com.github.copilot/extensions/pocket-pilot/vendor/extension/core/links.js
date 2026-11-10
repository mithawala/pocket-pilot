'use strict';
// Files and folders an agent links to in a chat (`[highlights](C:/Users/me/Downloads/highlights)`): a
// paired device may open them too, besides the session folders. The relay notes every local link in the
// chat content it passes to a device, so only what the agent showed can be opened, and a linked folder
// opens with what's inside it. Kept on disk, so the links in chats a device already loaded keep working
// after a restart.
//
// Only what the agent wrote counts. Not what a client sent (a device, VS Code's window), and not what
// VS Code shows back from a message: it runs `!<command>` itself and shows the command, and answers
// `/rename <title>` with "Renamed: <title>". So nothing in a `!` turn counts, nor a link that is already
// in the turn's message. Network shares are never noted. No check here touches the disk: the relay looks
// up where a path really is (shortcuts, Windows short names) without blocking (RelayServer._files).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { isInside } = require('./attachments');

const PWA_CORE = path.join(__dirname, '..', '..', 'pwa', 'js', 'core');
let parserPromise;

/** Loads the link parser shared with the phone app (pwa/js/core/links.js). */
function loadLinkParser() {
  if (!parserPromise) parserPromise = import(pathToFileURL(path.join(PWA_CORE, 'links.js')).href);
  return parserPromise;
}

const MAX_PATHS = 20000;
// Streamed answers: the end of each part so far, so a link split across two pieces is still seen.
const MAX_TAILS = 300;
const TAIL_CHARS = 2000;
// The messages of the turns going on now (and recently), by chat and turn.
const MAX_TURNS = 500;
const SAVE_AFTER_MS = 2000;

const isNetworkPath = (p) => /^[\\/]{2}[^\\/]/.test(p);
// A terminal command VS Code runs itself: nothing in its turn is the agent's.
const isCommand = (typed) => /^\s*!/.test(typed);

class LinkedPaths {
  /**
   * @param {object} o
   * @param {{localLink: Function, linkTargets: Function}} o.parser  pwa/js/core/links.js
   * @param {string|null} [o.file]  where to keep them
   * @param {(p: string) => boolean} [o.covered]  paths a device may read anyway (in a session folder): not noted
   * @param {string} [o.home]  the home folder, which a link never opens (nor a whole drive)
   * @param {string} [o.platform]
   */
  constructor({ parser, file = null, covered = () => false, home = os.homedir(), platform = process.platform, log = () => {} }) {
    this.parser = parser;
    this.file = file;
    this.covered = covered;
    this.home = path.resolve(home);
    this.caseless = platform === 'win32';
    this.log = log;
    this.paths = new Map();
    this.tails = new Map();
    this.typed = new Map();
    this._timer = null;
    this._dirty = false;
    this._load();
  }

  _key(p) {
    return this.caseless ? p.toLowerCase() : p;
  }

  _load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const p of (Array.isArray(saved?.paths) ? saved.paths : []).slice(-MAX_PATHS)) if (typeof p === 'string' && path.isAbsolute(p) && !isNetworkPath(p)) this.paths.set(this._key(p), p);
    } catch {
      /* none yet */
    }
  }

  /** Writes the list now, if it changed. */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._dirty || !this.file) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, paths: [...this.paths.values()] }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log('warn', `Could not save the linked files: ${err.message}`);
    }
  }

  add(p) {
    const abs = path.resolve(p);
    const key = this._key(abs);
    if (this.paths.has(key)) {
      // Most recently linked last: the oldest go first when the list is full.
      this.paths.delete(key);
      this.paths.set(key, abs);
      return;
    }
    this.paths.set(key, abs);
    if (this.paths.size > MAX_PATHS) this.paths.delete(this.paths.keys().next().value);
    this._dirty = true;
    if (this.file && !this._timer) {
      this._timer = setTimeout(() => this.flush(), SAVE_AFTER_MS);
      this._timer.unref?.();
    }
  }

  /** A place a link never opens, even by itself: a whole drive, the home folder, or a folder that holds it. */
  broad(p) {
    return path.parse(p).root === p || isInside(this.home, p);
  }

  /**
   * A folder whose contents a link doesn't open: broad, or a folder of the home folder's app data and
   * sign-ins (.ssh, .aws, .config, AppData, Library, and the folders right in AppData and Library). A
   * link to a file in one of them still opens that file.
   */
  sensitive(p) {
    if (this.broad(p)) return true;
    const same = (a, b) => path.relative(a, b) === '';
    const parent = path.dirname(p);
    const name = path.basename(p);
    if (same(parent, this.home) && (name.startsWith('.') || /^(appdata|library)$/i.test(name))) return true;
    return same(path.dirname(parent), this.home) && /^(appdata|library)$/i.test(path.basename(parent));
  }

  /** The linked file or folder that lets a device open `p` (itself, or a folder it's in), or null. */
  grantFor(p) {
    return this._walk(p, (hit, exact) => !(exact ? this.broad(hit) : this.sensitive(hit)));
  }

  /** The linked folder that `p` is in (or is) but that opens too much (see broad, sensitive), if `p` doesn't open. */
  blockedBy(p) {
    if (this.grantFor(p)) return null;
    return this._walk(p, (hit, exact) => (exact ? this.broad(hit) : this.sensitive(hit)));
  }

  _walk(p, pick) {
    const abs = path.resolve(p);
    let cur = abs;
    for (;;) {
      const hit = this.paths.get(this._key(cur));
      if (hit && pick(hit, cur === abs)) return hit;
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }

  // ---------------------------------------------------------------- reading chat content

  /**
   * Notes the local links in some markdown the agent wrote. `typed` is the message of the turn it is in:
   * a link that is already in it is VS Code showing the message back, not the agent's.
   */
  scanText(text, typed = '') {
    if (typeof text !== 'string' || (!text.includes('](') && !text.includes(']:'))) return;
    if (isCommand(typed)) return;
    for (const { target, text: md } of this.parser.linkMatches(text)) {
      if (typed && typed.includes(md)) continue;
      const link = this.parser.localLink(target);
      if (!link?.uri) continue;
      let p;
      try {
        p = fileURLToPath(link.uri);
      } catch {
        continue; // not a path on this computer (a Mac path on Windows, say)
      }
      if (isNetworkPath(p)) continue;
      if (!this.paths.has(this._key(path.resolve(p))) && this.covered(p)) continue;
      this.add(p);
    }
  }

  _md(v, typed) {
    this.scanText(typeof v === 'string' ? v : v?.markdown, typed);
  }

  _part(p, typed) {
    if (!p || typeof p !== 'object') return;
    if (p.kind === 'markdown' || p.kind === 'reasoning') this.scanText(p.content, typed);
    else if (p.kind === 'toolCall') {
      this._md(p.toolCall?.invocationMessage, typed);
      this._md(p.toolCall?.pastTenseMessage, typed);
    } else if (p.kind === 'inputRequest') this._md(p.request?.message, typed);
  }

  _turn(t, channel, active) {
    if (!t || typeof t !== 'object') return;
    const typed = typeof t.message?.text === 'string' ? t.message.text : '';
    if (active) this._typed(channel, t.id, typed);
    for (const p of t.responseParts || []) this._part(p, typed);
  }

  _turns(turns) {
    if (Array.isArray(turns)) for (const t of turns) this._turn(t);
  }

  _state(st, channel) {
    if (!st || typeof st !== 'object') return;
    this._turns(st.turns);
    if (st.activeTurn) this._turn(st.activeTurn, channel, true);
  }

  /** Keeps the message of a turn going on now, for the live actions that follow. */
  _typed(channel, turnId, text) {
    if (!channel || !turnId) return;
    const key = `${channel}|${turnId}`;
    if (this.typed.has(key)) return;
    const t = typeof text === 'string' ? text : '';
    // Only what can matter: a terminal command, or a message with a link in it.
    this.typed.set(key, isCommand(t) || t.includes('](') || t.includes(']:') ? t : '');
    if (this.typed.size > MAX_TURNS) this.typed.delete(this.typed.keys().next().value);
  }

  _streamed(key, piece, typed) {
    if (typeof piece !== 'string') return;
    const text = (this.tails.get(key) || '') + piece;
    this.scanText(text, typed);
    this.tails.delete(key);
    this.tails.set(key, text.slice(-TAIL_CHARS));
    if (this.tails.size > MAX_TAILS) this.tails.delete(this.tails.keys().next().value);
  }

  _action(env) {
    const a = env?.action;
    if (!a || typeof a !== 'object' || env.rejectionReason) return;
    const channel = env.channel;
    if (a.type === 'chat/turnStarted') {
      // Whoever sent it: the message is what VS Code may show back during the turn.
      this._typed(channel, a.turnId, a.message?.text);
      return;
    }
    if (env.origin) return;
    if (a.type === 'chat/turnsLoaded') {
      this._turns(a.turns);
      return;
    }
    // A turn that started before this relay did is read as the agent's: VS Code shows a message back
    // right as its turn starts.
    const typed = this.typed.get(`${channel}|${a.turnId}`) || '';
    switch (a.type) {
      case 'chat/responsePart':
        if (a.part?.kind === 'markdown' || a.part?.kind === 'reasoning') this._streamed(`${channel}|${a.turnId}|${a.part.id}`, a.part.content || '', typed);
        else this._part(a.part, typed);
        break;
      case 'chat/delta':
      case 'chat/reasoning':
        this._streamed(`${channel}|${a.turnId}|${a.partId}`, a.content, typed);
        break;
      case 'chat/inputRequested':
        this._md(a.request?.message, typed);
        break;
      default:
        if (/^chat\/toolCall/.test(a.type || '')) {
          this._md(a.invocationMessage, typed);
          this._md(a.pastTenseMessage, typed);
          this._md(a.result?.pastTenseMessage, typed);
        }
    }
  }

  /**
   * Notes the links in a message from the agent host to a device (snapshots, older turns, live actions).
   * Actions a client sent (a device, VS Code's own window) are left out: only what the agent wrote counts.
   */
  scanMessage(msg) {
    try {
      const r = msg?.result;
      if (r && typeof r === 'object') {
        if (r.snapshot) this._state(r.snapshot.state, r.snapshot.resource);
        if (Array.isArray(r.snapshots)) for (const s of r.snapshots) this._state(s?.state, s?.resource);
        this._turns(r.turns);
        if (Array.isArray(r.actions)) for (const env of r.actions) this._action(env);
      }
      if (msg?.method === 'action') this._action(msg.params);
    } catch (err) {
      this.log('warn', `Could not read the links in a message: ${err.message}`);
    }
  }
}

module.exports = { LinkedPaths, loadLinkParser, MAX_PATHS };
