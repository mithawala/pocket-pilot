// Where the Copilot-app hub keeps its state, plus a tiny authenticated JSON-lines channel between
// the per-session extension processes and the hub (127.0.0.1 only, never tunneled).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const HOME = process.env.POCKET_PILOT_HOME || path.join(os.homedir(), '.pocket-pilot', 'copilot');
export const FILES = {
  hub: path.join(HOME, 'hub.json'),
  state: path.join(HOME, 'state.json'),
  secrets: path.join(HOME, 'secrets.json'),
  devices: path.join(HOME, 'devices.json'),
  rendezvous: path.join(HOME, 'rendezvous.json'),
  log: path.join(HOME, 'hub.log'),
  lock: path.join(HOME, 'hub.lock'),
  tunnel: path.join(HOME, 'tunnel'),
  uploads: path.join(HOME, 'uploads'),
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureHome();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');

/** The hub refreshes its lock every 10 s; a lock older than this belongs to a dead (or PID-reused) owner. */
export const LOCK_STALE_MS = 30000;

export function lockInfo() {
  try {
    const st = fs.statSync(FILES.lock);
    return { pid: Number(fs.readFileSync(FILES.lock, 'utf8')) || 0, age: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
}

/** True if hub.json describes a hub that is really running (not just a PID that was reused). */
export function hubAlive(info) {
  if (!info || !isAlive(info.pid)) return false;
  const lock = lockInfo();
  return !!lock && lock.pid === info.pid && lock.age < LOCK_STALE_MS;
}

/**
 * Takes the hub lock. Atomic: the lock file is linked from a fully written temp file (never seen
 * empty), and a stale lock is renamed aside, which only one contender can win.
 */
export function takeLock() {
  ensureHome();
  const tmp = `${FILES.lock}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, String(process.pid), { mode: 0o600 });
  try {
    for (let i = 0; i < 4; i++) {
      try {
        fs.linkSync(tmp, FILES.lock);
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      const lock = lockInfo();
      if (!lock) continue;
      if (lock.pid === process.pid) return true;
      if (isAlive(lock.pid) && lock.age < LOCK_STALE_MS) return false;
      const aside = `${FILES.lock}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.renameSync(FILES.lock, aside);
      } catch {
        continue;
      }
      let moved = 0;
      try {
        moved = Number(fs.readFileSync(aside, 'utf8')) || 0;
      } catch {
        /* unreadable: treat as stale */
      }
      if (moved !== lock.pid && isAlive(moved)) {
        // Another contender replaced the stale lock first: give its fresh lock back and step aside.
        try {
          fs.linkSync(aside, FILES.lock);
        } catch {
          /* someone else holds it now */
        }
        fs.rmSync(aside, { force: true });
        return false;
      }
      fs.rmSync(aside, { force: true });
    }
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function touchLock() {
  const lock = lockInfo();
  if (!lock || lock.pid !== process.pid) return false;
  const now = new Date();
  try {
    fs.utimesSync(FILES.lock, now, now);
  } catch {
    return false;
  }
  return true;
}

export function releaseLock() {
  if (lockInfo()?.pid === process.pid) fs.rmSync(FILES.lock, { force: true });
}

const MAX_LINE = 64 * 1024 * 1024;

/** A newline-delimited JSON channel over a socket. Emits `message` and `close`. */
export class Channel extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._data(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _data(chunk) {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE) return this.close();
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return this.close();
      }
      this.emit('message', msg);
    }
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  send(msg) {
    if (this.closed) return false;
    return this.socket.write(`${JSON.stringify(msg)}\n`);
  }

  close() {
    this.socket.destroy();
    this._closed();
  }
}

/** Listens on 127.0.0.1; a connection is handed to `onChannel` only after it sent the right token. */
export function serve(token, onChannel) {
  const expected = Buffer.from(token);
  const server = net.createServer((socket) => {
    const ch = new Channel(socket);
    const timer = setTimeout(() => ch.close(), 5000);
    ch.once('message', (msg) => {
      clearTimeout(timer);
      const got = Buffer.from(String(msg?.token || ''));
      if (msg?.t !== 'auth' || got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return ch.close();
      ch.send({ t: 'ready' });
      onChannel(ch, msg);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export function connect(port, token, hello = {}, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const ch = new Channel(socket);
    const timer = setTimeout(() => {
      ch.close();
      reject(new Error('Pocket Pilot hub did not answer'));
    }, timeoutMs);
    socket.once('connect', () => ch.send({ ...hello, t: 'auth', token }));
    ch.once('message', (msg) => {
      clearTimeout(timer);
      if (msg?.t === 'ready') resolve(ch);
      else reject(new Error('Pocket Pilot hub refused the connection'));
    });
    ch.once('close', () => {
      clearTimeout(timer);
      reject(new Error('Pocket Pilot hub is not running'));
    });
  });
}

/** Request/response on top of a channel (`{t:'req', id, op, params}` -> `{t:'res', id, ok, value|error}`). */
export class Rpc {
  constructor(ch, handlers = {}) {
    this.ch = ch;
    this.handlers = handlers;
    this.seq = 0;
    this.pending = new Map();
    ch.on('message', (m) => this._msg(m));
    ch.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Connection closed'));
      this.pending.clear();
    });
  }

  request(op, params = {}, timeoutMs = 60000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      if (!this.ch.send({ t: 'req', id, op, params }) && this.ch.closed) this.pending.get(id)?.reject(new Error('Connection closed'));
    });
  }

  notify(op, params = {}) {
    this.ch.send({ t: 'note', op, params });
  }

  async _msg(m) {
    if (m.t === 'res') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error || 'Request failed'));
      return;
    }
    if (m.t !== 'req' && m.t !== 'note') return;
    const h = this.handlers[m.op];
    if (m.t === 'note') {
      if (h) Promise.resolve().then(() => h(m.params || {})).catch(() => {});
      return;
    }
    try {
      if (!h) throw new Error(`Unknown request ${m.op}`);
      const value = await h(m.params || {});
      this.ch.send({ t: 'res', id: m.id, ok: true, value: value === undefined ? null : value });
    } catch (err) {
      this.ch.send({ t: 'res', id: m.id, ok: false, error: err?.message || String(err) });
    }
  }
}
