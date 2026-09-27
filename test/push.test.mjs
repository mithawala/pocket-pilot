import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const push = require('../extension/core/push.js');

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

// RFC 8291, Section 5 ("Push Message Encryption Example").
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 known-answer test vector', () => {
  const body = push.encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    salt: Buffer.from(RFC.salt, 'base64url'), asPrivateKey: RFC.asPrivate,
  });
  assert.equal(body.toString('base64url'), RFC.body);
});

function decryptAsBrowser(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdhSecret = uaEcdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2);
  return pt.subarray(0, pt.length - 1).toString();
}

test('payload round-trips through a browser-side decryption', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const body = push.encryptPayload('{"title":"hi"}', { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
  assert.equal(decryptAsBrowser(body, ua, auth), '{"title":"hi"}');
});

test('VAPID authorization header is a valid ES256 JWT', () => {
  const { privateJwk, publicKey } = push.generateVapidKeys();
  const header = push.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', privateJwk, 'mailto:test@example.com');
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m);
  assert.equal(m[4], publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:test@example.com');
  assert.ok(claims.exp > Date.now() / 1000);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  assert.ok(ok);
});

test('only real push services are allowed as endpoints', async () => {
  assert.ok(push.isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(push.isAllowedPushEndpoint('https://web.push.apple.com/QOk'));
  assert.ok(push.isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(push.isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x'));
  assert.ok(!push.isAllowedPushEndpoint('http://fcm.googleapis.com/x'));
  assert.ok(!push.isAllowedPushEndpoint('https://127.0.0.1/x'));
  assert.ok(!push.isAllowedPushEndpoint('https://evil.com/?fcm.googleapis.com'));
  const r = await push.sendPush({ endpoint: 'https://localhost/x', keys: {} }, {}, { privateJwk: {}, subject: 'x' });
  assert.equal(r.ok, false);
});

test('sendPush posts an encrypted body with the right headers', async () => {
  const { privateJwk } = push.generateVapidKeys();
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { status: 201, text: async () => '' };
  };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const r = await push.sendPush(sub, { title: 'Needs input', body: 'x'.repeat(5000) }, { privateJwk, subject: 'mailto:a@b.c', topic: 'session:1', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(captured.init.headers.Topic, 'session1');
  const payload = JSON.parse(decryptAsBrowser(captured.init.body, ua, auth));
  assert.equal(payload.title, 'Needs input');
  assert.ok(payload.body.length <= 400);
  const gone = await push.sendPush(sub, { title: 'x' }, { privateJwk, subject: 'mailto:a@b.c', fetchImpl: async () => ({ status: 410, text: async () => 'gone' }) });
  assert.equal(gone.gone, true);
});
