import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wa = require('../extension/core/webauthn.js');

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();
const ORIGIN = 'https://mithawala.github.io';
const RP = 'mithawala.github.io';

function softAuthenticator() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credId = crypto.randomBytes(32);
  let counter = 0;
  const authData = (flags, attested) => {
    const head = Buffer.concat([sha256(RP), Buffer.from([flags]), Buffer.alloc(4)]);
    head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, credId, Buffer.from([0xa5])]);
  };
  return {
    register(challenge, { origin = ORIGIN, flags = 0x45 } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      return {
        id: b64u(credId),
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData(flags, true)),
        publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })),
        publicKeyAlgorithm: -7,
      };
    },
    assert(challenge, { origin = ORIGIN, flags = 0x05, bump = true } = {}) {
      if (bump) counter++;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const ad = authData(flags, false);
      const signature = crypto.sign('sha256', Buffer.concat([ad, sha256(clientDataJSON)]), { key: privateKey, dsaEncoding: 'der' });
      return { id: b64u(credId), clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(ad), signature: b64u(signature) };
    },
  };
}

test('registration then assertion succeeds', () => {
  const auth = softAuthenticator();
  const ch1 = b64u(crypto.randomBytes(32));
  const cred = wa.verifyRegistration(auth.register(ch1), { challenge: ch1, allowedOrigins: [ORIGIN] });
  assert.equal(cred.rpId, RP);
  const ch2 = b64u(crypto.randomBytes(32));
  const r = wa.verifyAssertion(auth.assert(ch2), { challenge: ch2, allowedOrigins: [ORIGIN], credential: cred });
  assert.equal(r.signCount, 1);
});

test('rejects wrong origin, challenge and missing user verification', () => {
  const auth = softAuthenticator();
  const ch = b64u(crypto.randomBytes(32));
  assert.throws(() => wa.verifyRegistration(auth.register(ch, { origin: 'https://evil.example' }), { challenge: ch, allowedOrigins: [ORIGIN] }), /origin not allowed/);
  assert.throws(() => wa.verifyRegistration(auth.register(ch), { challenge: 'other', allowedOrigins: [ORIGIN] }), /challenge mismatch/);
  assert.throws(() => wa.verifyRegistration(auth.register(ch, { flags: 0x41 }), { challenge: ch, allowedOrigins: [ORIGIN] }), /user verification/);
  const cred = wa.verifyRegistration(auth.register(ch), { challenge: ch, allowedOrigins: [ORIGIN] });
  const ch2 = b64u(crypto.randomBytes(32));
  assert.throws(() => wa.verifyAssertion(auth.assert(ch2, { flags: 0x01 }), { challenge: ch2, allowedOrigins: [ORIGIN], credential: cred }), /user verification/);
});

test('RS256 (Windows Hello style) passkeys verify too', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credId = crypto.randomBytes(16);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(credId.length);
  const regAd = Buffer.concat([sha256(RP), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, Buffer.from([0xa4])]);
  const ch = b64u(crypto.randomBytes(32));
  const reg = {
    id: b64u(credId),
    clientDataJSON: b64u(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ch, origin: ORIGIN }))),
    authenticatorData: b64u(regAd),
    publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })),
    publicKeyAlgorithm: -257,
  };
  const cred = wa.verifyRegistration(reg, { challenge: ch, allowedOrigins: [ORIGIN] });
  assert.equal(cred.algorithm, -257);
  const ch2 = b64u(crypto.randomBytes(32));
  const ad = Buffer.concat([sha256(RP), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: ch2, origin: ORIGIN }));
  const signature = crypto.sign('sha256', Buffer.concat([ad, sha256(cd)]), privateKey);
  const r = wa.verifyAssertion({ id: b64u(credId), clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(signature) }, { challenge: ch2, allowedOrigins: [ORIGIN], credential: cred });
  assert.equal(r.signCount, 1);
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => wa.verifyRegistration({ ...reg, publicKey: b64u(weak.publicKey.export({ format: 'der', type: 'spki' })) }, { challenge: ch, allowedOrigins: [ORIGIN] }), /2048/);
});

test('rejects forged signatures and counter replays', () => {
  const auth = softAuthenticator();
  const ch = b64u(crypto.randomBytes(32));
  const cred = wa.verifyRegistration(auth.register(ch), { challenge: ch, allowedOrigins: [ORIGIN] });
  const ch2 = b64u(crypto.randomBytes(32));
  const a = auth.assert(ch2);
  const forged = { ...a, signature: auth.assert(b64u(crypto.randomBytes(32))).signature };
  assert.throws(() => wa.verifyAssertion(forged, { challenge: ch2, allowedOrigins: [ORIGIN], credential: cred }), /signature|counter/);
  const ok = wa.verifyAssertion(a, { challenge: ch2, allowedOrigins: [ORIGIN], credential: cred });
  const updated = { ...cred, signCount: ok.signCount + 5 };
  const ch3 = b64u(crypto.randomBytes(32));
  assert.throws(() => wa.verifyAssertion(auth.assert(ch3), { challenge: ch3, allowedOrigins: [ORIGIN], credential: updated }), /counter/);
  const other = softAuthenticator();
  assert.throws(() => wa.verifyAssertion(other.assert(ch3), { challenge: ch3, allowedOrigins: [ORIGIN], credential: cred }), /unknown credential/);
});
