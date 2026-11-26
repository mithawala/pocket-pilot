'use strict';
// Pages a session runs on this computer (a dev server at http://localhost:5173, a review page at
// http://127.0.0.1:5182), opened on a paired device. A page needs a web address of its own: it asks for
// `/api/…` and its pictures from the start of its address, and keeps its own storage. So each local port
// gets its own Cloudflare quick tunnel, to a proxy here that lets only the device that asked through: the
// device gets a one-time key over its end-to-end encrypted connection (RelayServer), and the first visit
// exchanges it for a cookie that only that browser has. Without it, nothing reaches the page.
//
// A page is not end-to-end encrypted like the chat: Cloudflare handles it like any https website. The
// local server sees requests as from a browser on this computer (its own address as Host, Origin and
// Referer), so dev servers that only accept those (Vite, webpack) work, and the device's cookie never
// reaches it. A page closes after 30 minutes without use.
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { TunnelManager } = require('./tunnel');

const COOKIE = '__Host-pp-preview';
const PREFIX = '/__pocket-pilot/';
const ENTER = `${PREFIX}enter`;
const READY = `${PREFIX}ready`;
// Our own answer to READY: a page reached through the tunnel is this proxy, not a Cloudflare error page.
const ID_HEADER = 'x-pocket-pilot-preview';

const IDLE_MS = 30 * 60 * 1000;
const KEY_MS = 5 * 60 * 1000;
const SESSION_MS = 12 * 3600 * 1000;
const MAX_PREVIEWS = 4;
const MAX_SESSIONS = 20;
const MAX_KEYS = 20;

// Debuggers (Chrome's remote debugging, Node's inspector) run any code they are asked to: never opened.
const DEBUG_PORTS = new Set([9222, 9229]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Not passed on to the local server: hop-by-hop headers, and what Cloudflare adds about the visitor.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'expect']);
const VISITOR = new Set(['cdn-loop', 'true-client-ip', 'x-real-ip', 'forwarded']);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const newToken = () => crypto.randomBytes(32).toString('base64url');
const problem = (code, message) => Object.assign(new Error(message), { code });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const defaultPort = (scheme) => (scheme === 'https' ? 443 : 80);

/** Where a host name as written (localhost, 127.0.0.1, [::1], 0.0.0.0) answers on this computer. */
function addressesOf(host) {
  if (host === '127.0.0.1') return ['127.0.0.1'];
  if (host === '[::1]') return ['::1'];
  return ['127.0.0.1', '::1'];
}

function canConnect(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      clearTimeout(t);
      s.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), ms);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** The first address something answers on at `port`, or null. */
async function answering(host, port) {
  for (const a of addressesOf(host)) if (await canConnect(a, port)) return a;
  return null;
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function withoutCookie(header, name) {
  return String(header || '').split(';').map((p) => p.trim()).filter((p) => p && p.split('=')[0].trim() !== name).join('; ');
}

/**
 * A passed-through socket whose `from` side ended: `to` ends as well once what it was sending is out, and
 * both close (a WebSocket ends whole; neither side is left half open).
 */
function endTogether(from, to) {
  from.once('end', () => {
    const t = setTimeout(() => to.destroy(), 5000);
    t.unref?.();
    to.end(() => {
      clearTimeout(t);
      to.destroy();
    });
  });
}

/** A path on the page to start at (from the link), percent-encoded: never somewhere else (`//host`, `/\host`). */
function safePath(p) {
  const s = String(p || '/');
  if (!s.startsWith('/') || /^\/[/\\]/.test(s)) return '/';
  try {
    const u = new URL(s, 'http://x');
    const out = `${u.pathname}${u.search}${u.hash}`;
    // `/.//host` is `//host` once normalized.
    return /^\/[/\\]/.test(out) ? '/' : out;
  } catch {
    return '/';
  }
}

function page(res, status, title, text) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#21252b;color:#d7dae0}main{max-width:26rem;padding:28px}h1{font-size:20px;line-height:1.3;margin:0 0 10px;color:#fff}p{margin:0;color:#abb2bf}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  });
  res.end(body);
}

/**
 * Waits until a new tunnel address answers with this preview's proxy. A brand-new trycloudflare.com name
 * that is looked up too early is remembered as missing for a minute (by this computer's resolver, or the
 * device's), so Cloudflare's own name servers, which remember nothing, are asked first.
 */
