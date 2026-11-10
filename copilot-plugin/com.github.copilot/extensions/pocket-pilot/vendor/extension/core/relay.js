'use strict';
// Relay server: phone <-(end-to-end encrypted WebSocket via tunnel)-> relay <-(AHP)-> VS Code agent host.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const ws = require('./wslite');
const agentHost = require('./agentHost');
const webauthn = require('./webauthn');
const push = require('./push');
const { slimForPhone } = require('./slim');
const { deviceIdFor } = require('./store');
const { loadSecureChannel, loadTotp } = require('./identity');
const files = require('./files');
const { LinkedPaths, loadLinkParser } = require('./links');
const { isInside } = require('./attachments');
const { fileURLToPath, pathToFileURL } = require('url');

const b64u = (b) => Buffer.from(b).toString('base64url');

// How long the PC waits while the phone sets up or answers its second factor: people may try a
// passkey a few times, or add Pocket Pilot to an authenticator app first.
const FACTOR_TIMEOUT_MS = 10 * 60 * 1000;
// Authenticator-app codes: wrong codes per connection, then per device before a lockout that doubles
// each time (15 minutes up to a day). A stolen device key alone can't guess its way in.
const TOTP_TRIES_PER_CONNECTION = 5;
const TOTP_LOCK_AFTER = 10;
const TOTP_LOCK_MS = 15 * 60 * 1000;
const TOTP_LOCK_MAX_MS = 24 * 3600 * 1000;

// JSON-RPC methods a phone may send to the agent host. Everything else is refused by the relay.
const ALLOWED_REQUESTS = new Set([
  'initialize', 'reconnect', 'ping', 'subscribe', 'listSessions', 'createSession', 'disposeSession',
  'createChat', 'fetchTurns', 'completions', 'resolveSessionConfig', 'sessionConfigCompletions',
  'resourceList', 'resourceResolve', 'resourceRead',
]);
const ALLOWED_NOTIFICATIONS = new Set(['unsubscribe', 'dispatchAction']);

// File requests one device may have running at once (a download asks for a few pieces ahead), and
// waiting for their turn (two downloads at once).
const MAX_FILE_OPS = 8;
const MAX_FILE_WAITING = 64;
// What the phone is told when the PC can't read something, by Node's error code.
const FILE_ERRORS = {
  ENOENT: ['not-found', 'This is no longer on your computer'],
  ENOTDIR: ['not-found', 'This folder is no longer on your computer'],
  EACCES: ['os-denied', "Your computer doesn't allow reading this"],
  EPERM: ['os-denied', "Your computer doesn't allow reading this"],
  EBUSY: ['busy', 'This file is in use on your computer'],
  EISDIR: ['not-a-file', 'This is a folder'],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// What the phone tells VS Code to show for a tool call it ends ("Skipped Search repositories"): text.
const plainText = (s, max) => (typeof s === 'string' ? s.replace(/\]\s*\(/g, '] (').slice(0, max) : undefined);

/** The channels a request opens (their state comes back in its reply), the root left out. */
function channelsOpenedBy(msg) {
  const p = msg.params || {};
  const list = msg.method === 'subscribe' ? [p.channel] : msg.method === 'initialize' ? p.initialSubscriptions : msg.method === 'reconnect' ? p.subscriptions : null;
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && c !== 'ahp-root://').slice(0, 20) : [];
}

/**
 * A device ends a tool call only to skip a sign-in (Continue without signing in): as a failure, in plain
 * text. Anything else is dropped, and the text can't hold a link, which the relay would then let devices
 * open (see LinkedPaths). Returns the action to pass on, or null.
 */
function deviceToolCallComplete(action) {
  const r = action.result;
  if (!r || typeof r !== 'object' || r.success !== false) return null;
  const error = r.error && typeof r.error === 'object' ? { message: plainText(r.error.message, 2000) || '', ...(typeof r.error.code === 'string' ? { code: r.error.code.slice(0, 40) } : {}) } : undefined;
  return {
    type: action.type,
    turnId: action.turnId,
    toolCallId: action.toolCallId,
    result: { success: false, ...(typeof r.pastTenseMessage === 'string' ? { pastTenseMessage: plainText(r.pastTenseMessage, 500) } : {}), ...(error ? { error } : {}) },
  };
}

class RelayError extends Error {
  constructor(code, message, { quiet = false, closeCode = 4400 } = {}) {
    super(message || code);
    this.code = code;
    this.quiet = quiet;
    this.closeCode = closeCode;
  }
}

class FrameQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    const w = this.waiters.shift();
    if (w) w.resolve(item);
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(new RelayError('closed', 'Connection closed', { quiet: true }));
  }
  shift(timeoutMs = 0) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.reject(new RelayError('closed', 'Connection closed', { quiet: true }));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      if (timeoutMs > 0) {
        const t = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new RelayError('timeout', 'Timed out waiting for the device'));
        }, timeoutMs);
        w.resolve = (v) => { clearTimeout(t); resolve(v); };
        w.reject = (e) => { clearTimeout(t); reject(e); };
      }
      this.waiters.push(w);
    });
  }
}

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length < 64) return cf;
  return req.socket.remoteAddress || 'unknown';
}

/** The request target as a URL, or null for targets `new URL` rejects (e.g. `//x:99999/`). */
function requestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://localhost');
  } catch {
    return null;
  }
}

