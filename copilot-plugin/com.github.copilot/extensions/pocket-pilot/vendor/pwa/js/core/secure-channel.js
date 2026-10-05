// Pocket Pilot Secure Channel v1 — isomorphic (browser + Node >= 20, WebCrypto only).
//
// Handshake (text frames, JSON):
//   C -> S  hello     {t:'hello', v:1, mode:'pair'|'resume', dk, ek, n, tid?, caps}
//   S -> C  challenge {t:'challenge', v:1, hk, ek, n, caps}
// Both sides then derive:
//   ss  = ECDH(device static, host static)      -- mutual authentication
//   ee  = ECDH(client ephemeral, server ephemeral) -- forward secrecy
//   psk = SHA-256('pp-psk1' || pairingToken)     -- only in 'pair' mode (one-time QR token)
//   th  = SHA-256(helloText || '\n' || challengeText)
//   okm = HKDF-SHA-256(ss || ee || psk, salt = th, info = 'pocket-pilot/v1/<mode>', 64)
//   c2s = okm[0..32), s2c = okm[32..64)
// Every later frame is binary: seq(8, BE) || AES-256-GCM(key, iv = 0^4 || seq, plaintext, aad).
// Frames must arrive with strictly increasing seq (no replay, no reordering, no drops).
// A peer that does not hold the right static private key (or pairing token) cannot produce
// a single valid frame, so a relay in the middle (e.g. Cloudflare) can neither read nor forge.

import { concat, b64u, unb64u, utf8, utf8d, randomBytes, equalBytes, toBytes } from './bytes.js';

const subtle = globalThis.crypto.subtle;
const ECDH_ALG = { name: 'ECDH', namedCurve: 'P-256' };

export const CHANNEL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;
const COMPRESS_THRESHOLD = 2048;
const FLAG_DEFLATE = 1;
const FLAG_MORE = 2;
const ZERO32 = new Uint8Array(32);

export class HandshakeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HandshakeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- keys

export function generateKeyPair(extractable = false) {
  return subtle.generateKey(ECDH_ALG, extractable, ['deriveBits']);
}

export async function exportPublicKey(key) {
  return new Uint8Array(await subtle.exportKey('raw', key));
}

export function importPublicKey(raw) {
  const bytes = toBytes(raw);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new HandshakeError('bad-key', 'Invalid P-256 public key');
  return subtle.importKey('raw', bytes, ECDH_ALG, true, []);
}

/** Exports an extractable key pair as a private JWK (for secret storage). */
export function exportPrivateJwk(privateKey) {
  return subtle.exportKey('jwk', privateKey);
}

/** Re-imports a key pair from its private JWK; the private key is re-imported as non-extractable. */
export async function keyPairFromJwk(jwk) {
  const privateKey = await subtle.importKey('jwk', jwk, ECDH_ALG, false, ['deriveBits']);
  const publicKey = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, ECDH_ALG, true, []);
  return { privateKey, publicKey };
}

export async function sha256(data) {
  return new Uint8Array(await subtle.digest('SHA-256', toBytes(data)));
}

/** 128-bit fingerprint of a static public key (what the QR code pins). */
export async function fingerprint(publicRaw) {
  return (await sha256(concat('pp-fp1', publicRaw))).slice(0, 16);
}

/** Non-secret identifier for a pairing token so the host can find it without trial decryption. */
export async function pairingTokenId(token) {
  return (await sha256(concat('pp-tid1', token))).slice(0, 12);
}

async function pairingPsk(token) {
  return sha256(concat('pp-psk1', token));
}

async function dh(privateKey, publicKey) {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
}

async function hkdf(ikm, salt, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(info) }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------- AEAD framing

export class Cipher {
  static async create(sendKeyRaw, recvKeyRaw, sendAad, recvAad) {
    const c = new Cipher();
    c._sendKey = await subtle.importKey('raw', sendKeyRaw, 'AES-GCM', false, ['encrypt']);
    c._recvKey = await subtle.importKey('raw', recvKeyRaw, 'AES-GCM', false, ['decrypt']);
    c._sendAad = utf8.encode(sendAad);
    c._recvAad = utf8.encode(recvAad);
    c._sendSeq = 0n;
    c._recvSeq = 0n;
    return c;
  }

