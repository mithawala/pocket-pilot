// Six-digit codes from an authenticator app (TOTP, RFC 6238: HMAC-SHA1, 30-second steps), the
// alternative to a passkey. Shared by the phone app (setup) and the PC (verification); WebCrypto only.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PERIOD = 30;
export const DIGITS = 6;
export const ISSUER = 'Pocket Pilot';

export function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('Invalid setup key');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new random setup key (160 bits, as authenticator apps expect). */
export function newSecret() {
  return base32(crypto.getRandomValues(new Uint8Array(20)));
}

/** A valid setup key: base32 for at least 128 bits. */
export function isSecret(secret) {
  try {
    return typeof secret === 'string' && unbase32(secret).length >= 16 && unbase32(secret).length <= 64;
  } catch {
    return false;
  }
}

/** The link authenticator apps open to add the account (also what their QR scanner reads). */
export function otpauthUri({ secret, account, issuer = ISSUER }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / PERIOD);

/** The code for one time step. */
export async function codeAt(secret, step) {
  const key = await crypto.subtle.importKey('raw', unbase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new Uint8Array(8);
  let s = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = s % 256;
    s = Math.floor(s / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const at = mac[mac.length - 1] & 15;
  const bin = ((mac[at] & 127) * 2 ** 24) + (mac[at + 1] << 16) + (mac[at + 2] << 8) + mac[at + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const normalizeCode = (code) => String(code ?? '').replace(/\D/g, '');

/**
 * The time step a code belongs to, or null. Accepts the steps around now (clocks drift and typing
 * takes time) but none at or before `after`, so a code can't be used twice.
 */
export async function verifyCode(secret, code, { now = Date.now(), window = 1, after = -1 } = {}) {
  const c = normalizeCode(code);
  if (c.length !== DIGITS) return null;
  const current = stepAt(now);
  let found = null;
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    const expected = await codeAt(secret, step);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= expected.charCodeAt(i) ^ c.charCodeAt(i);
    if (diff === 0 && step > after && found === null) found = step;
  }
  return found;
}
