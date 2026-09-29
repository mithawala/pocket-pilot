// The Pocket Pilot hub for the GitHub Copilot app and CLI. One chat's extension process hosts it
// (whoever takes the lock first); the others connect to it over 127.0.0.1. It runs the same end-to-end
// encrypted relay, Cloudflare quick tunnel, pairing, passkeys and push notifications as the VS Code
// extension, and serves every attached Copilot session to the phone over the Agent Host Protocol.
// When the hosting chat is closed or deleted, another open chat takes over within seconds: the
// Cloudflare tunnel keeps running on its own and the new hub listens on the same local port, so the
// public address stays the same and paired devices simply reconnect (also after an app restart).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, ensureHome, readJson, writeJson, newToken, serve, Rpc, takeLock, touchLock, releaseLock, connect, hubAlive } from './ipc.mjs';
import { CopilotAgentHost, isInside } from './agent-host.mjs';
import { pairingPage } from './pairing-page.mjs';
import { renderQrSvg } from './qr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '..', 'vendor');
const require = createRequire(import.meta.url);
const core = (m) => require(path.join(vendor, 'extension', 'core', `${m}.js`));

const VERSION = readJson(path.join(here, '..', 'version.json'), {})?.version || 'dev';
const PWA_URL = process.env.POCKET_PILOT_PWA_URL || 'https://mithawala.github.io/pocket-pilot/app/';
const PAIR_MS = 10 * 60 * 1000;
const PUSH_SUBJECT = 'mailto:pocket-pilot@users.noreply.github.com';

export function hubLog(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  try {
    ensureHome();
    if (fs.existsSync(FILES.log) && fs.statSync(FILES.log).size > 2 * 1024 * 1024) fs.renameSync(FILES.log, `${FILES.log}.1`);
    fs.appendFileSync(FILES.log, line, { mode: 0o600 });
  } catch {
    /* logging is best effort */
  }
  if (process.env.POCKET_PILOT_HUB_STDOUT) process.stderr.write(line);
}

const settings = () => ({ passkey: 'required', authenticatorApp: true, requireApproval: true, tunnel: 'quick', customUrl: '', notify: { input: true, done: true, error: true }, ...readJson(FILES.state, {})?.settings });
const HOST_NAME = `${os.hostname()} · Copilot`;

// ---------------------------------------------------------------- the pairing page's server
// One per process, and it outlives the hub: when remote access is turned off, the Pocket Pilot panel stays
// connected, shows that remote access is off and can turn it on again. While a hub runs, it answers.
const page = { server: null, key: null, handler: null, turningOn: false, error: null };
let hubOptions = {};