  /** Must be called in the same order the frames are transmitted. */
  async seal(plaintext) {
    const seq = this._sendSeq++;
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, seq);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this._sendAad }, this._sendKey, toBytes(plaintext));
    return concat(iv.subarray(4), new Uint8Array(ct));
  }

  /** Must be called in arrival order. Throws on any tampering, replay or reordering. */
  async open(frame) {
    const f = toBytes(frame);
    if (f.length < 8 + 16) throw new HandshakeError('bad-frame', 'Frame too short');
    const seq = new DataView(f.buffer, f.byteOffset, 8).getBigUint64(0);
    if (seq !== this._recvSeq) throw new HandshakeError('bad-seq', 'Unexpected frame sequence');
    const iv = new Uint8Array(12);
    iv.set(f.subarray(0, 8), 4);
    let pt;
    try {
      pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this._recvAad }, this._recvKey, f.subarray(8));
    } catch {
      throw new HandshakeError('bad-mac', 'Frame authentication failed');
    }
    this._recvSeq++;
    return new Uint8Array(pt);
  }
}

// ---------------------------------------------------------------- compression

const hasCompression = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipeBytes(bytes, transform, limit) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new HandshakeError('too-large', 'Decompressed message too large');
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

export function supportsCompression() {
  if (!hasCompression) return false;
  try {
    new CompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- message layer

/**
 * Carries UTF-8 text messages of any size over an established Cipher.
 * Large messages are optionally deflated and split into CHUNK_BYTES frames.
 */
export class SecureMessenger {
  /**
   * @param {Cipher} cipher
   * @param {(frame: Uint8Array) => void} sendFrame
   * @param {{compress?: boolean, maxMessageBytes?: number}} [opts]
   */
  constructor(cipher, sendFrame, opts = {}) {
    this.cipher = cipher;
    this.sendFrame = sendFrame;
    this.compress = !!opts.compress && supportsCompression();
    this.maxMessageBytes = opts.maxMessageBytes || MAX_MESSAGE_BYTES;
    this._sendChain = Promise.resolve();
    this._recvChain = Promise.resolve();
    this._parts = [];
    this._partsSize = 0;
    this._partsFlags = 0;
  }

  /** Queues a text message. Resolves when all of its frames have been handed to sendFrame. */
  send(text) {
    const run = async () => {
      let body = utf8.encode(text);
      let flags = 0;
      if (this.compress && body.length >= COMPRESS_THRESHOLD) {
        body = await pipeBytes(body, new CompressionStream('deflate-raw'), Infinity);
        flags |= FLAG_DEFLATE;
      }
      let off = 0;
      do {
        const end = Math.min(body.length, off + CHUNK_BYTES);
        const more = end < body.length;
        const plain = new Uint8Array(1 + (end - off));
        plain[0] = flags | (more ? FLAG_MORE : 0);
        plain.set(body.subarray(off, end), 1);
        this.sendFrame(await this.cipher.seal(plain));
        off = end;
      } while (off < body.length);
    };
    const p = this._sendChain.then(run);
    this._sendChain = p.catch(() => {});
    return p;
  }

  /**
   * Feeds one inbound binary frame. Resolves to the full text when a message completes,
   * or null while more chunks are expected. Frames must be fed in arrival order.
   */
  receive(frame) {
    const run = async () => {
      const plain = await this.cipher.open(frame);
      if (plain.length < 1) throw new HandshakeError('bad-frame', 'Empty frame');
      const flags = plain[0];
      if (this._parts.length === 0) this._partsFlags = flags & FLAG_DEFLATE;
      this._parts.push(plain.subarray(1));
      this._partsSize += plain.length - 1;
      if (this._partsSize > this.maxMessageBytes) throw new HandshakeError('too-large', 'Message too large');
      if (flags & FLAG_MORE) return null;
      let body = this._parts.length === 1 ? this._parts[0] : concat(...this._parts);
      const compressed = this._partsFlags & FLAG_DEFLATE;
      this._parts = [];
      this._partsSize = 0;
      if (compressed) {
        if (!hasCompression) throw new HandshakeError('no-deflate', 'Peer sent compressed data');
        body = await pipeBytes(body, new DecompressionStream('deflate-raw'), this.maxMessageBytes);
      }
      return utf8d.decode(body);
    };
    const p = this._recvChain.then(run);
    this._recvChain = p.catch(() => {});
    return p;
  }
}

// ---------------------------------------------------------------- handshake

function parseJson(text, expectedType) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new HandshakeError('bad-handshake', 'Malformed handshake message');
  }
  if (!obj || typeof obj !== 'object' || obj.t !== expectedType) {
    if (obj && obj.t === 'error') {
      // Plaintext rejections are unauthenticated (anyone on the path could send one):
      // callers must never act on them beyond a retry, and must not show the peer's text.
      const e = new HandshakeError('peer-rejected', 'The computer refused the connection');
      e.untrusted = true;
      e.peerCode = typeof obj.code === 'string' ? obj.code.slice(0, 40) : '';
      throw e;
    }
    throw new HandshakeError('bad-handshake', `Expected ${expectedType}`);
  }
  if (obj.v !== CHANNEL_VERSION) throw new HandshakeError('bad-version', 'Unsupported channel version');
  return obj;
}

