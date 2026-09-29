import test from 'node:test';
import assert from 'node:assert/strict';
import { base32, unbase32, codeAt, verifyCode, otpauthUri, newSecret, isSecret, stepAt } from '../pwa/js/core/totp.js';

// RFC 6238 appendix B, SHA-1: the shared secret is the ASCII string "12345678901234567890".
const SECRET = base32(new TextEncoder().encode('12345678901234567890'));

test('totp: base32 round trip and RFC 4648 vectors', () => {
  assert.equal(SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32(new TextEncoder().encode('foobar')), 'MZXW6YTBOI');
  assert.equal(new TextDecoder().decode(unbase32('mzxw 6ytb-oi======')), 'foobar', 'spaces, dashes, padding and case are ignored');
  assert.throws(() => unbase32('MZXW1'), /Invalid setup key/);
  const s = newSecret();
  assert.equal(s.length, 32);
  assert.ok(isSecret(s));
  assert.equal(isSecret('ABC'), false, 'too short');
  assert.equal(isSecret('not base32!'), false);
});

test('totp: codes match the RFC 6238 test vectors (last six digits)', async () => {
  for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(await codeAt(SECRET, stepAt(seconds * 1000)), code, `T=${seconds}`);
  }
});

test('totp: verification accepts one step of drift and never the same step twice', async () => {
  const now = 1234567890 * 1000;
  const step = stepAt(now);
  assert.equal(await verifyCode(SECRET, '005924', { now }), step);
  assert.equal(await verifyCode(SECRET, '005 924', { now }), step, 'spaces are fine');
  const previous = await codeAt(SECRET, step - 1);
  const next = await codeAt(SECRET, step + 1);
  assert.equal(await verifyCode(SECRET, previous, { now }), step - 1);
  assert.equal(await verifyCode(SECRET, next, { now }), step + 1);
  assert.equal(await verifyCode(SECRET, await codeAt(SECRET, step - 2), { now }), null, 'two steps old is too old');
  assert.equal(await verifyCode(SECRET, '005924', { now, after: step }), null, 'already used');
  assert.equal(await verifyCode(SECRET, '12345', { now }), null);
  assert.equal(await verifyCode(SECRET, '', { now }), null);
});

test('totp: the otpauth link authenticator apps understand', () => {
  const uri = otpauthUri({ secret: SECRET, account: 'LAPTOP-1 · iPhone' });
  assert.equal(uri, `otpauth://totp/Pocket%20Pilot%3ALAPTOP-1%20%C2%B7%20iPhone?secret=${SECRET}&issuer=Pocket%20Pilot&algorithm=SHA1&digits=6&period=30`);
});
