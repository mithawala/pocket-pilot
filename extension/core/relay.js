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
const { deviceIdFor } = require('./store');
const { loadSecureChannel } = require('./identity');

const b64u = (b) => Buffer.from(b).toString('base64url');

// JSON-RPC methods a phone may send to the agent host. Everything else is refused by the relay.
const ALLOWED_REQUESTS = new Set([
  'initialize', 'reconnect', 'ping', 'subscribe', 'listSessions', 'createSession', 'disposeSession',
  'createChat', 'fetchTurns', 'completions', 'resolveSessionConfig', 'sessionConfigCompletions',
  'resourceList', 'resourceResolve', 'resourceRead',
]);
const ALLOWED_NOTIFICATIONS = new Set(['unsubscribe', 'dispatchAction']);

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
          reject(new RelayError('timeout', 'Timed out waiting for the phone'));
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

function collectProtectedResources(initResult) {
  const snapshots = initResult?.snapshots || (initResult?.type === 'snapshot' ? initResult.snapshots : null);
  const root = snapshots?.find((s) => s.resource === 'ahp-root://')?.state;
  if (!root?.agents) return null;
  const seen = new Map();
  for (const a of root.agents) for (const r of a.protectedResources || []) if (!seen.has(r.resource)) seen.set(r.resource, r);
  return [...seen.values()];
}

class RelayServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.identity         host identity from identity.loadHostIdentity
   * @param {import('./store').DeviceStore} o.store
   * @param {() => object|null} o.getAgentEndpoint
   * @param {(resources: object[]) => Promise<{resource:string, token:string, scopes?:string[]}[]>} o.getAuthTokens
   * @param {() => object[]} [o.getProtectedResources]
   * @param {(info: object) => Promise<boolean>} o.approveDevice
   * @param {() => string[]} o.allowedOrigins
   * @param {() => {requireApproval:boolean, passkey:'required'|'optional'|'off', passkeyGraceHours:number}} o.policy
   * @param {(device: object) => Promise<object>|object} o.welcomeExtras
   * @param {(uri: string) => boolean} [o.isReadAllowed]
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
    const url = new URL(req.url || '/', 'http://localhost');
    const common = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
    };
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
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
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
    this.ownRequests = new Map();
    this.ownSeq = 0;
    this.holdQueue = null;
    this.pendingInitIds = new Set();
    this.lastProtectedResources = null;
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
    if (hello.mode === 'resume' && !device) {
      this.relay._recordFailure(this.meta.ip);
      await this.sendControl({ t: 'error', code: 'unknown-device', message: 'This phone is not paired with this PC anymore. Scan a new QR code in VS Code.' });
      throw new RelayError('unknown-device', 'Unknown device', { quiet: true, closeCode: 4401 });
    }
    if (hello.mode === 'pair') device = await this._pair(hello, auth);
    else device = await this._verifyReturning(device);
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
      ...extras,
    });
    this.log('info', `Device "${fresh.name}" connected from ${this.meta.ip}`);
  }

  async _pair(hello, auth) {
    const { o } = this.relay;
    const policy = o.policy();
    const name = sanitizeText(auth.device?.name, 60) || 'Phone';
    const platform = sanitizeText(auth.device?.platform, 40);
    const id = deviceIdFor(hello.devicePublicKey);
    if (policy.requireApproval) {
      await this.sendControl({ t: 'pending', reason: 'approval' });
      const approved = await withTimeout(Promise.resolve(o.approveDevice({ name, platform, ip: this.meta.ip, origin: this.meta.origin, userAgent: this.meta.userAgent })), 180000, false);
      if (!approved) {
        await this.sendControl({ t: 'error', code: 'denied', message: 'Pairing was declined (or timed out) in VS Code.' });
        throw new RelayError('denied', 'Pairing declined', { quiet: true });
      }
    }
    let passkey = null;
    if (policy.passkey !== 'off') {
      const challenge = b64u(crypto.randomBytes(32));
      await this.sendControl({ t: 'passkey.register', challenge, userId: id, userName: name });
      const reply = await this._recvControl(180000);
      if (reply.t === 'passkey.registered') {
        try {
          passkey = webauthn.verifyRegistration(reply.credential, { challenge, allowedOrigins: this.relay.allowedOrigins() });
          passkey.createdAt = Date.now();
          passkey.lastVerifiedAt = Date.now();
        } catch (err) {
          this.log('warn', `Passkey registration failed: ${err.message}`);
          if (policy.passkey === 'required') {
            await this.sendControl({ t: 'error', code: 'passkey-failed', message: `Passkey setup failed: ${err.message}` });
            throw new RelayError('passkey-failed', err.message, { quiet: true });
          }
        }
      } else if (policy.passkey === 'required') {
        await this.sendControl({ t: 'error', code: 'passkey-required', message: `This PC requires a passkey (Face ID / fingerprint). ${sanitizeText(reply.reason, 200)}` });
        throw new RelayError('passkey-required', 'Passkey required', { quiet: true });
      }
    }
    const device = {
      id,
      name,
      platform,
      publicKey: b64u(hello.devicePublicKey),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      pwaOrigin: this.meta.origin,
      passkey,
      push: null,
    };
    o.store.add(device);
    this.relay.emit('paired', device);
    this.log('info', `Paired new device "${name}" (${platform || 'unknown platform'})`);
    return device;
  }

  async _verifyReturning(device) {
    const policy = this.relay.o.policy();
    if (policy.passkey === 'off') return device;
    if (!device.passkey) {
      if (policy.passkey === 'required') {
        await this.sendControl({ t: 'error', code: 'passkey-missing', message: 'This PC now requires a passkey. Remove the PC in the app and pair again.' });
        throw new RelayError('passkey-missing', 'Passkey missing', { quiet: true });
      }
      return device;
    }
    const graceMs = Math.max(0, Number(policy.passkeyGraceHours) || 0) * 3600 * 1000;
    if (Date.now() - (device.passkey.lastVerifiedAt || 0) < graceMs) return device;
    const challenge = b64u(crypto.randomBytes(32));
    await this.sendControl({ t: 'passkey.challenge', challenge, credentialId: device.passkey.credentialId, rpId: device.passkey.rpId });
    const reply = await this._recvControl(180000);
    this._assertStillPaired(device.id);
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
    const ep = this.relay.o.getAgentEndpoint();
    if (!ep) {
      await this.sendControl({ t: 'ahp.status', connected: false, reason: 'The VS Code agent host is not running.' });
      throw new RelayError('no-agent-host', 'Agent host not available', { quiet: true, closeCode: 4503 });
    }
    try {
      this.ahp = await agentHost.openConnection(ep);
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
      this.sendControl({ t: 'ahp.status', connected: false, reason: 'The VS Code agent host connection closed.' }).finally(() => this.close(4503, 'Agent host disconnected'));
    });
    this.ahp.on('error', () => {});
    await this.sendControl({ t: 'ahp.status', connected: true, protocolVersion: ep.protocolVersion });
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
      if (isRequest && (msg.method === 'initialize' || msg.method === 'reconnect')) this.pendingInitIds.add(msg.id);
    }
    if (this.holdQueue) this.holdQueue.push(text);
    else this.ahp.send(text);
  }

  _fromHost(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      if (typeof msg.id === 'string' && msg.id.startsWith('pp:')) {
        const p = this.ownRequests.get(msg.id);
        if (p) {
          this.ownRequests.delete(msg.id);
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
          else p.resolve(msg.result);
        }
        return;
      }
      if (this.pendingInitIds.delete(msg.id)) {
        this._sendAhp(text);
        if (msg.result) this._authenticate(collectProtectedResources(msg.result));
        return;
      }
    } else if (msg.method === 'auth/required') {
      this._authenticate(null);
      return;
    }
    this._sendAhp(text);
  }

  _ownRequest(method, params, timeoutMs = 15000) {
    const id = `pp:${++this.ownSeq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.ownRequests.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.ownRequests.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ahp.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Pushes the PC's GitHub tokens to the agent host for this connection. Tokens never reach the phone. */
  _authenticate(resources) {
    if (resources) this.lastProtectedResources = resources;
    const list = resources || this.lastProtectedResources || (this.relay.o.getProtectedResources ? this.relay.o.getProtectedResources() : []) || [];
    if (!this.holdQueue) this.holdQueue = [];
    const run = async () => {
      let tokens = [];
      try {
        tokens = await withTimeout(Promise.resolve(this.relay.o.getAuthTokens(list)), 15000, []);
      } catch (err) {
        this.log('warn', `Could not get GitHub tokens: ${err.message}`);
      }
      for (const t of tokens || []) {
        try {
          await this._ownRequest('authenticate', { channel: 'ahp-root://', resource: t.resource, token: t.token, ...(t.scopes ? { scopes: t.scopes } : {}) });
        } catch (err) {
          this.log('warn', `authenticate(${t.resource}) failed: ${err.message}`);
        }
      }
    };
    run().finally(() => {
      const q = this.holdQueue || [];
      this.holdQueue = null;
      for (const m of q) if (this.ahp) this.ahp.send(m);
    });
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
      default:
        break;
    }
  }

  // ---------------------------------------------------------- lifecycle

  _fail(err) {
    if (this.state === 'closed') return;
    if (!err.quiet && err.code !== 'closed') this.log('warn', `Phone connection from ${this.meta.ip} failed: ${err.message}`);
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
    for (const p of this.ownRequests.values()) p.reject(new Error('closed'));
    this.ownRequests.clear();
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

module.exports = { RelayServer, RelayError, ALLOWED_REQUESTS, ALLOWED_NOTIFICATIONS, collectProtectedResources };