function sanitizeText(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function withTimeout(promise, ms, fallback) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

class RelayServer extends EventEmitter {
  /**
   * The relay never signs in to the agent host: VS Code (or the Copilot app) keeps it authenticated, and
   * the agent host's tokens are global, so pushing another token would switch accounts for every client.
   *
   * @param {object} o
   * @param {object} o.identity         host identity from identity.loadHostIdentity
   * @param {import('./store').DeviceStore} o.store
   * @param {() => object|null} o.getAgentEndpoint
   * @param {() => Promise<void>} [o.restartAgentHost]  starts the agent host again after it stopped (a device may ask)
   * @param {(info: object) => Promise<boolean>} o.approveDevice
   * @param {() => string[]} o.allowedOrigins
   * @param {() => {requireApproval:boolean, passkey:'required'|'optional'|'off', passkeyGraceHours:number, allowTotp?:boolean}} o.policy
   * @param {(device: object) => Promise<object>|object} o.welcomeExtras
   * @param {(uri: string) => boolean} [o.isReadAllowed]
   * @param {string} [o.linkedPathsFile]  where to keep the files and folders agents linked (see LinkedPaths)
   * @param {string} [o.homeDir]  the home folder, which a link never opens (the user's, if not given)
   * @param {(req: object) => Promise<{uri:string, path:string}>} [o.saveUpload]
   * @param {string} [o.pwaDir]
   * @param {(level: string, msg: string) => void} [o.log]
   */
  constructor(o) {
    super();
    this.o = o;
    this.log = o.log || (() => {});
    this.pairingTokens = new Map();
    this.connections = new Set();
    this.failures = new Map();
    this.server = null;
    this.port = 0;
  }

  async listen(port = 0, host = '127.0.0.1') {
    this.sc = await loadSecureChannel();
    this.totp = await loadTotp();
    if (this.o.isReadAllowed && !this.links) {
      const covered = (p) => {
        try {
          return !!this.o.isReadAllowed(pathToFileURL(p).href);
        } catch {
          return false;
        }
      };
      this.links = new LinkedPaths({ parser: await loadLinkParser(), file: this.o.linkedPathsFile || null, covered, home: this.o.homeDir, log: this.log });
    }
    this.server = http.createServer((req, res) => this._http(req, res));
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
    this.server.on('clientError', (err, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this._keepaliveTimer = setInterval(() => this._keepalive(), 20000);
    this._keepaliveTimer.unref?.();
    return this.port;
  }

  async close() {
    clearInterval(this._keepaliveTimer);
    for (const c of [...this.connections]) c.close(1001, 'Pocket Pilot stopped');
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.links?.flush();
  }

  /** Active phone connections that completed authentication. */
  activeConnections() {
    return [...this.connections].filter((c) => c.state === 'ready').map((c) => ({
      deviceId: c.device.id, name: c.device.name, visible: c.visible, connectedAt: c.connectedAt, ip: c.meta.ip,
    }));
  }

  isDeviceVisible(deviceId) {
    return [...this.connections].some((c) => c.state === 'ready' && c.device && c.device.id === deviceId && c.visible);
  }

  // ------------------------------------------------------------ pairing tokens

  /** Creates the one valid pairing token; every earlier, unused QR code stops working. */
  async createPairingToken(ttlMs = 10 * 60 * 1000) {
    const now = Date.now();
    this.pairingTokens.clear();
    const token = new Uint8Array(crypto.randomBytes(16));
    const tokenId = b64u(await this.sc.pairingTokenId(token));
    const rec = { token, expiresAt: now + ttlMs, used: false };
    this.pairingTokens.set(tokenId, rec);
    return { token, tokenId, expiresAt: rec.expiresAt };
  }

  cancelPairingTokens() {
    this.pairingTokens.clear();
  }

  _takePairingToken(tokenId) {
    const t = this.pairingTokens.get(tokenId);
    if (!t || t.used || t.expiresAt < Date.now()) return null;
    t.used = true;
    this.emit('pairing-token-used', tokenId);
    return t;
  }

  // ------------------------------------------------------------ device management

  /** Cuts every connection of a device immediately, including handshakes still in progress. */
  revokeDevice(deviceId) {
    for (const c of [...this.connections]) {
      if (c.deviceId === deviceId || (c.device && c.device.id === deviceId)) c.revoke();
    }
  }

  broadcastControl(msg, filter = () => true) {
    for (const c of this.connections) if (c.state === 'ready' && filter(c)) c.sendControl(msg).catch(() => {});
  }

  /** Tells every connected phone that a session's summary changed (e.g. its corrected status). */
  pushSummaryChange(session, changes) {
    const text = JSON.stringify({ jsonrpc: '2.0', method: 'root/sessionSummaryChanged', params: { channel: 'ahp-root://', session, changes } });
    for (const c of this.connections) if (c.state === 'ready' && c.ahp && !c.revoked) c._sendAhp(text);
  }

  allowedOrigins() {
    return this.o.allowedOrigins();
  }

  // ------------------------------------------------------------ throttling

  _throttled(ip) {
    const f = this.failures.get(ip);
    return !!(f && f.until > Date.now());
  }

  _recordFailure(ip) {
    const now = Date.now();
    const f = this.failures.get(ip) || { count: 0, first: now, until: 0 };
    if (now - f.first > 10 * 60 * 1000) {
      f.count = 0;
      f.first = now;
    }
    f.count++;
    if (f.count >= 8) f.until = now + 10 * 60 * 1000;
    this.failures.set(ip, f);
  }

  // ------------------------------------------------------------ HTTP

  _http(req, res) {
    const url = requestUrl(req);
    const common = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
    };
    if (!url) {
      res.writeHead(400, common);
      return res.end();
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { ...common, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, app: 'pocket-pilot', v: 1 }));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, common);
      return res.end();
    }
    // Through the public tunnel, send visitors to the real (stable-origin) app instead of a copy.
    const viaTunnel = typeof req.headers['cf-connecting-ip'] === 'string';
    const redirectTo = viaTunnel && this.o.tunnelRedirect ? this.o.tunnelRedirect() : null;
    if (redirectTo) {
      res.writeHead(302, { ...common, Location: redirectTo, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!this.o.pwaDir) {
      res.writeHead(404, { ...common, 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, common);
      return res.end();
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const root = path.resolve(this.o.pwaDir);
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || rel.includes('\0') || path.basename(file) === 'package.json') {
      res.writeHead(404, common);
      return res.end();
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { ...common, 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        ...common,
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        // Always revalidate: the service worker provides offline caching.
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // ------------------------------------------------------------ WebSocket

  _upgrade(req, socket, head) {
    const url = requestUrl(req);
    if (!url || url.pathname !== '/ws') {
      socket.end(`HTTP/1.1 ${url ? '404 Not Found' : '400 Bad Request'}\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const origin = req.headers.origin;
    if (origin && !this.allowedOrigins().includes(origin)) {
      this.log('warn', `Rejected WebSocket from origin ${origin}`);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const ip = clientIp(req);
    if (this._throttled(ip)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (this.connections.size >= 32) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const conn = ws.acceptUpgrade(req, socket, head, { maxPayload: 4 * 1024 * 1024 });
    if (!conn) return;
    const dc = new DeviceConnection(this, conn, { ip, origin: origin || null, userAgent: String(req.headers['user-agent'] || '') });
    this.connections.add(dc);
    dc.on('closed', () => {
      this.connections.delete(dc);
      this.emit('connections');
    });
    dc.run();
  }

  _keepalive() {
    const now = Date.now();
    for (const c of this.connections) {
      if (now - c.lastPong > 75000) c.terminate();
      else c.conn.ping();
    }
  }
}

class DeviceConnection extends EventEmitter {
  constructor(relay, conn, meta) {
    super();
    this.relay = relay;
    this.conn = conn;
    this.meta = meta;
    this.state = 'handshake';
    this.device = null;
    this.deviceId = null;
    this.revoked = false;
    this.visible = false;
    this.connectedAt = Date.now();
    this.lastPong = Date.now();
    this.frames = new FrameQueue();
    this.ahp = null;
    this.listIds = new Set();
    // Requests on their way to the agent host that open channels (request id -> channels).
    this.loading = new Map();
    conn.on('message', (data, isBinary) => {
      this.lastPong = Date.now();
      this.frames.push({ data, isBinary });
    });
    conn.on('pong', () => { this.lastPong = Date.now(); });
    conn.on('close', () => this._closed());
    conn.on('error', () => {});
  }

  get log() {
    return this.relay.log;
  }

  async run() {
    try {
      await this._handshake();
      if (this.state === 'closed' || this.revoked) return;
      this.state = 'ready';
      this.relay.emit('connections');
      this.relay.emit('device-connected', this.device);
      await this._startBridge();
      await this._loop();
    } catch (err) {
      this._fail(err);
    }
  }

  /** The device was removed: stop relaying at once, tell the phone (encrypted), then close. */
  revoke() {
    if (this.revoked) return;
    this.revoked = true;
    if (this.ahp) {
      this.ahp.close();
      this.ahp = null;
    }
    const done = () => this.close(4401, 'Device removed');
    if (!this.messenger || this.state === 'closed') return done();
    Promise.race([this.sendControl({ t: 'revoked' }), new Promise((r) => setTimeout(r, 1000))]).catch(() => {}).finally(done);
  }

  /** Throws if the device was removed while we were waiting on the phone. */
  _assertStillPaired(deviceId) {
    if (this.revoked || this.state === 'closed' || !this.relay.o.store.get(deviceId)) {
      throw new RelayError('revoked', 'Device was removed', { quiet: true, closeCode: 4401 });
    }
  }

  // ---------------------------------------------------------- handshake

  async _handshake() {
    const { sc, o } = this.relay;
    const first = await this.frames.shift(15000);
    if (first.isBinary) throw new RelayError('bad-handshake', 'Expected hello');
    let hello;
    try {
      hello = sc.parseClientHello(first.data);
    } catch (err) {
      this.relay._recordFailure(this.meta.ip);
      throw new RelayError('bad-handshake', err.message);
    }
    let device = null;
    let pairing = null;
    if (hello.mode === 'resume') {
      // Unknown devices still complete the key agreement so the rejection can be sent
      // encrypted: a plaintext rejection could be forged by anyone on the path.
      device = o.store.getByPublicKey(b64u(hello.devicePublicKey));
      this.deviceId = device ? device.id : null;
    } else {
      pairing = this.relay._takePairingToken(hello.tokenId);
      if (!pairing) {
        this.relay._recordFailure(this.meta.ip);
        this._plainError('pairing-expired', 'This pairing code has expired or was already used.');
        throw new RelayError('pairing-expired', 'Invalid pairing token', { quiet: true });
      }
    }
    const acc = await sc.acceptClientHello({ helloText: first.data, hostKeys: o.identity.keys, pairingToken: pairing?.token });
    this.conn.send(acc.challengeText);
    this.messenger = new sc.SecureMessenger(acc.cipher, (frame) => this.conn.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)), {
      compress: hello.peerCompression,
      maxMessageBytes: 48 * 1024 * 1024,
    });
    let auth;
    try {
      auth = await this._recvControl(20000);
    } catch (err) {
      if (err.code === 'bad-mac') this.relay._recordFailure(this.meta.ip);
      throw err;
    }
    if (auth.t !== 'auth') throw new RelayError('bad-handshake', 'Expected auth');
    this.visible = !!auth.visible;
    // The device asks to start the agent host again if it isn't running (see _startBridge).
    this.wantsRestart = auth.restartAgent === true;
    if (hello.mode === 'resume' && !device) {
      this.relay._recordFailure(this.meta.ip);
      await this.sendControl({ t: 'error', code: 'unknown-device', message: 'This device is not paired with this PC anymore. Scan a new QR code on your PC.' });
      throw new RelayError('unknown-device', 'Unknown device', { quiet: true, closeCode: 4401 });
    }
    if (hello.mode === 'pair') device = await this._pair(hello, auth);
    else device = await this._verifyReturning(device, auth);
    this.deviceId = device.id;
    this._assertStillPaired(device.id);
    const fresh = o.store.update(device.id, { lastSeenAt: Date.now(), lastIp: this.meta.ip, appVersion: sanitizeText(auth.appVersion, 20) });
    if (!fresh) throw new RelayError('revoked', 'Device was removed', { quiet: true, closeCode: 4401 });
    this.device = fresh;
    const extras = (await o.welcomeExtras(fresh)) || {};
    this._assertStillPaired(fresh.id);
    await this.sendControl({
      t: 'welcome',
      deviceId: fresh.id,
      deviceName: fresh.name,
      host: { id: o.identity.hostId, name: o.identity.name },
      passkey: !!fresh.passkey,
      factor: fresh.passkey ? 'passkey' : fresh.totp ? 'totp' : null,
      // Browsing and downloading files (version of the `files` messages; 2: also what agents link to).
      ...(o.isReadAllowed ? { files: 2 } : {}),
      // The device may ask to start the agent host again when it has stopped.
      ...(o.restartAgentHost ? { restartAgent: 1 } : {}),
      ...extras,
    });
    this.log('info', `Device "${fresh.name}" connected from ${this.meta.ip}`);
  }

  async _pair(hello, auth) {
    const { o } = this.relay;
    const policy = o.policy();
    const name = sanitizeText(auth.device?.name, 60) || 'Device';
    const platform = sanitizeText(auth.device?.platform, 40);
    const id = deviceIdFor(hello.devicePublicKey);
    if (policy.requireApproval) {
      await this.sendControl({ t: 'pending', reason: 'approval' });
      const approved = await withTimeout(Promise.resolve(o.approveDevice({ name, platform, ip: this.meta.ip, origin: this.meta.origin, userAgent: this.meta.userAgent })), 180000, false);
      if (!approved) {
        await this.sendControl({ t: 'error', code: 'denied', message: 'Pairing was declined (or timed out) on your PC.' });
        throw new RelayError('denied', 'Pairing declined', { quiet: true });
      }
    }
    let passkey = null;
    let totp = null;
    if (policy.passkey !== 'off') ({ passkey = null, totp = null } = await this._enrollFactor({ id, name, policy }));
    const device = {
      id,
      name,
      platform,
      publicKey: b64u(hello.devicePublicKey),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      pwaOrigin: this.meta.origin,
      passkey,
      ...(totp ? { totp } : {}),
      push: null,
    };
    o.store.add(device);
    this.relay.emit('paired', device);
    this.log('info', `Paired new device "${name}" (${platform || 'unknown platform'})${totp ? ' with an authenticator app' : passkey ? ' with a passkey' : ''}`);
    return device;
  }

  /**
   * The device's second factor: a passkey, or where the PC allows it a code from an authenticator app.
   * The phone may try the passkey several times before it answers (this pairing stays open), or send the
   * authenticator setup it prepared: its setup key and the current code, after the person entered a
   * matching code from their authenticator app.
   */
  async _enrollFactor({ id, name, policy }) {
    const allowTotp = policy.allowTotp !== false;
    const challenge = b64u(crypto.randomBytes(32));
    await this.sendControl({ t: 'passkey.register', challenge, userId: id, userName: name, alternatives: allowTotp ? ['totp'] : [] });
    const reply = await this._recvControl(FACTOR_TIMEOUT_MS);
    if (reply.t === 'passkey.registered') {
      try {
        const passkey = webauthn.verifyRegistration(reply.credential, { challenge, allowedOrigins: this.relay.allowedOrigins() });
        passkey.createdAt = Date.now();
        passkey.lastVerifiedAt = Date.now();
        return { passkey };
      } catch (err) {
        this.log('warn', `Passkey registration failed: ${err.message}`);
        if (policy.passkey === 'required') {
          await this.sendControl({ t: 'error', code: 'passkey-failed', message: `Passkey setup failed: ${err.message}` });
          throw new RelayError('passkey-failed', err.message, { quiet: true });
        }
        return {};
      }
    }
    if (reply.t === 'totp.enroll' && allowTotp) {
      const { totp } = this.relay;
      const step = totp.isSecret(reply.secret) ? await totp.verifyCode(reply.secret, reply.code) : null;
      if (step === null) {
        await this.sendControl({ t: 'error', code: 'totp-failed', message: "The authenticator code didn't match on your PC. Check that the date and time are set automatically on your PC and this device, then scan a new QR code." });
        throw new RelayError('totp-failed', 'Authenticator setup code did not match', { quiet: true });
      }
      const now = Date.now();
      return { totp: { secret: reply.secret, createdAt: now, lastVerifiedAt: now, lastStep: step } };
    }
    if (policy.passkey === 'required') {
      const reason = sanitizeText(reply.reason, 200);
      const need = allowTotp ? 'a passkey (Face ID / fingerprint) or an authenticator app code' : 'a passkey (Face ID / fingerprint)';
      await this.sendControl({ t: 'error', code: 'passkey-required', message: `This PC requires ${need}.${reason ? ` ${reason}` : ''}` });
      throw new RelayError('passkey-required', 'Second factor required', { quiet: true });
    }
    return {};
  }

  async _verifyReturning(device, auth) {
    const policy = this.relay.o.policy();
    if (policy.passkey === 'off') return device;
    const allowTotp = policy.allowTotp !== false;
    if (!device.passkey && !(device.totp && allowTotp)) {
      if (policy.passkey === 'required') {
        const message = device.totp
          ? 'Your PC no longer accepts authenticator app codes. Remove the PC in the app and pair again with a passkey.'
          : `This PC now requires ${allowTotp ? 'a passkey or an authenticator app code' : 'a passkey'}. Remove the PC in the app and pair again.`;
        await this.sendControl({ t: 'error', code: 'passkey-missing', message });
        throw new RelayError('passkey-missing', 'Second factor missing', { quiet: true });
      }
      return device;
    }
    const graceMs = Math.max(0, Number(policy.passkeyGraceHours) || 0) * 3600 * 1000;
    if (Date.now() - ((device.passkey || device.totp).lastVerifiedAt || 0) < graceMs) return device;
    if (!device.passkey) return this._verifyTotp(device, auth);
    const challenge = b64u(crypto.randomBytes(32));
    await this.sendControl({ t: 'passkey.challenge', challenge, credentialId: device.passkey.credentialId, rpId: device.passkey.rpId });
    const reply = await this._recvControl(FACTOR_TIMEOUT_MS);
    this._assertStillPaired(device.id);
    if (reply.t === 'factor.reset') return this._resetFactor(device);
    if (reply.t !== 'passkey.assertion') {
      await this.sendControl({ t: 'error', code: 'passkey-failed', message: 'Face ID / fingerprint verification was cancelled.' });
      throw new RelayError('passkey-failed', 'Passkey cancelled', { quiet: true });
    }
    let r;
    try {
      r = webauthn.verifyAssertion(reply.assertion, { challenge, allowedOrigins: this.relay.allowedOrigins(), credential: this.relay.o.store.get(device.id).passkey });
    } catch (err) {
      this.relay._recordFailure(this.meta.ip);
      await this.sendControl({ t: 'error', code: 'passkey-failed', message: `Passkey verification failed: ${err.message}` });
      throw new RelayError('passkey-failed', err.message, { quiet: true });
    }
    const updated = this.relay.o.store.update(device.id, (d) => ({ passkey: { ...d.passkey, signCount: r.signCount, lastVerifiedAt: Date.now() } }));
    if (!updated) throw new RelayError('revoked', 'Device was removed', { quiet: true, closeCode: 4401 });
    return updated;
  }

  /**
   * Asks for a code from the device's authenticator app. The app can also send one it collected up
   * front (auth.totpCode): people switch to their authenticator app to read the code, and iOS may drop
   * the connection meanwhile, so the code arrives with the next one.
   */
  async _verifyTotp(device, auth) {
    const { store } = this.relay.o;
    const { totp } = this.relay;
    const lockedFor = (device.totp.lockedUntil || 0) - Date.now();
    if (lockedFor > 0) {
      const minutes = Math.ceil(lockedFor / 60000);
      await this.sendControl({ t: 'error', code: 'passkey-failed', message: `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
      throw new RelayError('passkey-failed', 'Authenticator codes locked', { quiet: true });
    }
    let code = typeof auth?.totpCode === 'string' ? auth.totpCode : null;
    let wrong = false;
    for (let tries = 0; tries < TOTP_TRIES_PER_CONNECTION; tries++) {
      if (!code) {
        await this.sendControl({ t: 'totp.challenge', wrong });
        const reply = await this._recvControl(FACTOR_TIMEOUT_MS);
        this._assertStillPaired(device.id);
        if (reply.t === 'factor.reset') return this._resetFactor(device);
        if (reply.t !== 'totp.code') {
          await this.sendControl({ t: 'error', code: 'passkey-failed', message: 'Verification was cancelled.' });
          throw new RelayError('passkey-failed', 'Authenticator code cancelled', { quiet: true });
        }
        code = reply.code;
      }
      const current = store.get(device.id);
      if (!current?.totp) throw new RelayError('revoked', 'Device was removed', { quiet: true, closeCode: 4401 });
      const step = await totp.verifyCode(current.totp.secret, code, { after: current.totp.lastStep ?? -1 });
      code = null;
      if (step !== null) {
        const updated = store.update(device.id, (d) => ({ totp: { ...d.totp, lastStep: step, lastVerifiedAt: Date.now(), failures: 0, lockouts: 0, lockedUntil: 0 } }));
        if (!updated) throw new RelayError('revoked', 'Device was removed', { quiet: true, closeCode: 4401 });
        return updated;
      }
      this.relay._recordFailure(this.meta.ip);
      const failed = store.update(device.id, (d) => {
        const failures = (d.totp.failures || 0) + 1;
        if (failures < TOTP_LOCK_AFTER) return { totp: { ...d.totp, failures } };
        const lockouts = (d.totp.lockouts || 0) + 1;
        return { totp: { ...d.totp, failures: 0, lockouts, lockedUntil: Date.now() + Math.min(TOTP_LOCK_MAX_MS, TOTP_LOCK_MS * 2 ** (lockouts - 1)) } };
      });
      if ((failed?.totp.lockedUntil || 0) > Date.now()) {
        this.log('warn', `Too many wrong authenticator codes from "${device.name}"; locked until ${new Date(failed.totp.lockedUntil).toLocaleTimeString()}`);
        const minutes = Math.ceil((failed.totp.lockedUntil - Date.now()) / 60000);
        await this.sendControl({ t: 'error', code: 'passkey-failed', message: `Too many wrong codes. Try again in ${minutes} minutes.` });
        throw new RelayError('passkey-failed', 'Authenticator codes locked', { quiet: true });
      }
      wrong = true;
    }
    await this.sendControl({ t: 'error', code: 'passkey-failed', message: 'Too many wrong codes. Check that the date and time are set automatically on this device, then try again.' });
    throw new RelayError('passkey-failed', 'Too many wrong authenticator codes', { quiet: true });
  }

  /**
   * A paired device that can't use its passkey or authenticator app anymore (the app that kept the passkey
   * was turned off, say) sets up a new one. This always needs a yes on the PC, even when pairing doesn't:
   * the device key alone must never be enough to get past the second factor.
   */
  async _resetFactor(device) {
    const { o } = this.relay;
    await this.sendControl({ t: 'pending', reason: 'approval' });
    const approved = await withTimeout(Promise.resolve(o.approveDevice({ name: device.name, platform: device.platform, ip: this.meta.ip, origin: this.meta.origin, userAgent: this.meta.userAgent, reset: true })), 180000, false);
    this._assertStillPaired(device.id);
    if (!approved) {
      this.relay._recordFailure(this.meta.ip);
      await this.sendControl({ t: 'error', code: 'passkey-failed', message: 'Setting up this device again was declined (or timed out) on your PC.' });
      throw new RelayError('passkey-failed', 'Second-factor reset declined', { quiet: true });
    }
    const { passkey = null, totp = null } = await this._enrollFactor({ id: device.id, name: device.name, policy: o.policy() });
    this._assertStillPaired(device.id);
    const updated = o.store.update(device.id, () => ({ passkey, totp: totp || undefined }));
    if (!updated) throw new RelayError('revoked', 'Device was removed', { quiet: true, closeCode: 4401 });
    this.log('info', `"${device.name}" set up ${totp ? 'an authenticator app' : passkey ? 'a new passkey' : 'no second factor'} again`);
    return updated;
  }

  // ---------------------------------------------------------- secure messaging

  async _recvSecure(timeoutMs) {
    for (;;) {
      const f = await this.frames.shift(timeoutMs);
      if (!f.isBinary) throw new RelayError('bad-frame', 'Unexpected text frame');
      const text = await this.messenger.receive(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength));
      if (text !== null) return text;
    }
  }

  async _recvControl(timeoutMs) {
    const text = await this._recvSecure(timeoutMs);
    if (text[0] !== 'C') throw new RelayError('bad-frame', 'Expected control message');
    return JSON.parse(text.slice(1));
  }

  sendControl(obj) {
    if (!this.messenger || this.state === 'closed') return Promise.resolve();
    return this.messenger.send('C' + JSON.stringify(obj));
  }

  _sendAhp(text) {
    if (this.state !== 'closed') this.messenger.send('A' + text).catch(() => {});
  }

  _plainError(code, message) {
    try {
      this.conn.send(JSON.stringify({ t: 'error', v: 1, code, message }));
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------- AHP bridge

  async _startBridge() {
    const { o } = this.relay;
    const hostLabel = o.agentHostLabel || 'The VS Code agent host';
    let ep = o.getAgentEndpoint();
    if (!ep && this.wantsRestart && o.restartAgentHost) ep = await this._restartAgentHost(hostLabel);
    if (!ep) {
      await this.sendControl({ t: 'ahp.status', connected: false, reason: `${hostLabel} is not running.`, ...(o.restartAgentHost ? { restartable: true } : {}) });
      throw new RelayError('no-agent-host', 'Agent host not available', { quiet: true, closeCode: 4503 });
    }
    try {
      this.ahp = await (o.openAgentConnection ? o.openAgentConnection(ep) : agentHost.openConnection(ep));
    } catch (err) {
      await this.sendControl({ t: 'ahp.status', connected: false, reason: err.message });
      throw new RelayError('no-agent-host', err.message, { quiet: true, closeCode: 4503 });
    }
    if (this.state === 'closed' || this.revoked) {
      // The phone went away (or was removed) while we were connecting.
      this.ahp.close();
      this.ahp = null;
      throw new RelayError('closed', 'Connection closed', { quiet: true });
    }
    this.ahp.on('message', (text, isBinary) => {
      if (!isBinary) this._fromHost(text);
    });
    this.ahp.on('close', () => {
      if (this.state === 'closed' || this.revoked) return;
      // What the device was still waiting for: opening a very large conversation can be what made the
      // agent host run out of memory, so the device doesn't open it again by itself.
      const loading = [...new Set([...this.loading.values()].flat())];
      if (loading.length) this.log('warn', `${hostLabel} stopped while "${this.device?.name}" was opening ${loading.join(', ')}`);
      this.sendControl({ t: 'ahp.status', connected: false, stopped: true, reason: `${hostLabel} stopped.`, ...(loading.length ? { loading } : {}) }).finally(() => this.close(4503, 'Agent host disconnected'));
    });
    this.ahp.on('error', () => {});
    await this.sendControl({ t: 'ahp.status', connected: true, protocolVersion: ep.protocolVersion });
  }

  /**
   * Starts the agent host again for a device that asked to (VS Code stops restarting it after it crashes
   * 5 times in a row). One restart at a time for all devices; resolves with its endpoint, or null.
   */
  async _restartAgentHost(hostLabel) {
    const relay = this.relay;
    this.wantsRestart = false;
    if (!relay._restarting) {
      this.log('info', `Device "${this.device?.name}" is starting ${hostLabel.replace(/^The /, 'the ')} again`);
      relay._restarting = (async () => {
        try {
          await relay.o.restartAgentHost();
        } catch (err) {
          this.log('warn', `Could not restart the agent host: ${err?.message || err}`);
          return null;
        }
        const end = Date.now() + (relay.o.restartWaitMs ?? 45000);
        for (;;) {
          const ep = relay.o.getAgentEndpoint();
          if (ep || Date.now() > end) return ep || null;
          await new Promise((r) => setTimeout(r, 500));
        }
      })().finally(() => {
        relay._restarting = null;
      });
    }
    const wait = relay._restarting;
    await this.sendControl({ t: 'ahp.status', connected: false, restarting: true, reason: `Starting ${hostLabel.replace(/^The /, 'the ')} again…` });
    return wait;
  }

  async _loop() {
    for (;;) {
      const text = await this._recvSecure(0);
      if (this.revoked) continue;
      if (text[0] === 'A') this._toHost(text.slice(1));
      else if (text[0] === 'C') await this._onControl(JSON.parse(text.slice(1)));
    }
  }

  _toHost(text) {
    if (!this.ahp || this.revoked) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    // Only single JSON-RPC objects: batches (arrays) would bypass the allowlist.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (typeof msg.id === 'string' && msg.id.startsWith('pp:')) {
      if (typeof msg.method === 'string') this._sendAhp(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Reserved request id' } }));
      return;
    }
    if (!('method' in msg)) {
      // Anything without a method must be a response to a server-initiated request.
      if (msg.id === undefined || msg.id === null || !('result' in msg || 'error' in msg)) return;
    } else if (typeof msg.method !== 'string') {
      return;
    } else {
      const isRequest = msg.id !== undefined && msg.id !== null;
      const allowed = isRequest ? ALLOWED_REQUESTS.has(msg.method) : ALLOWED_NOTIFICATIONS.has(msg.method);
      if (!allowed) {
        if (isRequest) this._sendAhp(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `"${msg.method}" is not allowed from Pocket Pilot` } }));
        return;
      }
      if (msg.method === 'resourceRead' && !(this.relay.o.isReadAllowed && this.relay.o.isReadAllowed(msg.params?.uri))) {
        this._sendAhp(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Reading files outside your session folders is not allowed' } }));
        return;
      }
      if (msg.method === 'dispatchAction' && msg.params?.action?.type === 'chat/toolCallComplete') {
        const action = deviceToolCallComplete(msg.params.action);
        if (!action) return;
        msg.params.action = action;
        text = JSON.stringify(msg);
      }
      if (isRequest && msg.method === 'listSessions') this.listIds.add(msg.id);
      const opening = isRequest ? channelsOpenedBy(msg) : [];
      if (opening.length && this.loading.size < 200) this.loading.set(msg.id, opening);
    }
    this.ahp.send(text);
  }

  _fromHost(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      this.loading.delete(msg.id);
      if (this.listIds.delete(msg.id)) text = this._adjustSummaries(msg, text);
    } else if (msg.method === 'auth/required') {
      // VS Code answers this itself (and may ask you to sign in on the PC); the phone has nothing to add.
      return;
    } else if (msg.method === 'root/sessionAdded' || msg.method === 'root/sessionSummaryChanged') {
      text = this._adjustSummaries(msg, text);
    }
    // The files and folders the agent links to, which the device may then open (see _files).
    this.relay.links?.scanMessage(msg);
    this._sendAhp(slimForPhone(msg, text));
  }

  /** Corrects session statuses the host over-reports as errors (see SessionMonitor.statusFor). */
  _adjustSummaries(msg, text) {
    const adjust = this.relay.o.adjustSummary;
    if (!adjust) return text;
    let changed = false;
    const fix = (s) => {
      const a = adjust(s);
      if (a !== s) changed = true;
      return a;
    };
    if (Array.isArray(msg.result?.items)) msg.result.items = msg.result.items.map(fix);
    else if (msg.params?.summary) msg.params.summary = fix(msg.params.summary);
    else if (typeof msg.params?.changes?.status === 'number' && msg.params.session) {
      const status = adjust({ resource: msg.params.session, status: msg.params.changes.status }).status;
      if (status !== msg.params.changes.status) {
        msg.params.changes = { ...msg.params.changes, status };
        changed = true;
      }
    }
    return changed ? JSON.stringify(msg) : text;
  }

  // ---------------------------------------------------------- control messages from the phone

  async _onControl(m) {
    const { o } = this.relay;
    switch (m.t) {
      case 'presence':
        this.visible = !!m.visible;
        this.relay.emit('connections');
        break;
      case 'ping':
        await this.sendControl({ t: 'pong', ts: m.ts });
        break;
      case 'push.subscribe': {
        const s = m.subscription;
        const ok = s && push.isAllowedPushEndpoint(s.endpoint) && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
        if (ok) o.store.update(this.device.id, { push: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, updatedAt: Date.now() } });
        await this.sendControl({ t: 'push.result', ok: !!ok, error: ok ? undefined : 'Unsupported push service' });
        this.relay.emit('push-changed', this.device.id);
        break;
      }
      case 'push.unsubscribe':
        o.store.update(this.device.id, { push: null });
        this.relay.emit('push-changed', this.device.id);
        break;
      case 'push.test':
        this.relay.emit('push-test', this.device.id);
        break;
      case 'upload': {
        if (!o.saveUpload) {
          await this.sendControl({ t: 'upload.result', id: m.id, ok: false, error: 'Uploads are disabled' });
          break;
        }
        try {
          const data = Buffer.from(String(m.data || ''), 'base64');
          if (data.length > 25 * 1024 * 1024) throw new Error('File is larger than 25 MB');
          const r = await o.saveUpload({ deviceId: this.device.id, session: m.session, name: sanitizeText(m.name, 120), mime: sanitizeText(m.mime, 100), data });
          await this.sendControl({ t: 'upload.result', id: m.id, ok: true, uri: r.uri, path: r.path });
        } catch (err) {
          await this.sendControl({ t: 'upload.result', id: m.id, ok: false, error: err.message });
        }
        break;
      }
      case 'forget':
        o.store.remove(this.device.id);
        this.relay.emit('device-removed', this.device.id);
        this.close(4401, 'Device forgotten');
        break;
      case 'files':
        // Not awaited: a long search or a download must not hold up the chat.
        this._files(m).catch((err) => this.log('warn', `File request failed: ${err?.message || err}`));
        break;
      default:
        break;
    }
  }

  /**
   * Browsing and downloading files (`files` messages): `list` a folder, `stat` one entry, `read` a piece
   * of a file, or find the `recent` files under a folder. Only inside the folders a device may read,
   * like `resourceRead`. Answers with a `files.result` carrying the same id.
   */
  async _files(m) {
    const { o } = this.relay;
    const reply = (r) => this.sendControl({ t: 'files.result', id: m.id, ...r }).catch(() => {});
    const fail = (code, error) => reply({ ok: false, code, error });
    if (typeof m.id !== 'string' || m.id.length > 80) return;
    if (!o.isReadAllowed) return fail('unsupported', 'Browsing files is not available');
    if ((this.fileQueue?.length || 0) >= MAX_FILE_WAITING) return fail('busy', 'Too many requests at once');
    const uri = typeof m.uri === 'string' ? m.uri : '';
    let p;
    try {
      p = fileURLToPath(uri);
    } catch {
      return fail('invalid', 'Not a file on this computer');
    }
    // Inside a session folder, or in what an agent linked in a chat (a file, or a folder and what's in it).
    // Checked on the address as read (`..` resolved), not as sent, before anything looks at the disk.
    const links = this.relay.links;
    const inSession = (q) => {
      try {
        return !!o.isReadAllowed(pathToFileURL(q).href);
      } catch {
        return false;
      }
    };
    const NOT_ALLOWED = 'Only the files in your session folders, and the files and folders an agent links to, can be opened';
    const TOO_MUCH = "Your home folder, whole drives, and the folders that hold your apps' data and sign-ins can't be opened from your phone. Ask the agent to link the file itself.";
    const session = inSession(p);
    const link = session ? null : links?.grantFor(p) || null;
    if (!session && !link) return fail('denied', links?.blockedBy(p) ? TOO_MUCH : NOT_ALLOWED);
    // Where things really are must be allowed too: a linked address may be another name for a place a link
    // never opens (a junction, a short name like C:\Users\ABC~1), and a link (shortcut) in a folder may lead
    // anywhere. Looked up without holding anything else up.
    const realOf = (q) => fs.promises.realpath(q).catch(() => null);
    const realLink = link ? await realOf(link) : null;
    if (realLink && realLink !== link && (path.relative(link, p) === '' ? links.broad(realLink) : links.sensitive(realLink))) return fail('denied', TOO_MUCH);
    const real = await realOf(p);
    if (real && real !== p && !inSession(real) && !links?.grantFor(real) && !(realLink && isInside(real, realLink))) return fail('denied', NOT_ALLOWED);
    await this._fileSlot();
    if (this.state === 'closed') return this._fileDone();
    try {
      switch (m.op) {
        case 'list':
          return await reply({ ok: true, ...(await files.listFolder(p)) });
        case 'stat':
          return await reply({ ok: true, ...(await files.statPath(p)) });
        case 'recent': {
          const limit = Number.isInteger(m.limit) ? Math.min(200, Math.max(1, m.limit)) : 100;
          return await reply({ ok: true, ...(await files.newestFiles(p, { limit })) });
        }
        case 'read': {
          const offset = m.offset;
          const length = Number.isInteger(m.length) ? m.length : files.MAX_CHUNK;
          if (!Number.isSafeInteger(offset) || offset < 0 || length < 1) return await fail('invalid', 'Invalid range');
          const r = await files.readPiece(p, offset, length);
          if (offset === 0) this.log('info', `Device "${this.device?.name}" is downloading ${p} (${r.size} bytes)`);
          return await reply({ ok: true, data: r.data.toString('base64'), size: r.size, mtime: r.mtime });
        }
        default:
          return await fail('unsupported', `Unknown file request: ${String(m.op).slice(0, 20)}`);
      }
    } catch (err) {
      const [code, message] = FILE_ERRORS[err?.code] || ['error', err?.message || 'Could not read this'];
      return fail(code, message);
    } finally {
      this._fileDone();
    }
  }

  /** Waits for one of the MAX_FILE_OPS places for a file request of this device. */
  _fileSlot() {
    this.fileOps ||= 0;
    if (this.fileOps < MAX_FILE_OPS) {
      this.fileOps++;
      return Promise.resolve();
    }
    return new Promise((resolve) => (this.fileQueue ||= []).push(() => {
      this.fileOps++;
      resolve();
    }));
  }

  _fileDone() {
    this.fileOps--;
    this.fileQueue?.shift()?.();
  }

  // ---------------------------------------------------------- lifecycle

  _fail(err) {
    if (this.state === 'closed') return;
    if (!err.quiet && err.code !== 'closed') this.log('warn', `Device connection from ${this.meta.ip} failed: ${err.message}`);
    const code = err.closeCode || (err.code === 'bad-mac' ? 4401 : 4400);
    this.close(code, String(err.code || 'error').slice(0, 60));
  }

  close(code = 1000, reason = '') {
    if (this.state === 'closed') return;
    const wasReady = this.state === 'ready';
    this.state = 'closed';
    this.frames.close();
    try {
      this.conn.close(code, reason);
    } catch {
      /* ignore */
    }
    if (this.ahp) this.ahp.close();
    this.ahp = null;
    if (wasReady) this.relay.emit('device-disconnected', this.device);
    this.emit('closed');
  }

  terminate() {
    try {
      this.conn.terminate();
    } catch {
      /* ignore */
    }
    this.close(1006, 'timeout');
  }

  _closed() {
    this.close(1006, 'closed');
  }
}

module.exports = { RelayServer, RelayError, ALLOWED_REQUESTS, ALLOWED_NOTIFICATIONS };
