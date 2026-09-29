// Phone side of the relay protocol: pairing, authenticated reconnects, and an AHP transport
// running inside the end-to-end encrypted channel.
import * as sc from '../core/secure-channel.js';
import { b64u, unb64u } from '../core/bytes.js';
import { normalizeCode } from '../core/totp.js';
import { openSocket, SocketClosedError } from './socket.js';
import { lookupHostUrl } from './rendezvous.js';

export const APP_VERSION = '0.6.2';
// How long a typed authenticator code may still go along with a reconnect (codes last 30-90 seconds).
const CODE_REUSE_MS = 75 * 1000;

export class PairingError extends Error {
  constructor(code, message, { untrusted = false, peerCode = '' } = {}) {
    super(message || code);
    this.name = 'PairingError';
    this.code = code;
    this.untrusted = untrusted;
    this.peerCode = peerCode;
  }
}

// Local wording for rejections the PC can only send in plaintext (before any keys exist).
const PLAINTEXT_REASONS = {
  'pairing-expired': 'This pairing code has expired or was already used. Show a new QR code on your PC.',
};

function untrustedError(peerCode) {
  return new PairingError('peer-rejected', PLAINTEXT_REASONS[peerCode] || 'Your PC refused the connection.', { untrusted: true, peerCode });
}

function wsUrl(httpUrl) {
  return httpUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + '/ws';
}

function createMessenger(sock, cipher, compress) {
  const messenger = new sc.SecureMessenger(cipher, (f) => sock.send(f), { compress });
  const recv = async (timeoutMs) => {
    for (;;) {
      const f = await sock.next(timeoutMs);
      if (f.text !== undefined) {
        // After the key exchange every genuine message is encrypted: plaintext is untrusted.
        let code = '';
        try {
          code = String(JSON.parse(f.text)?.code || '');
        } catch {
          /* ignore */
        }
        throw untrustedError(code);
      }
      const text = await messenger.receive(f.bytes);
      if (text !== null) return text;
    }
  };
  return {
    messenger,
    recv,
    async recvControl(timeoutMs) {
      const text = await recv(timeoutMs);
      if (text[0] !== 'C') throw new PairingError('protocol', 'Unexpected message from PC');
      return JSON.parse(text.slice(1));
    },
    sendControl(obj) {
      return messenger.send('C' + JSON.stringify(obj));
    },
  };
}

/**
 * Pairs this phone with a PC using a scanned QR link.
 *
 * `factor(request)` answers the PC's request for a second factor: it resolves to `{ credential }`
 * (a new passkey) or `{ totp: { secret, code } }` (an authenticator app set up on this device), and
 * may take its time: the pairing stays open while the person retries a passkey or sets up an app.
 * Rejecting gives up. Without it, `webauthn.register` makes the passkey.
 * @returns {Promise<object>} host record to persist
 */
export async function pairWithHost({ fragment, deviceName, platform, webauthn, factor, WebSocketImpl, onStatus = () => {} }) {
  const p = sc.decodePairingFragment(fragment);
  if (!p) throw new PairingError('bad-link', 'This pairing link is invalid. Scan the QR code on your PC again.');
  const answer = factor || (async (req) => ({ credential: await webauthn.register(req) }));
  const deviceKeys = await sc.generateKeyPair(false);
  onStatus('connecting');
  const sock = await openSocket(wsUrl(p.url), { WebSocketImpl });
  let factorKind = null;
  try {
    const hello = await sc.createClientHello({ mode: 'pair', deviceKeys, pairingToken: p.token });
    sock.send(hello.helloText);
    const first = await sock.next(15000);
    if (first.text === undefined) throw new PairingError('protocol', 'Unexpected response');
    let done;
    try {
      done = await hello.complete(first.text, { hostFingerprint: p.hostFingerprint });
    } catch (err) {
      throw err && err.untrusted ? untrustedError(err.peerCode) : err;
    }
    const ch = createMessenger(sock, done.cipher, done.peerCompression);
    await ch.sendControl({ t: 'auth', device: { name: deviceName, platform }, appVersion: APP_VERSION, visible: true });
    for (;;) {
      const m = await ch.recvControl(12 * 60 * 1000);
      if (m.t === 'pending') onStatus('approval');
      else if (m.t === 'passkey.register') {
        onStatus('passkey');
        let reply;
        try {
          const r = await answer({ challenge: m.challenge, userId: m.userId, userName: `${p.name || 'PC'} · Pocket Pilot`, displayName: deviceName, hostName: p.name || 'your PC', alternatives: Array.isArray(m.alternatives) ? m.alternatives : [] });
          reply = r.totp ? { t: 'totp.enroll', secret: r.totp.secret, code: r.totp.code } : { t: 'passkey.registered', credential: r.credential };
          factorKind = r.totp ? 'totp' : 'passkey';
        } catch (err) {
          reply = { t: 'passkey.unavailable', reason: String(err?.message || err).slice(0, 200) };
        }
        if (sock.closed) throw new PairingError('connection-lost', 'The connection to your PC was lost while this device was being set up.');
        await ch.sendControl(reply);
        onStatus('finishing');
      } else if (m.t === 'welcome') {
        return {
          hostId: m.host.id,
          hostName: m.host.name || p.name || 'My PC',
          url: p.url,
          hostPublicKey: b64u(done.hostPublicKey),
          deviceId: m.deviceId,
          deviceName: m.deviceName || deviceName,
          deviceKeys,
          rendezvous: m.rendezvous || null,
          vapidPublicKey: m.vapidPublicKey || null,
          pwaUrl: m.pwaUrl || null,
          passkey: !!m.passkey,
          factor: m.factor || (m.passkey ? 'passkey' : factorKind),
          hostKind: m.hostKind || 'vscode',
          pairedAt: Date.now(),
        };
      } else if (m.t === 'error') throw new PairingError(m.code, m.message);
    }
  } finally {
    sock.close(1000, 'paired');
  }
}