function isB64u(s, minLen, maxLen) {
  return typeof s === 'string' && s.length >= minLen && s.length <= maxLen && /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * Starts a client handshake.
 * @param {{mode:'pair'|'resume', deviceKeys: CryptoKeyPair, pairingToken?: Uint8Array}} p
 */
export async function createClientHello({ mode, deviceKeys, pairingToken }) {
  if (mode !== 'pair' && mode !== 'resume') throw new TypeError('mode');
  if (mode === 'pair' && !(pairingToken instanceof Uint8Array)) throw new TypeError('pairingToken');
  const eph = await generateKeyPair(false);
  const hello = {
    t: 'hello',
    v: CHANNEL_VERSION,
    mode,
    dk: b64u(await exportPublicKey(deviceKeys.publicKey)),
    ek: b64u(await exportPublicKey(eph.publicKey)),
    n: b64u(randomBytes(16)),
    caps: supportsCompression() ? ['deflate-raw'] : [],
  };
  if (mode === 'pair') hello.tid = b64u(await pairingTokenId(pairingToken));
  const helloText = JSON.stringify(hello);

  return {
    helloText,
    /**
     * Completes the handshake after receiving the host's challenge.
     * Exactly one of hostPublicKey / hostFingerprint pins the host identity.
     */
    async complete(challengeText, { hostPublicKey, hostFingerprint }) {
      const ch = parseJson(challengeText, 'challenge');
      if (!isB64u(ch.hk, 86, 88) || !isB64u(ch.ek, 86, 88) || !isB64u(ch.n, 20, 24)) {
        throw new HandshakeError('bad-handshake', 'Malformed challenge');
      }
      const hk = unb64u(ch.hk);
      if (hostPublicKey && !equalBytes(hk, toBytes(hostPublicKey))) {
        throw new HandshakeError('host-mismatch', 'Host identity does not match the paired computer');
      }
      if (hostFingerprint && !equalBytes(await fingerprint(hk), toBytes(hostFingerprint))) {
        throw new HandshakeError('host-mismatch', 'Host identity does not match the QR code');
      }
      if (!hostPublicKey && !hostFingerprint) throw new HandshakeError('host-mismatch', 'No host identity to verify');
      const ss = await dh(deviceKeys.privateKey, await importPublicKey(hk));
      const ee = await dh(eph.privateKey, await importPublicKey(unb64u(ch.ek)));
      const psk = mode === 'pair' ? await pairingPsk(pairingToken) : ZERO32;
      const th = await sha256(concat(helloText, '\n', challengeText));
      const okm = await hkdf(concat(ss, ee, psk), th, `pocket-pilot/v1/${mode}`, 64);
      const cipher = await Cipher.create(okm.slice(0, 32), okm.slice(32, 64), 'pp1-c2s', 'pp1-s2c');
      return {
        cipher,
        hostPublicKey: hk,
        peerCompression: Array.isArray(ch.caps) && ch.caps.includes('deflate-raw'),
      };
    },
  };
}

/** Parses and validates a client hello (host side). */
export function parseClientHello(helloText) {
  if (typeof helloText !== 'string' || helloText.length > 4096) throw new HandshakeError('bad-handshake', 'Hello too large');
  const h = parseJson(helloText, 'hello');
  if (h.mode !== 'pair' && h.mode !== 'resume') throw new HandshakeError('bad-handshake', 'Bad mode');
  if (!isB64u(h.dk, 86, 88) || !isB64u(h.ek, 86, 88) || !isB64u(h.n, 20, 24)) throw new HandshakeError('bad-handshake', 'Malformed hello');
  if (h.mode === 'pair' && !isB64u(h.tid, 14, 18)) throw new HandshakeError('bad-handshake', 'Missing pairing id');
  return {
    mode: h.mode,
    devicePublicKey: unb64u(h.dk),
    ephemeralPublicKey: unb64u(h.ek),
    tokenId: h.mode === 'pair' ? h.tid : undefined,
    peerCompression: Array.isArray(h.caps) && h.caps.includes('deflate-raw'),
  };
}

/**
 * Host side: builds the challenge for a validated hello and derives the session cipher.
 * @param {{helloText:string, hostKeys: CryptoKeyPair, pairingToken?: Uint8Array}} p
 */
export async function acceptClientHello({ helloText, hostKeys, pairingToken }) {
  const hello = parseClientHello(helloText);
  if (hello.mode === 'pair' && !(pairingToken instanceof Uint8Array)) throw new TypeError('pairingToken');
  const eph = await generateKeyPair(false);
  const challenge = {
    t: 'challenge',
    v: CHANNEL_VERSION,
    hk: b64u(await exportPublicKey(hostKeys.publicKey)),
    ek: b64u(await exportPublicKey(eph.publicKey)),
    n: b64u(randomBytes(16)),
    caps: supportsCompression() ? ['deflate-raw'] : [],
  };
  const challengeText = JSON.stringify(challenge);
  const ss = await dh(hostKeys.privateKey, await importPublicKey(hello.devicePublicKey));
  const ee = await dh(eph.privateKey, await importPublicKey(hello.ephemeralPublicKey));
  const psk = hello.mode === 'pair' ? await pairingPsk(pairingToken) : ZERO32;
  const th = await sha256(concat(helloText, '\n', challengeText));
  const okm = await hkdf(concat(ss, ee, psk), th, `pocket-pilot/v1/${hello.mode}`, 64);
  const cipher = await Cipher.create(okm.slice(32, 64), okm.slice(0, 32), 'pp1-s2c', 'pp1-c2s');
  return { challengeText, cipher, hello };
}

// ---------------------------------------------------------------- pairing links

/**
 * Pairing link fragment: #pair=1.<b64u(url)>.<b64u(token)>.<b64u(fingerprint)>.<b64u(name)>
 * The fragment never leaves the phone (browsers do not send it to the web server).
 */
export function encodePairingFragment({ url, token, hostFingerprint, name }) {
  return `pair=1.${b64u(utf8.encode(url))}.${b64u(token)}.${b64u(hostFingerprint)}.${b64u(utf8.encode(name || ''))}`;
}

/** A pairing link's fragment, decoded when something on the way percent-encoded it (`pair%3D1.`). */
function plainFragment(fragment) {
  try {
    return decodeURIComponent(fragment || '');
  } catch {
    return fragment || '';
  }
}

/** True if `hash` (e.g. `location.hash`) carries a pairing link. */
export function isPairingFragment(hash) {
  return /(?:^|[#&])pair=1\./.test(plainFragment(hash));
}

export function decodePairingFragment(fragment) {
  const m = /(?:^|[#&])pair=1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)/.exec(plainFragment(fragment));
  if (!m) return null;
  const url = utf8d.decode(unb64u(m[1]));
  const token = unb64u(m[2]);
  const hostFingerprint = unb64u(m[3]);
  const name = m[4] ? utf8d.decode(unb64u(m[4])) : '';
  if (!/^(https:\/\/[^/\s?#]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/?$/.test(url)) return null;
  if (token.length < 16 || hostFingerprint.length !== 16) return null;
  return { url: url.replace(/\/+$/, ''), token, hostFingerprint, name };
}