async function pageServer() {
  if (page.server) return page;
  page.key = newToken();
  page.server = http.createServer((req, res) => {
    servePage(req, res).catch((err) => {
      hubLog('warn', `Pairing page: ${err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end();
    });
  });
  await new Promise((r) => page.server.listen(0, '127.0.0.1', r));
  page.server.unref();
  return page;
}

const pageUrl = () => `http://127.0.0.1:${page.server.address().port}/pair?k=${page.key}`;

/** Closes the page server (when the process is done with Pocket Pilot, and in tests). */
export function closePageServer() {
  page.server?.closeAllConnections?.();
  page.server?.close();
  Object.assign(page, { server: null, key: null, handler: null });
}

async function servePage(req, res) {
  let u;
  try {
    u = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const port = page.server.address().port;
  // `embed=1`: shown as a panel (canvas) in the GitHub Copilot app, which may frame it.
  const embed = u.searchParams.get('embed') === '1';
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      ...(embed ? {} : { 'x-frame-options': 'DENY' }),
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; img-src https://mithawala.github.io data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  // Only this machine, only with the key the extensions received, and no DNS-rebinding host names.
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(403, 'Forbidden', 'text/plain');
  const k = Buffer.from(u.searchParams.get('k') || '');
  const want = Buffer.from(page.key);
  if (k.length !== want.length || !crypto.timingSafeEqual(k, want)) return send(403, 'Forbidden', 'text/plain');
  const body = async () => {
    let raw = '';
    for await (const c of req) {
      raw += c;
      if (raw.length > 10000) break;
    }
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  };
  const route = `${req.method} ${u.pathname}`;
  if (route === 'GET /pair') return send(200, pairingPage({ key: page.key, hostName: HOST_NAME, embed, appUrl: PWA_URL }), 'text/html; charset=utf-8');
  const out = await (page.handler || whileOff)(route, body);
  return out === undefined ? send(404, 'Not found', 'text/plain') : send(200, out);
}

/** The page's requests while remote access is off (or while another chat's process runs the hub). */
async function whileOff(route, body) {
  const { DeviceStore } = core('store');
  switch (route) {
    case 'GET /pair/state': {
      // Turned on meanwhile, and another chat's process runs the hub: the panel moves to its page.
      const info = readJson(FILES.hub);
      if (hubAlive(info) && info.pid !== process.pid) {
        const moved = await otherPage(info).catch(() => null);
        if (moved) return { moved };
      }
      const devices = new DeviceStore(FILES.devices).list().map((d) => ({ id: d.id, name: d.name, platform: d.platform, online: false, passkey: !!d.passkey, totp: !!d.totp }));
      return { on: false, turningOn: page.turningOn, error: page.error, version: VERSION, hostName: HOST_NAME, devices };
    }
    case 'POST /pair/on':
      turnOn();
      return { ok: true };
    case 'POST /pair/off':
      return { ok: true };
    case 'POST /pair/remove': {
      const b = await body();
      const store = new DeviceStore(FILES.devices);
      const d = store.get(String(b.id || ''));
      if (d) {
        store.remove(d.id);
        hubLog('info', `Removed device "${d.name}"`);
      }
      return { ok: !!d };
    }
    default:
      return undefined;
  }
}

async function otherPage(info) {
  const ch = await connect(info.port, info.token, { pid: process.pid });
  try {
    return (await new Rpc(ch, {}).request('status', {}, 5000))?.pageUrl || null;
  } finally {
    ch.close();
  }
}

/** Turns remote access on from the page: the chat hosting this process starts the hub again. */
async function turnOn() {
  if (page.turningOn) return;
  page.turningOn = true;
  page.error = null;
  try {
    writeJson(FILES.state, { ...(readJson(FILES.state, {}) || {}), enabled: true, changedAt: new Date().toISOString() });
    hubLog('info', 'Remote access turned on from the pairing page');
    if (hubOptions.onTurnOn) await hubOptions.onTurnOn();
    else await startHub(hubOptions);
  } catch (err) {
    page.error = err.message;
    hubLog('error', `Could not turn remote access on: ${err.message}`);
  } finally {
    page.turningOn = false;
  }
}

/**
 * Starts the hub in this process. Resolves to null if another process already hosts it.
 * `onTurnOn`: how the pairing page turns remote access on again (the hosting chat restarts the hub).
 */
export async function startHub(options = {}) {
  if (options && Object.keys(options).length) hubOptions = options;
  if (!takeLock()) return null;
  const cleanups = [];
  // Keep the lock fresh so a crashed hub (or a reused PID) is recognised, and stop if the lock or
  // remote access is taken away (for example `/pocket-pilot off` in a session that wasn't attached).
  const life = { stop: null };
  const beat = setInterval(() => {
    if (!touchLock()) life.stop?.('another process took over the hub', { keepTunnel: true });
    else if (readJson(FILES.state, {})?.enabled === false) life.stop?.('remote access was turned off');
  }, 10000);
  beat.unref?.();
  cleanups.push(() => clearInterval(beat));
  try {
    const hub = await boot(hubLog, cleanups);
    life.stop = hub.stop;
    return hub;
  } catch (err) {
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        /* ignore */
      }
    }
    releaseLock();
    throw err;
  }
}

async function boot(log, cleanups) {
  const { RelayServer } = core('relay');
  const { DeviceStore, FileSecrets } = core('store');
  const identityLib = core('identity');
  const { SessionMonitor } = core('monitor');
  const { PersistentTunnel } = core('tunnel');
  const { GistRendezvous } = core('rendezvous');
  const push = core('push');
  const ahpTypes = await import(pathToFileURL(path.join(vendor, 'pwa', 'vendor', 'ahp', 'types', 'index.js')).href);

  // ---------------------------------------------------------------- identity
  const secrets = new FileSecrets(FILES.secrets);
  const hostName = HOST_NAME;
  const identity = await identityLib.loadHostIdentity(secrets, hostName);
  const vapid = await identityLib.loadVapid(secrets);
  const run = (args) => new Promise((resolve) => execFile('gh', args, { timeout: 8000, windowsHide: true }, (err, out, errOut) => resolve(err ? null : `${out}\n${errOut}`)));
  /** A GitHub CLI token that can own the rendezvous gist (Enterprise Managed Users cannot). */
  async function githubToken() {
    if (process.env.POCKET_PILOT_GITHUB_TOKEN) return process.env.POCKET_PILOT_GITHUB_TOKEN;
    const out = await run(['auth', 'status']);
    if (!out) return null;
    const accounts = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /Logged in to github\.com account (\S+)/.exec(line);
      if (m) accounts.push({ login: m[1], active: false });
      else if (/Active account: true/.test(line) && accounts.length) accounts[accounts.length - 1].active = true;
    }
    const owner = readJson(FILES.rendezvous)?.owner;
    const personal = (a) => !a.login.includes('_');
    const pick = accounts.find((a) => a.login === owner) || accounts.find((a) => a.active && personal(a)) || accounts.find(personal) || accounts.find((a) => a.active) || accounts[0];
    if (!pick) return null;
    const token = await run(['auth', 'token', '--user', pick.login]);
    return token ? token.trim().split(/\s+/)[0] || null : null;
  }
  const store = new DeviceStore(FILES.devices);
  const rendezvous = new GistRendezvous({ getToken: githubToken, stateFile: FILES.rendezvous, hostId: identity.hostId, key: await identityLib.loadRendezvousKey(secrets), legacyInUse: () => store.list().some((d) => !d.rdv2), log });
  // Auto-reconnect can be turned off (the checks and tests do, so they never write to your GitHub account).
  const rendezvousOn = () => settings().rendezvous !== false;
  /** Where a connecting device finds this PC after an address change; a device told about the shared gist no longer needs the old one. */
  function rendezvousFor(device) {
    if (!rendezvousOn()) return null;
    const info = rendezvous.info();
    if (info && rendezvous.shared && device && !device.rdv2) {
      store.update(device.id, { rdv2: true });
      rendezvous.retireLegacy().catch(() => {});
    }
    return info;
  }
  log('info', `Pocket Pilot hub ${VERSION} starting in pid ${process.pid}; host "${hostName}" ${identityLib.fingerprintText(identity.fingerprint)}`);

  // ---------------------------------------------------------------- agent host + relay
  const host = new CopilotAgentHost({ reducers: ahpTypes, supportedVersions: [...ahpTypes.SUPPORTED_PROTOCOL_VERSIONS], defaultDirectory: pathToFileURL(os.homedir()).href, log });
  cleanups.push(() => host.closeAll());
  const ENDPOINT = { type: 'copilot-hub', protocolVersion: ahpTypes.SUPPORTED_PROTOCOL_VERSIONS[0] };
  const state = { publicUrl: null, reachable: false, pairing: null, pairingTimer: null, tunnelError: null, lastPairRequester: null };
  const approvals = new Map();
  const lastNotified = new Map();

  const isReadAllowed = (uri) => {
    try {
      const p = fileURLToPath(String(uri));
      return host.workingDirectories().some((d) => isInside(path.resolve(p), path.resolve(d)));
    } catch {
      return false;
    }
  };

  async function saveUpload({ session, name, data }) {
    const base = host.sessions.get(session)?.cwd || path.join(os.homedir(), 'Pocket Pilot');
    const top = path.join(base, '.pocket-pilot');
    const folder = path.join(top, 'uploads');
    fs.mkdirSync(folder, { recursive: true });
    if (!fs.existsSync(path.join(top, '.gitignore'))) fs.writeFileSync(path.join(top, '.gitignore'), '*\n');
    const safe = (name || 'upload').replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'upload';
    const file = path.join(folder, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${safe}`);
    fs.writeFileSync(file, data, { flag: 'wx' });
    log('info', `Saved upload from device: ${file} (${data.length} bytes)`);
    return { path: file, uri: pathToFileURL(file).href };
  }

  /** A new device wants in (or a paired one wants to set up its passkey again): ask on the pairing page and in the session that showed the QR code. */
  function approveDevice(info) {
    const id = crypto.randomUUID();
    const what = info.reset ? 'Setup' : 'Pairing';
    log('info', `${what} request from "${info.name}" (${info.platform || '?'}${info.ip ? `, ${info.ip}` : ''})`);
    return new Promise((resolve) => {
      const done = (allow) => {
        if (!approvals.has(id)) return;
        approvals.delete(id);
        clearTimeout(timer);
        log('info', `${what} "${info.name}": ${allow ? 'allowed' : 'declined'}`);
        resolve(!!allow);
      };
      const timer = setTimeout(() => done(false), 3 * 60 * 1000);
      approvals.set(id, { id, name: String(info.name || 'Device').slice(0, 80), platform: info.platform, ip: info.ip, reset: !!info.reset, done });
      const asker = state.lastPairRequester;
      if (asker && !asker.ch.closed && asker.canConfirm) {
        asker.rpc.request('confirm', info.reset ? {
          title: `Let "${info.name}" set up Face ID or an authenticator app again?`,
          message: `${[info.platform, info.ip && `from ${info.ip}`].filter(Boolean).join(' · ')}\n\nThis paired device can't use its passkey or authenticator app anymore. Only allow this if you asked for it on the device yourself just now.`,
        } : {
          title: `Allow "${info.name}" to control your Copilot sessions?`,
          message: `${[info.platform, info.ip && `from ${info.ip}`].filter(Boolean).join(' · ')}\n\nThe device will be able to read your open sessions, chat with the agent and approve its tool calls. Only allow this if you just scanned the QR code (or opened the pairing link) yourself.`,
        }, 3 * 60 * 1000).then((v) => typeof v === 'boolean' && done(v)).catch(() => {});
      }
    });
  }

  const monitorRef = { current: null };
  const relay = new RelayServer({
    identity,
    store,
    getAgentEndpoint: () => ENDPOINT,
    openAgentConnection: async () => host.openConnection(),
    agentHostLabel: 'The GitHub Copilot app',
    approveDevice,
    allowedOrigins: () => [...new Set([new URL(PWA_URL).origin, `http://127.0.0.1:${relay.port}`, `http://localhost:${relay.port}`, ...String(process.env.POCKET_PILOT_ORIGINS || '').split(',').filter(Boolean)])],
    policy: () => {
      const s = settings();
      return { requireApproval: s.requireApproval !== false, passkey: s.passkey, passkeyGraceHours: 12, allowTotp: s.authenticatorApp !== false };
    },
    welcomeExtras: (device) => ({ vapidPublicKey: vapid.publicKey, rendezvous: rendezvousFor(device), pwaUrl: PWA_URL, hostKind: 'copilot' }),
    isReadAllowed,
    adjustSummary: (s) => (monitorRef.current ? monitorRef.current.adjustSummary(s) : s),
    saveUpload,
    tunnelRedirect: () => PWA_URL,
    log,
  });
  relay.on('paired', (d) => log('info', `Paired "${d.name}"${d.passkey ? ' with a passkey' : d.totp ? ' with an authenticator app' : ''}`));
  relay.on('pairing-token-used', () => setTimeout(() => newPairingCode().catch(() => {}), 1500));
  relay.on('push-test', (id) => {
    const d = store.get(id);
    if (d?.push) pushTo([d], { v: 1, kind: 'test', title: '🚀 Pocket Pilot', body: `Notifications from ${hostName} work.`, hostId: identity.hostId, tag: `${identity.hostId}:test`, ts: Date.now() }, { urgency: 'high', ttl: 300 });
  });
  // The same local port as the previous hub: the running tunnel forwards there, and devices on a
  // direct connection keep their address too.
  const tunnel = new PersistentTunnel({ storageDir: FILES.tunnel, log });
  const lastPort = (settings().tunnel === 'quick' && (await tunnel.adoptablePort())) || readJson(FILES.relay, {})?.port || 0;
  await relay.listen(lastPort, '127.0.0.1').catch(() => relay.listen(0, '127.0.0.1'));
  writeJson(FILES.relay, { port: relay.port });
  cleanups.push(() => relay.close());

  // ---------------------------------------------------------------- notifications
  const monitor = new SessionMonitor({ getEndpoint: () => ENDPOINT, openConnection: async () => host.openConnection(), log });
  monitorRef.current = monitor;
  monitor.on('transition', (t) => notify(t).catch((err) => log('warn', `Notification failed: ${err.message}`)));
  monitor.on('effective', ({ uri, status }) => relay.pushSummaryChange(uri, { status }));
  monitor.start();
  cleanups.push(() => monitor.stop());

  async function notify({ kind, session }) {
    const n = settings().notify || {};
    if ((kind === 'input' && n.input === false) || (kind === 'done' && n.done === false) || (kind === 'error' && n.error === false)) return;
    const key = `${kind}:${session.resource}`;
    if (Date.now() - (lastNotified.get(key) || 0) < 15000) return;
    lastNotified.set(key, Date.now());
    const devices = store.list().filter((d) => d.push && !relay.isDeviceVisible(d.id));
    if (!devices.length) return;
    const detail = kind === 'input' ? await monitor.describeInput(session.resource) : kind === 'done' ? await monitor.describeDone(session.resource) : { text: 'The session stopped with an error.' };
    const icon = { input: '🔔', done: '✅', error: '⚠️' }[kind];
    await pushTo(devices, {
      v: 1, kind, title: `${icon} ${session.title || 'Copilot session'}`, body: detail.text, session: session.resource,
      hostId: identity.hostId, tag: `${identity.hostId}:${session.resource}`, ts: Date.now(),
    }, kind === 'input' ? { urgency: 'high', ttl: 3600 } : { urgency: 'normal', ttl: 900 });
  }

  async function pushTo(devices, payload, opts) {
    for (const d of devices) {
      const r = await push.sendPush(d.push, payload, { privateJwk: vapid.privateJwk, subject: PUSH_SUBJECT, topic: payload.kind, ...opts });
      if (r.ok) log('info', `Push "${payload.title}" -> ${d.name}`);
      else {
        log('warn', `Push to ${d.name} failed (${r.status}): ${r.error || ''}`);
        if (r.gone) store.update(d.id, { push: null });
      }
    }
  }

  // ---------------------------------------------------------------- tunnel + pairing
  async function newPairingCode() {
    clearTimeout(state.pairingTimer);
    const s = settings();
    const connectUrl = state.publicUrl || (s.tunnel === 'none' ? `http://127.0.0.1:${relay.port}` : null);
    if (!connectUrl) {
      state.pairing = null;
      return null;
    }
    const sc = await identityLib.loadSecureChannel();
    const t = await relay.createPairingToken(PAIR_MS);
    const fragment = sc.encodePairingFragment({ url: connectUrl, token: t.token, hostFingerprint: identity.fingerprint, name: identity.name });
    const link = `${PWA_URL.replace(/#.*$/, '')}#${fragment}`;
    state.pairing = { link, expiresAt: t.expiresAt, svg: renderQrSvg(link) };
    state.pairingTimer = setTimeout(() => newPairingCode().catch(() => {}), PAIR_MS);
    state.pairingTimer.unref?.();
    return state.pairing;
  }
  cleanups.push(() => clearTimeout(state.pairingTimer));

  tunnel.on('url', (url) => onPublicUrl(url));
  const tunnelEnd = { keep: false };
  cleanups.push(() => tunnel.stop({ keep: tunnelEnd.keep }));

  function onPublicUrl(url) {
    // A kept tunnel keeps its address: devices know it, and so does the auto-reconnect gist.
    const same = url === state.publicUrl || url === state.lastPublicUrl;
    state.publicUrl = url;
    state.lastPublicUrl = url;
    state.reachable = false;
    state.tunnelError = null;
    if (!same && rendezvousOn()) rendezvous.publish(url).then((ok) => ok && log('info', 'Auto-reconnect address updated')).catch(() => {});
    newPairingCode().catch((err) => log('warn', `Pairing code failed: ${err.message}`));
    tunnel.waitReachable().then(() => {
      state.reachable = true;
    }).catch((err) => log('warn', err.message));
  }

  async function startTunnel() {
    const s = settings();
    if (s.tunnel === 'none') return newPairingCode();
    if (s.tunnel === 'custom' && /^https:\/\/[^\s/]+/.test(s.customUrl || '')) return onPublicUrl(s.customUrl.replace(/\/+$/, ''));
    try {
      const bin = tunnel.findBinary() || (await tunnel.download((m) => log('info', m)));
      await tunnel.start(relay.port, bin);
    } catch (err) {
      state.tunnelError = err.message;
      log('error', `Tunnel failed: ${err.message}`);
    }
    return null;
  }

  // ---------------------------------------------------------------- session channels
  const ipcToken = newToken();
  const channels = new Set();
  await pageServer();

  function status() {
    const online = new Map(relay.activeConnections().map((c) => [c.deviceId, c]));
    return {
      version: VERSION,
      hostName,
      hostPid: process.pid,
      fingerprint: identityLib.fingerprintText(identity.fingerprint),
      tunnel: { url: state.publicUrl, reachable: state.reachable, state: tunnel.state, mode: settings().tunnel, error: state.tunnelError || tunnel.error || null },
      rendezvous: rendezvousOn() && !!rendezvous.info(),
      sessions: host.sessionCount,
      pairing: state.pairing ? { link: state.pairing.link, expiresAt: state.pairing.expiresAt } : null,
      devices: store.list().map((d) => ({ id: d.id, name: d.name, platform: d.platform, online: online.has(d.id), passkey: !!d.passkey, totp: !!d.totp, push: !!d.push, lastSeenAt: d.lastSeenAt })),
      pageUrl: pageUrl(),
    };
  }

  /** A QR code is only useful once Cloudflare answers for the new host name (early DNS misses get cached). */
  const pairingReady = () => !!state.pairing && (state.reachable || settings().tunnel !== 'quick');

  async function waitForPairing(ms = 150000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pairingReady() && state.pairing.expiresAt - Date.now() > 60000) return state.pairing;
      if ((state.publicUrl || settings().tunnel === 'none') && !state.pairing) await newPairingCode();
      if (state.tunnelError && !state.publicUrl) throw new Error(state.tunnelError);
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('The secure tunnel did not start in time');
  }

  let stopRequested = null;
  function onChannel(ch, hello) {
    const peer = { ch, sessionId: null, canConfirm: !!hello.canConfirm, pid: hello.pid };
    peer.rpc = new Rpc(ch, {
      attach: (p) => {
        peer.sessionId = String(p.sessionId);
        host.attach({ ...p, sessionId: peer.sessionId, bridge: { request: (op, params) => peer.rpc.request('cmd', { op, params }, 120000) } });
        log('info', `Session attached: ${p.title || p.sessionId} (${p.cwd || 'no folder'})`);
        return { ok: true };
      },
      event: (p) => peer.sessionId && host.event(peer.sessionId, p.e),
      events: (p) => {
        if (peer.sessionId) for (const e of p.list || []) host.event(peer.sessionId, e);
      },
      update: (p) => peer.sessionId && host.update(peer.sessionId, p),
      models: (p) => host.setModels(p.list),
      pair: async () => {
        state.lastPairRequester = peer;
        await waitForPairing();
        return status();
      },
      renew: async () => {
        await newPairingCode();
        return status();
      },
      status: async () => status(),
      stop: async () => {
        setTimeout(() => stopRequested?.('stopped from a session'), 100);
        return { ok: true };
      },
    });
    channels.add(peer);
    ch.on('close', () => {
      channels.delete(peer);
      if (state.lastPairRequester === peer) state.lastPairRequester = null;
      if (peer.sessionId) {
        host.detach(peer.sessionId);
        log('info', `Session detached: ${peer.sessionId}`);
      }
    });
  }

  const ipcServer = await serve(ipcToken, onChannel);
  cleanups.push(() => {
    for (const p of channels) p.ch.close();
    ipcServer.close();
  });

  // ---------------------------------------------------------------- local pairing page
  // Served by this process's page server (see pageServer): it answers here while this hub runs.
  const whileOn = async (route, body) => {
    switch (route) {
      case 'GET /pair/state': {
        const s = status();
        return { ...s, on: true, pairing: pairingReady() ? { ...s.pairing, svg: state.pairing.svg } : null, approvals: [...approvals.values()].map(({ done, ...a }) => a) };
      }
      case 'POST /pair/answer': {
        const b = await body();
        approvals.get(b.id)?.done(!!b.allow);
        return { ok: true };
      }
      case 'POST /pair/renew':
        await newPairingCode().catch(() => {});
        return { ok: true };
      case 'POST /pair/remove': {
        const b = await body();
        const d = store.get(String(b.id || ''));
        if (d) {
          store.remove(d.id);
          relay.revokeDevice(d.id);
          log('info', `Removed device "${d.name}"`);
          rendezvous.retireLegacy().catch(() => {});
        }
        return { ok: !!d };
      }
      case 'POST /pair/off':
        writeJson(FILES.state, { ...(readJson(FILES.state, {}) || {}), enabled: false, changedAt: new Date().toISOString() });
        setTimeout(() => stopRequested?.('turned off on the pairing page'), 100);
        return { ok: true };
      case 'POST /pair/on':
        return { ok: true };
      default:
        return undefined;
    }
  };
  page.handler = whileOn;
  cleanups.push(() => {
    // The page stays up, showing that remote access is off (or following the hub to another process).
    if (page.handler === whileOn) page.handler = null;
  });

  writeJson(FILES.hub, { pid: process.pid, port: ipcServer.address().port, token: ipcToken, version: VERSION, relayPort: relay.port, startedAt: new Date().toISOString() });
  log('info', `Hub ready: relay 127.0.0.1:${relay.port}, sessions port ${ipcServer.address().port}`);
  startTunnel();

  // ---------------------------------------------------------------- lifecycle
  let stopped = false;
  const releaseFiles = () => {
    if (readJson(FILES.hub)?.pid === process.pid) fs.rmSync(FILES.hub, { force: true });
    releaseLock();
  };
  // The runtime ends extension processes when their chat is closed or deleted: free the hub lock at
  // once so another chat takes over. The tunnel stays up for it (same address for paired devices).
  const onExit = () => releaseFiles();
  process.on('exit', onExit);
  const onSignal = () => {
    onExit();
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, onSignal);
  // This process also runs the chat's extension: an unexpected error in the hub must not end it.
  const onCrash = (err) => log('error', `Unexpected error: ${err?.stack || err}`);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  /** keepTunnel: another process takes over (same address); otherwise remote access is being turned off. */
  async function stop(why = 'stopped', { keepTunnel = false } = {}) {
    if (stopped) return;
    stopped = true;
    tunnelEnd.keep = keepTunnel;
    log('info', `Hub stopping (${why})`);
    for (const a of approvals.values()) a.done(false);
    releaseFiles();
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        /* ignore */
      }
    }
    process.off('exit', onExit);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(sig, onSignal);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
  stopRequested = stop;

  return {
    stop,
    status,
    get stopped() {
      return stopped;
    },
  };
}