/** AhpTransport implementation over the secure channel (one per WebSocket connection). */
class SecureAhpTransport {
  constructor(sendText, close) {
    this._sendText = sendText;
    this._close = close;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }
  _deliver(text) {
    const f = { kind: 'text', text };
    const w = this.waiters.shift();
    if (w) w(f);
    else this.queue.push(f);
  }
  _end() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
  send(message) {
    return this._sendText('A' + (typeof message === 'string' ? message : JSON.stringify(message)));
  }
  recv() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  close() {
    this._close();
  }
}

/**
 * Keeps a live, authenticated connection to one paired PC and reconnects as needed.
 * Events: 'state' {state, detail}, 'ready' {transport, welcome}, 'control' {message}, 'record' {record}
 */
export class HostConnection extends EventTarget {
  /**
   * Second factor on reconnect, answered by the app's UI: `confirmPasskey(request)` resolves to a passkey
   * assertion, `askCode(request)` to an authenticator code, and either to `{ reset: true }` when the person
   * can't use them anymore and sets up a new one with `enrollFactor(request)` (after a yes on the PC).
   */
  constructor(record, { WebSocketImpl, webauthn, confirmPasskey, askCode, enrollFactor, fetchImpl, isVisible = () => true } = {}) {
    super();
    this.record = record;
    this.WebSocketImpl = WebSocketImpl;
    this.webauthn = webauthn;
    this.confirmPasskey = confirmPasskey || ((req) => this.webauthn.assert(req));
    this.askCode = askCode || (() => Promise.reject(new Error('No way to enter a code here')));
    this.enrollFactor = enrollFactor || (async (req) => ({ credential: await this.webauthn.register(req) }));
    this.fetchImpl = fetchImpl;
    this.isVisible = isVisible;
    this.state = 'idle';
    this.detail = '';
    this.sock = null;
    this.ch = null;
    this.transport = null;
    this.welcome = null;
    this.stopped = true;
    this.attempt = 0;
    this.failures = 0;
    this._timer = null;
    this._pending = new Map();
    this._seq = 0;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setState(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this._emit('state', { state, detail });
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._timer);
    if (this.sock) this.sock.close(1000, 'stopped');
    this._setState('idle');
  }

  /** Reconnect immediately (e.g. when the app returns to the foreground). */
  poke() {
    if (this.stopped) return;
    if (['online', 'connecting', 'authenticating', 'passkey', 'code', 'approval', 'setup'].includes(this.state)) return;
    this.attempt = 0;
    this._schedule(0);
  }

