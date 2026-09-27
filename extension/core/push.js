'use strict';
// Standards-based Web Push (RFC 8030/8291/8292) with no third-party service or library:
// the extension signs a VAPID JWT and encrypts the payload itself, then POSTs straight to
// the browser vendor's push service (FCM for Chrome/Android, Apple for iOS/Safari, Mozilla, WNS).
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

const ALLOWED_PUSH_HOST_SUFFIXES = [
  '.googleapis.com', // Chrome, Android, Opera, Samsung (FCM)
  '.push.apple.com', // Safari, iOS home-screen apps
  '.push.services.mozilla.com', // Firefox
  '.notify.windows.com', // Edge on Windows (WNS)
];

function isAllowedPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) || host === s.slice(1));
  } catch {
    return false;
  }
}

/** RFC 8291 "aes128gcm" content encoding for a single record. */
function encryptPayload(plaintext, keys, { salt = crypto.randomBytes(16), asPrivateKey } = {}) {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Invalid push subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivateKey) ecdh.setPrivateKey(unb64u(asPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { privateJwk: jwk, publicKey: vapidPublicKey(jwk) };
}

function vapidPublicKey(jwk) {
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
}

function vapidAuthorization(endpoint, privateJwk, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapidPublicKey(privateJwk)}`;
}

/**
 * Sends one notification. Resolves to {ok, gone, status}. `gone` means the subscription is dead
 * and should be deleted.
 */
async function sendPush(subscription, payload, { privateJwk, subject, ttl = 3600, urgency = 'high', topic, fetchImpl = fetch }) {
  if (!subscription || !isAllowedPushEndpoint(subscription.endpoint)) return { ok: false, gone: true, status: 0, error: 'endpoint not allowed' };
  let json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > 3000) {
    const trimmed = { ...payload, body: String(payload.body || '').slice(0, 400) };
    json = JSON.stringify(trimmed);
  }
  const body = encryptPayload(json, subscription.keys);
  const headers = {
    TTL: String(ttl),
    Urgency: urgency,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(subscription.endpoint, privateJwk, subject),
  };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  try {
    const res = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body });
    const status = res.status;
    let error;
    if (status >= 300) error = (await res.text().catch(() => '')).slice(0, 300);
    return { ok: status >= 200 && status < 300, gone: status === 404 || status === 410, status, error };
  } catch (err) {
    return { ok: false, gone: false, status: 0, error: err.message };
  }
}

module.exports = { encryptPayload, generateVapidKeys, vapidPublicKey, vapidAuthorization, sendPush, isAllowedPushEndpoint };