async function waitServed(url, id, { log = () => {}, timeoutMs = 30000 } = {}) {
  const end = Date.now() + timeoutMs;
  const { hostname } = new URL(url);
  if (/\.trycloudflare\.com$/i.test(hostname)) await untilResolvable(hostname, Math.min(end, Date.now() + 20000));
  let last = null;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${url}${READY}`, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (res.headers.get(ID_HEADER) === id) return true;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await sleep(700);
  }
  // This computer may be unable to reach its own tunnel (a network filter) while the device can.
  log('warn', `This computer can't reach ${url} (${last?.cause?.code || last?.message || 'no answer'}); the device may still can`);
  return false;
}

async function untilResolvable(hostname, end) {
  let servers = [];
  try {
    const zone = hostname.split('.').slice(-2).join('.');
    const ns = await dns.promises.resolveNs(zone);
    servers = (await Promise.all(ns.map((n) => dns.promises.resolve4(n).catch(() => [])))).flat().slice(0, 6);
  } catch {
    /* no name servers: wait instead */
  }
  if (servers.length) {
    const r = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
    r.setServers(servers);
    while (Date.now() < end) {
      try {
        if ((await r.resolve4(hostname)).length) return;
      } catch (err) {
        // Not there yet; anything else (a network that blocks such lookups): wait instead.
        if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) break;
      }
      await sleep(500);
    }
    if (Date.now() >= end) return;
  }
  await sleep(Math.min(8000, end - Date.now()));
}