  _schedule(ms) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._connect(), ms);
  }

  async _connect() {
    if (this.stopped) return;
    this._setState('connecting');
    let sock;
    try {
      sock = await openSocket(wsUrl(this.record.url), { WebSocketImpl: this.WebSocketImpl, timeoutMs: 12000 });
    } catch (err) {
      this.failures++;
      await this._retry(err.message);
      return;
    }
    this.sock = sock;
    try {
      this._setState('authenticating');
      const deviceKeys = this.record.deviceKeys;
      const hello = await sc.createClientHello({ mode: 'resume', deviceKeys });
      sock.send(hello.helloText);
      const first = await sock.next(15000);
      if (first.text === undefined) throw new PairingError('protocol', 'Unexpected response');
      const done = await hello.complete(first.text, { hostPublicKey: unb64u(this.record.hostPublicKey) });
      const ch = createMessenger(sock, done.cipher, done.peerCompression);
      this.ch = ch;
      // A code typed in the last minute goes along: iOS may have dropped the connection that asked for it
      // while the person was reading it in their authenticator app.
      const code = this._code && Date.now() - this._code.at < CODE_REUSE_MS ? this._code.code : null;
      this._code = null;
      await ch.sendControl({ t: 'auth', appVersion: APP_VERSION, visible: this.isVisible(), ...(code ? { totpCode: code } : {}) });
      let welcome;
      for (;;) {
        const m = await ch.recvControl(12 * 60 * 1000);
        if (m.t === 'passkey.challenge') {
          this._setState('passkey');
          let reply;
          try {
            const r = await this.confirmPasskey({ challenge: m.challenge, credentialId: m.credentialId, rpId: m.rpId, hostName: this.record.hostName });
            reply = r?.reset ? { t: 'factor.reset' } : { t: 'passkey.assertion', assertion: r };
          } catch (err) {
            reply = { t: 'passkey.cancelled', reason: String(err?.message || err).slice(0, 200) };
          }
          await ch.sendControl(reply);
          this._setState('authenticating');
        } else if (m.t === 'totp.challenge') {
          this._setState('code');
          let answer = null;
          try {
            answer = await this.askCode({ hostName: this.record.hostName, deviceName: this.record.deviceName, wrong: !!m.wrong });
          } catch {
            /* cancelled */
          }
          const typed = answer && !answer.reset ? normalizeCode(answer) : null;
          if (typed) this._code = { code: typed, at: Date.now() };
          if (sock.closed && typed) throw new Error('Reconnecting to check the code');
          await ch.sendControl(answer?.reset ? { t: 'factor.reset' } : typed ? { t: 'totp.code', code: typed } : { t: 'totp.cancel' });
          this._setState('authenticating');
        } else if (m.t === 'pending') {
          // Setting up the second factor again: the PC asks for a yes first.
          this._setState('approval');
        } else if (m.t === 'passkey.register') {
          this._setState('setup');
          let reply;
          try {
            const r = await this.enrollFactor({ challenge: m.challenge, userId: m.userId, userName: `${this.record.hostName || 'PC'} · Pocket Pilot`, displayName: this.record.deviceName, hostName: this.record.hostName, deviceName: this.record.deviceName, hostId: this.record.hostId, alternatives: Array.isArray(m.alternatives) ? m.alternatives : [] });
            reply = r.totp ? { t: 'totp.enroll', secret: r.totp.secret, code: r.totp.code } : { t: 'passkey.registered', credential: r.credential };
          } catch (err) {
            reply = { t: 'passkey.unavailable', reason: String(err?.message || err).slice(0, 200) };
          }
          if (sock.closed) throw new Error('The connection to your PC was lost while this device was being set up. Try again.');
          await ch.sendControl(reply);
          this._setState('authenticating');
        } else if (m.t === 'welcome') {
          welcome = m;
          break;
        } else if (m.t === 'revoked') throw new PairingError('revoked', 'This device was removed on your PC.');
        else if (m.t === 'error') throw new PairingError(m.code, m.message);
      }
      this.welcome = welcome;
      this._code = null;
      this.failures = 0;
      this.attempt = 0;
      this._updateRecord({ rendezvous: welcome.rendezvous || this.record.rendezvous, vapidPublicKey: welcome.vapidPublicKey || this.record.vapidPublicKey, hostName: welcome.host?.name || this.record.hostName, passkey: !!welcome.passkey, factor: welcome.factor || this.record.factor || (welcome.passkey ? 'passkey' : null), hostKind: welcome.hostKind || this.record.hostKind || 'vscode' });
      const transport = new SecureAhpTransport((text) => ch.messenger.send(text), () => sock.close(1000, 'client closed'));
      this.transport = transport;
      sock.onclose = (e) => this._onClosed(e);
      this._pump(ch, transport);
      this._setState('online');
      this._emit('ready', { transport, welcome });
    } catch (err) {
      sock.close(1000, 'handshake failed');
      // Only errors that arrived inside the encrypted channel (i.e. from the real PC) may unpair
      // or lock the app; plaintext rejections and dropped connections are always retried.
      const code = err && !err.untrusted ? err.code : null;
      if (['unknown-device', 'passkey-missing', 'revoked', 'denied'].includes(code)) {
        this.stopped = true;
        this._setState('unpaired', err.message);
        return;
      }
      if (code === 'passkey-failed') {
        this._setState('locked', err.message);
        this.stopped = true;
        return;
      }
      if (this._code && Date.now() - this._code.at < CODE_REUSE_MS) {
        // Straight back with the code the person just typed.
        this._schedule(250);
        return;
      }
      this.failures++;
      const reason = err && err.untrusted ? 'The PC refused the connection' : err && err.code === 'host-mismatch' ? 'Another machine answered at your PC’s address' : err.message;
      await this._retry(reason);
    }
  }

  async _pump(ch, transport) {
    try {
      for (;;) {
        const text = await ch.recv(0);
        if (text[0] === 'A') transport._deliver(text.slice(1));
        else if (text[0] === 'C') this._onControl(JSON.parse(text.slice(1)));
      }
    } catch (err) {
      transport._end();
      if (!(err instanceof SocketClosedError)) this.sock?.close(4000, 'protocol error');
    }
  }

  _onControl(m) {
    if (m.t === 'revoked') {
      this.stopped = true;
      this._setState('unpaired', 'This device was removed on your PC.');
    }
    if (m.t === 'upload.result' || m.t === 'push.result' || m.t === 'pong') {
      const key = m.t === 'upload.result' ? `upload:${m.id}` : m.t;
      const p = this._pending.get(key);
      if (p) {
        this._pending.delete(key);
        p(m);
      }
    }
    this._emit('control', { message: m });
  }

  _onClosed(e) {
    this.transport?._end();
    this.transport = null;
    this.ch = null;
    this.sock = null;
    for (const p of this._pending.values()) p({ ok: false, error: 'disconnected' });
    this._pending.clear();
    if (this.stopped) return;
    // A close code is not authenticated; genuine revocations arrive as an encrypted 'revoked' message.
    this._retry(e.code === 4503 ? (this.record.hostKind === 'copilot' ? 'The GitHub Copilot app is not available' : 'VS Code agent host is not available') : 'Connection lost');
  }

  async _retry(reason) {
    if (this.stopped) return;
    this.attempt++;
    this._setState('offline', reason);
    if (this.failures >= 2 && this.record.rendezvous) {
      try {
        const found = await lookupHostUrl(this.record.rendezvous, this.record.hostId, this.fetchImpl);
        if (found && found.url !== this.record.url) {
          this._updateRecord({ url: found.url });
          this.failures = 0;
          this._schedule(250);
          return;
        }
      } catch {
        /* ignore */
      }
    }
    const delay = Math.min(30000, 800 * 2 ** Math.min(this.attempt, 6)) * (0.75 + Math.random() * 0.5);
    this._schedule(this.isVisible() ? delay : Math.max(delay, 15000));
  }

  _updateRecord(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && JSON.stringify(this.record[k]) !== JSON.stringify(v)) {
        this.record[k] = v;
        changed = true;
      }
    }
    if (changed) this._emit('record', { record: this.record });
  }

  sendControl(obj) {
    if (!this.ch) return Promise.reject(new Error('Not connected'));
    return this.ch.sendControl(obj);
  }

  setVisible(visible) {
    if (this.ch) this.ch.sendControl({ t: 'presence', visible }).catch(() => {});
    if (visible) this.poke();
  }

  _request(key, msg, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._pending.delete(key);
        reject(new Error('Timed out'));
      }, timeoutMs);
      this._pending.set(key, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.sendControl(msg).catch((err) => {
        clearTimeout(t);
        this._pending.delete(key);
        reject(err);
      });
    });
  }

  subscribePush(subscription) {
    return this._request('push.result', { t: 'push.subscribe', subscription });
  }

  unsubscribePush() {
    return this.sendControl({ t: 'push.unsubscribe' });
  }

  testPush() {
    return this.sendControl({ t: 'push.test' });
  }

  async upload({ session, name, mime, data }) {
    const id = `${Date.now()}-${++this._seq}`;
    const r = await this._request(`upload:${id}`, { t: 'upload', id, session, name, mime, data }, 180000);
    if (!r.ok) throw new Error(r.error || 'Upload failed');
    return r;
  }

  forget() {
    return this.sendControl({ t: 'forget' }).catch(() => {});
  }
}