/** One local port, its proxy and its tunnel. */
class Preview {
  constructor({ web, log }) {
    this.key = web.key;
    this.scheme = web.scheme;
    this.port = web.port;
    // The host as the agent wrote it, which the local server expects to see (0.0.0.0 isn't one to visit).
    this.hostName = web.host === '0.0.0.0' ? '127.0.0.1' : web.host;
    const authority = `${this.hostName}${this.port === defaultPort(this.scheme) ? '' : `:${this.port}`}`;
    this.hostHeader = authority;
    this.localOrigin = `${this.scheme}://${authority}`;
    this.address = `${web.host === '0.0.0.0' ? '127.0.0.1' : web.host}:${this.port}`;
    this.log = log;
    this.id = newToken();
    this.keys = new Map();
    this.sessions = new Map();
    this.sockets = new Set();
    this.devices = new Set();
    this.addr = null;
    this.addrAt = 0;
    this.lastUsed = Date.now();
    this.createdAt = Date.now();
    this.publicUrl = null;
    this.publicOrigin = null;
    this.closed = false;
    this.server = http.createServer((req, res) => this._request(req, res));
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head).catch(() => socket.destroy()));
    this.server.on('clientError', (err, socket) => socket.destroy());
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  async start(startTunnel, served) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.proxyPort = this.server.address().port;
    this.tunnel = await startTunnel(this.proxyPort, this);
    if (this.closed) {
      await this.tunnel.stop();
      throw problem('closed', 'The page was closed');
    }
    this.publicUrl = this.tunnel.url.replace(/\/+$/, '');
    this.publicOrigin = new URL(this.publicUrl).origin;
    await served(this.publicUrl, this.id);
  }

  /** A one-time link for a device, to the page at `to`. */
  enter(to, deviceId) {
    const now = Date.now();
    for (const [k, v] of this.keys) if (v.expiresAt <= now) this.keys.delete(k);
    while (this.keys.size >= MAX_KEYS) this.keys.delete(this.keys.keys().next().value);
    const key = newToken();
    this.keys.set(key, { deviceId, expiresAt: now + KEY_MS });
    this.devices.add(deviceId);
    // Not a use of the page: the app keeps a link ready while its sheet is open.
    return `${this.publicUrl}${ENTER}?k=${key}&to=${encodeURIComponent(safePath(to))}`;
  }

  /** Someone used the page (opened its link in the chat, or the page itself). */
  touch() {
    this.lastUsed = Date.now();
  }

  /** A device was removed: its links stop working, and its open connections to the page end. */
  forgetDevice(deviceId) {
    for (const [k, v] of this.keys) if (v.deviceId === deviceId) this.keys.delete(k);
    for (const [sid, s] of [...this.sessions]) if (s.deviceId === deviceId) this._endSession(sid);
    this.devices.delete(deviceId);
  }

  /** Links and visits that ran out end, and so do their open connections. */
  expire(now = Date.now()) {
    for (const [k, v] of this.keys) if (v.expiresAt <= now) this.keys.delete(k);
    for (const [sid, s] of [...this.sessions]) if (now - s.createdAt > SESSION_MS) this._endSession(sid);
  }

  /** Whether its tunnel is connected to Cloudflare; one that just lost it (the computer woke up) gets a few seconds. */
  async healthy(waitMs = 4000) {
    if (!this.tunnel?.ready) return true;
    const end = Date.now() + waitMs;
    for (;;) {
      if (await this.tunnel.ready()) return true;
      if (this.closed || Date.now() >= end) return false;
      await sleep(500);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.keys.clear();
    this.sessions.clear();
    for (const s of this.sockets) s.destroy();
    this.server.close();
    await this.tunnel?.stop().catch(() => {});
  }

  // ---------------------------------------------------------------- requests

  _session(req) {
    const sid = cookieValue(req.headers.cookie, COOKIE);
    const s = sid ? this.sessions.get(sid) : null;
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_MS) {
      this._endSession(sid);
      return null;
    }
    return s;
  }

  _newSession(deviceId, now) {
    if (this.sessions.size >= MAX_SESSIONS) {
      let oldest = null;
      for (const [sid, s] of this.sessions) if (!oldest || s.lastUsed < this.sessions.get(oldest).lastUsed) oldest = sid;
      this._endSession(oldest);
    }
    const sid = newToken();
    this.sessions.set(sid, { deviceId, createdAt: now, lastUsed: now, conns: new Set() });
    return sid;
  }

  _endSession(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    for (const c of s.conns) c.destroy();
    s.conns.clear();
  }

  /** A connection a visit keeps open (a response on its way, a WebSocket): it ends with the visit. */
  _track(session, conn) {
    session.conns.add(conn);
    conn.once('close', () => session.conns.delete(conn));
  }

  /**
   * Requests from the page itself, or a link to it. Other sites may link to the page, but can't use it
   * from their own pages (a form that posts to it, a frame, a script). Browsers say where a request
   * comes from (Sec-Fetch-Site); Origin covers older ones.
   */
  _fromPage(req, websocket = false) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      if (websocket || req.headers['sec-fetch-mode'] !== 'navigate' || /^(iframe|frame|embed|object|fencedframe)$/.test(req.headers['sec-fetch-dest'] || '')) return false;
    }
    const origin = req.headers.origin;
    if (websocket) return origin === this.publicOrigin;
    return !origin || origin === this.publicOrigin || SAFE_METHODS.has(req.method);
  }

  _request(req, res) {
    try {
      const url = req.url || '/';
      // Only paths: a full address as the target (as sent to a proxy) has no place here.
      if (!url.startsWith('/')) return page(res, 400, 'Bad request', 'This is not a page address.');
      if (url.startsWith(PREFIX)) return this._own(req, res, url);
      const session = this._session(req);
      if (!session) return page(res, 401, 'Open this page from Pocket Pilot', 'This page runs on a computer and only opens from Pocket Pilot on a phone paired with it. Tap its link in the chat again.');
      if (!this._fromPage(req)) return page(res, 403, 'Not allowed', 'This page can only be used from its own address.');
      session.lastUsed = this.lastUsed = Date.now();
      this._track(session, res);
      this._forward(req, res).catch((err) => this._failed(res, err));
    } catch (err) {
      this._failed(res, err);
    }
    return undefined;
  }

  _failed(res, err) {
    this.log('warn', `Page ${this.address}: ${err?.message || err}`);
    if (!res.headersSent) page(res, 502, 'Something went wrong', 'Pocket Pilot couldn’t pass this request on to the page.');
    else res.destroy();
  }

  _own(req, res, url) {
    const u = new URL(url, 'http://x');
    if (u.pathname === READY) {
      res.writeHead(204, { [ID_HEADER]: this.id, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
      return res.end();
    }
    if (u.pathname !== ENTER || !['GET', 'HEAD'].includes(req.method)) return page(res, 404, 'Not found', 'There is nothing here.');
    const to = safePath(u.searchParams.get('to'));
    const k = u.searchParams.get('k') || '';
    const key = this.keys.get(k);
    const now = Date.now();
    if (key && key.expiresAt > now && req.method === 'GET') {
      this.keys.delete(k);
      this.lastUsed = now;
      // The same device's browser, let in before: it keeps the visit it has.
      const current = this._session(req);
      if (current && current.deviceId === key.deviceId) {
        current.lastUsed = now;
        res.writeHead(303, { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' });
        return res.end();
      }
      const sid = this._newSession(key.deviceId, now);
      res.writeHead(303, {
        location: to,
        'set-cookie': `${COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      });
      return res.end();
    }
    // Used before (the tab reloaded): fine for the browser that used it.
    if (this._session(req)) {
      res.writeHead(303, { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end();
    }
    return page(res, 401, 'This link has run out', 'Each link opens the page once, within a few minutes. Tap Open page in Pocket Pilot again.');
  }

  /** The address the page answers on (127.0.0.1 or ::1 for localhost), looked up again now and then. */
  async _target() {
    if (this.addr && Date.now() - this.addrAt < 30000) return this.addr;
    this.addr = await answering(this.hostName, this.port);
    this.addrAt = Date.now();
    return this.addr;
  }

  _tlsOptions() {
    // The page's own certificate on this computer (often self-signed): what matters is that it's local.
    return { rejectUnauthorized: false, ...(net.isIP(this.hostName.replace(/^\[|\]$/g, '')) ? {} : { servername: this.hostName }) };
  }

  /** The request's headers as the local server should see them. */
  _upstreamHeaders(req) {
    const out = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP.has(name) || VISITOR.has(name) || name.startsWith('cf-') || name.startsWith('x-forwarded-')) continue;
      out[name] = value;
    }
    out.host = this.hostHeader;
    const cookie = withoutCookie(req.headers.cookie, COOKIE);
    if (cookie) out.cookie = cookie;
    else delete out.cookie;
    if (out.origin === this.publicOrigin) out.origin = this.localOrigin;
    if (typeof out.referer === 'string' && (out.referer === this.publicOrigin || out.referer.startsWith(`${this.publicOrigin}/`))) out.referer = this.localOrigin + out.referer.slice(this.publicOrigin.length);
    return out;
  }

  /** A link back to the page's own address (a redirect): to its address on the device instead. */
  _public(location) {
    try {
      const u = new URL(location);
      const host = u.hostname.toLowerCase();
      const port = Number(u.port || defaultPort(u.protocol.slice(0, -1)));
      if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(host) && port === this.port && u.protocol === `${this.scheme}:`) return `${this.publicOrigin}${u.pathname}${u.search}${u.hash}`;
    } catch {
      /* a path: stays as it is */
    }
    return location;
  }

  _downstreamHeaders(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) if (!HOP.has(name)) out[name] = value;
    if (typeof out.location === 'string') out.location = this._public(out.location);
    // Cookies for the local server's host name would never be sent to the page's address.
    if (out['set-cookie']) out['set-cookie'] = [].concat(out['set-cookie']).map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
    out['x-robots-tag'] = 'noindex, nofollow';
    return out;
  }

  async _forward(req, res) {
    const addr = await this._target();
    // The visit ended meanwhile (its device was removed): nothing more reaches the page.
    if (res.destroyed) return undefined;
    if (!addr) return page(res, 502, 'The page isn’t running', `Nothing is answering at ${this.address} on the computer. If its server stopped, start it again, then reload this page.`);
    const mod = this.scheme === 'https' ? https : http;
    const up = mod.request({ host: addr, port: this.port, method: req.method, path: req.url, headers: this._upstreamHeaders(req), ...(this.scheme === 'https' ? this._tlsOptions() : {}) });
    up.on('response', (r) => {
      res.writeHead(r.statusCode, r.statusMessage, this._downstreamHeaders(r.headers));
      r.pipe(res);
      r.on('data', () => {
        this.lastUsed = Date.now();
      });
    });
    up.on('error', (err) => {
      if (['ECONNREFUSED', 'ECONNRESET'].includes(err.code)) this.addr = null;
      if (!res.headersSent) page(res, 502, 'The page isn’t running', `Nothing is answering at ${this.address} on the computer. If its server stopped, start it again, then reload this page.`);
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  }

  /** WebSockets (a dev server's live reload): passed through as they are, once allowed. */
  async _upgrade(req, socket, head) {
    socket.on('error', () => {});
    const refuse = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    };
    const session = this._session(req);
    if (!session) return refuse(401, 'Unauthorized');
    if (!this._fromPage(req, true)) return refuse(403, 'Forbidden');
    const addr = await this._target();
    if (!addr) return refuse(502, 'Bad Gateway');
    // Gone meanwhile: the socket, or the visit (its device was removed).
    if (socket.destroyed || this.sessions.get(cookieValue(req.headers.cookie, COOKIE)) !== session) return socket.destroy();
    session.lastUsed = this.lastUsed = Date.now();
    this._track(session, socket);
    const secure = this.scheme === 'https';
    const target = secure ? tls.connect({ host: addr, port: this.port, ...this._tlsOptions() }) : net.connect({ host: addr, port: this.port });
    target.on('error', () => socket.destroy());
    socket.on('close', () => target.destroy());
    target.on('close', () => socket.destroy());
    this.sockets.add(target);
    target.on('close', () => this.sockets.delete(target));
    target.once(secure ? 'secureConnect' : 'connect', () => {
      const headers = this._upstreamHeaders(req);
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(headers)) for (const v of [].concat(value)) raw += `${name}: ${v}\r\n`;
      raw += `connection: Upgrade\r\nupgrade: ${req.headers.upgrade}\r\n\r\n`;
      target.write(raw);
      if (head?.length) target.write(head);
      const touch = () => {
        this.lastUsed = Date.now();
      };
      target.on('data', touch);
      socket.on('data', touch);
      socket.pipe(target, { end: false });
      target.pipe(socket, { end: false });
      endTogether(socket, target);
      endTogether(target, socket);
    });
  }
}

class PreviewManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.storageDir]  where each page's tunnel keeps its files
   * @param {() => string|null} [o.findBinary]  cloudflared
   * @param {(port: number, preview: Preview) => Promise<{url: string, stop: () => Promise<void>, ready?: () => Promise<boolean>}>} [o.startTunnel]
   * @param {(url: string, id: string) => Promise<unknown>} [o.waitServed]
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {number} [o.idleMs]
   * @param {number} [o.healthWaitMs]  how long a tunnel that lost its connection gets to come back when a page is opened
   */
  constructor(o = {}) {
    super();
    this.o = o;
    this.log = o.log || (() => {});
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.previews = new Map();
    // Every page tunnel that runs, also while it starts: all end when Pocket Pilot does.
    this._tunnels = new Set();
    this._startTunnel = o.startTunnel || ((port, p) => this._quickTunnel(port, p));
    this._served = o.waitServed || ((url, id) => waitServed(url, id, { log: this.log }));
    this._timer = setInterval(() => this._sweep(), Math.min(60000, this.idleMs));
    this._timer.unref?.();
    this._stale = this._endStale();
  }

  /** The proxies' own ports, which a link never opens. */
  ownPorts() {
    return [...this.previews.values()].map((p) => p.proxyPort).filter(Boolean);
  }

  /** A port no device may open: a debugger, or one of these proxies. */
  isBlocked(port) {
    return DEBUG_PORTS.has(port) || this.ownPorts().includes(port);
  }

  /** The pages open now, for the computer's panel. */
  list() {
    return [...this.previews.values()].filter((p) => p.publicUrl && !p.closed).map((p) => ({ key: p.key, address: p.address, url: p.publicUrl, lastUsed: p.lastUsed, createdAt: p.createdAt, devices: p.devices.size }));
  }

  /**
   * A one-time link to the page `web` (from localWebUrl) for a device: `{ url, expiresIn, address }`.
   * `first`: the person tapped the page's link, which counts as using it, and opens it (its tunnel takes a
   * few seconds) if it isn't open. Otherwise it's a new link for a sheet that shows one, for a page that
   * must still be open. Rejects with a `code`: not-running, no-cloudflared, tunnel, blocked, gone (closed
   * meanwhile) or closed (Pocket Pilot is stopping).
   */
  async open(web, { deviceId = null, first = true } = {}) {
    const stopping = () => problem('closed', 'Pocket Pilot is stopping');
    if (this.closed) throw stopping();
    if (this.isBlocked(web.port)) throw problem('blocked', 'This address belongs to Pocket Pilot or a debugger, so it can’t be opened from your phone');
    const host = web.host === '0.0.0.0' ? '127.0.0.1' : web.host;
    if (first) {
      if (!(await answering(host, web.port))) throw problem('not-running', `Nothing is answering at ${host}:${web.port} on your computer. If its server stopped, ask the agent to start it again.`);
      await this._stale;
      // A tunnel that lost its connection to Cloudflare (the computer slept) gives links that lead nowhere.
      const old = this.previews.get(web.key);
      if (old?.publicUrl && !old.closed && !(await old.healthy(this.o.healthWaitMs)) && this.previews.get(web.key) === old) {
        this.log('warn', `Page ${old.address}: its tunnel lost its connection to Cloudflare; opening a new one`);
        await this.close(web.key);
      }
      if (this.closed) throw stopping();
    }
    const gone = () => problem('gone', 'This page was closed on your computer');
    let p = this.previews.get(web.key);
    if (!p || p.closed) {
      if (!first) throw gone();
      p = new Preview({ web, log: this.log });
      this.previews.set(web.key, p);
      this._limit(p);
      p.starting = p.start(this._startTunnel, this._served).then(() => {
        this.log('info', `Page ${p.address} opens at ${p.publicUrl}`);
        this.emit('change');
      }, async (err) => {
        if (this.previews.get(web.key) === p) this.previews.delete(web.key);
        await p.close();
        this.emit('change');
        throw err.code ? err : problem('tunnel', `Couldn’t open a private link: ${err.message}`);
      });
    }
    await p.starting;
    if (p.closed) throw this.closed ? stopping() : gone();
    if (first) p.touch();
    const url = p.enter(web.path, deviceId);
    this.emit('change');
    return { url, expiresIn: KEY_MS / 1000, address: p.address };
  }

  /** Closes a page (its tunnel ends). */
  async close(key) {
    const p = this.previews.get(key);
    if (!p) return;
    this.previews.delete(key);
    await p.close();
    this.log('info', `Page ${p.address} closed`);
    this.emit('change');
  }

  async closeAll() {
    this.closed = true;
    clearInterval(this._timer);
    const all = [...this.previews.values()];
    this.previews.clear();
    await Promise.allSettled([...all.map((p) => p.close()), ...[...this._tunnels].map((t) => t.stop())]);
    if (all.length) this.emit('change');
  }

  /** Ends every page's tunnel at once, without waiting (this process is exiting). */
  killNow() {
    for (const t of this._tunnels) t.killNow();
  }

  /** A device was removed: its links and visits end. */
  forgetDevice(deviceId) {
    for (const p of this.previews.values()) p.forgetDevice(deviceId);
  }

  _limit(keep) {
    const open = [...this.previews.values()].filter((p) => p !== keep).sort((a, b) => a.lastUsed - b.lastUsed);
    while (open.length >= MAX_PREVIEWS) {
      const p = open.shift();
      this.close(p.key).catch(() => {});
    }
  }

  _sweep() {
    const now = Date.now();
    for (const p of [...this.previews.values()]) {
      p.expire(now);
      if (p.publicUrl && now - p.lastUsed > this.idleMs) {
        this.log('info', `Page ${p.address} wasn’t used for ${Math.round(this.idleMs / 60000)} minutes`);
        this.close(p.key).catch(() => {});
      }
    }
  }

  _dir(key) {
    return path.join(this.o.storageDir, key.replace(/[^\w-]/g, '-'));
  }

  /** A quick tunnel to a proxy, ended with it; it isn't started again if it drops (the page closes). */
  async _quickTunnel(port, p) {
    const bin = this.o.findBinary?.();
    if (!bin) throw problem('no-cloudflared', 'cloudflared isn’t installed on your computer. Start Pocket Pilot with the quick tunnel once.');
    const t = new TunnelManager({ storageDir: this._dir(p.key), restart: false, metrics: true, log: (l, m) => this.log(l, `Page ${p.address}: ${m}`) });
    this._tunnels.add(t);
    const stop = async () => {
      await t.stop();
      this._tunnels.delete(t);
    };
    let url;
    try {
      url = await t.start(port, bin);
    } catch (err) {
      await stop();
      throw err;
    }
    t.on('state', ({ state }) => {
      if (state === 'error' && this.previews.get(p.key) === p && !p.closed) {
        this.log('warn', `Page ${p.address}: its tunnel stopped`);
        this.close(p.key).catch(() => {});
      }
    });
    return { url, stop, ready: () => t.ready() };
  }

  /** Ends the tunnels an earlier Pocket Pilot left running (it ended without closing its pages). */
  async _endStale() {
    if (!this.o.storageDir) return;
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.o.storageDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(this.o.storageDir, d.name));
    } catch {
      return;
    }
    await Promise.allSettled(dirs.map((dir) => new TunnelManager({ storageDir: dir, log: this.log })._killStale()));
  }
}

module.exports = { PreviewManager, waitServed, DEBUG_PORTS, COOKIE, ENTER, READY, ID_HEADER, KEY_MS, IDLE_MS, SESSION_MS, MAX_SESSIONS };
