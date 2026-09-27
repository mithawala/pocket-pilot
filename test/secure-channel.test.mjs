import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPair, exportPublicKey, exportPrivateJwk, keyPairFromJwk, fingerprint, pairingTokenId,
  createClientHello, acceptClientHello, parseClientHello, SecureMessenger, HandshakeError,
  encodePairingFragment, decodePairingFragment,
} from '../pwa/js/core/secure-channel.js';
import { randomBytes, b64u } from '../pwa/js/core/bytes.js';

async function setup() {
  const hostKeys = await generateKeyPair(true);
  const hostPub = await exportPublicKey(hostKeys.publicKey);
  const deviceKeys = await generateKeyPair(false);
  return { hostKeys, hostPub, deviceKeys, fp: await fingerprint(hostPub) };
}

function messengers(clientCipher, serverCipher, compress = true) {
  const toServer = [];
  const toClient = [];
  const c = new SecureMessenger(clientCipher, (f) => toServer.push(f), { compress });
  const s = new SecureMessenger(serverCipher, (f) => toClient.push(f), { compress });
  return { c, s, toServer, toClient };
}

async function drain(messenger, frames) {
  const out = [];
  while (frames.length) {
    const r = await messenger.receive(frames.shift());
    if (r !== null) out.push(r);
  }
  return out;
}

test('pair handshake establishes a working bidirectional channel', async () => {
  const { hostKeys, deviceKeys, fp } = await setup();
  const token = randomBytes(16);
  const client = await createClientHello({ mode: 'pair', deviceKeys, pairingToken: token });
  const hello = parseClientHello(client.helloText);
  assert.equal(hello.mode, 'pair');
  assert.equal(hello.tokenId, b64u(await pairingTokenId(token)));
  const server = await acceptClientHello({ helloText: client.helloText, hostKeys, pairingToken: token });
  const done = await client.complete(server.challengeText, { hostFingerprint: fp });
  const { c, s, toServer, toClient } = messengers(done.cipher, server.cipher);
  await c.send('hello host');
  await c.send('second');
  assert.deepEqual(await drain(s, toServer), ['hello host', 'second']);
  await s.send('hello phone');
  assert.deepEqual(await drain(c, toClient), ['hello phone']);
});

test('resume handshake with a pinned host key', async () => {
  const { hostKeys, hostPub, deviceKeys } = await setup();
  const client = await createClientHello({ mode: 'resume', deviceKeys });
  const server = await acceptClientHello({ helloText: client.helloText, hostKeys });
  const done = await client.complete(server.challengeText, { hostPublicKey: hostPub });
  const { c, s, toServer } = messengers(done.cipher, server.cipher);
  await c.send('{"jsonrpc":"2.0"}');
  assert.deepEqual(await drain(s, toServer), ['{"jsonrpc":"2.0"}']);
});

test('large messages are compressed, chunked and reassembled', async () => {
  const { hostKeys, hostPub, deviceKeys } = await setup();
  const client = await createClientHello({ mode: 'resume', deviceKeys });
  const server = await acceptClientHello({ helloText: client.helloText, hostKeys });
  const done = await client.complete(server.challengeText, { hostPublicKey: hostPub });
  const { c, s, toClient } = messengers(done.cipher, server.cipher);
  const big = JSON.stringify({ items: Array.from({ length: 60000 }, (_, i) => ({ i, text: `line ${i} ${'x'.repeat(i % 50)}` })) });
  await s.send(big);
  assert.ok(toClient.length >= 1);
  const [got] = await drain(c, toClient);
  assert.equal(got, big);
  // Incompressible random payload spanning several chunks.
  const rnd = b64u(randomBytes(900 * 1024));
  await s.send(rnd);
  assert.ok(toClient.length > 3, 'expected multiple chunks');
  assert.deepEqual(await drain(c, toClient), [rnd]);
});

test('wrong pairing token cannot produce a valid frame', async () => {
  const { hostKeys, deviceKeys, fp } = await setup();
  const client = await createClientHello({ mode: 'pair', deviceKeys, pairingToken: randomBytes(16) });
  const server = await acceptClientHello({ helloText: client.helloText, hostKeys, pairingToken: randomBytes(16) });
  const done = await client.complete(server.challengeText, { hostFingerprint: fp });
  const { c, s, toServer } = messengers(done.cipher, server.cipher);
  await c.send('auth');
  await assert.rejects(drain(s, toServer), (e) => e instanceof HandshakeError && e.code === 'bad-mac');
});

test('an impersonating host is detected by the client', async () => {
  const { deviceKeys, fp, hostPub } = await setup();
  const attacker = await generateKeyPair(true);
  const token = randomBytes(16);
  const client = await createClientHello({ mode: 'pair', deviceKeys, pairingToken: token });
  const server = await acceptClientHello({ helloText: client.helloText, hostKeys: attacker, pairingToken: token });
  await assert.rejects(client.complete(server.challengeText, { hostFingerprint: fp }), (e) => e.code === 'host-mismatch');
  const client2 = await createClientHello({ mode: 'resume', deviceKeys });
  const server2 = await acceptClientHello({ helloText: client2.helloText, hostKeys: attacker });
  await assert.rejects(client2.complete(server2.challengeText, { hostPublicKey: hostPub }), (e) => e.code === 'host-mismatch');
});

test('an unknown device key yields a channel the host cannot read', async () => {
  const { hostKeys, hostPub } = await setup();
  const realDevice = await generateKeyPair(false);
  const thief = await generateKeyPair(false);
  // Thief sends the real device public key but only owns its own private key.
  const client = await createClientHello({ mode: 'resume', deviceKeys: { publicKey: realDevice.publicKey, privateKey: thief.privateKey } });
  const server = await acceptClientHello({ helloText: client.helloText, hostKeys });
  const done = await client.complete(server.challengeText, { hostPublicKey: hostPub });
  const { c, s, toServer } = messengers(done.cipher, server.cipher);
  await c.send('let me in');
  await assert.rejects(drain(s, toServer), (e) => e.code === 'bad-mac');
});

test('tampered and replayed frames are rejected', async () => {
  const { hostKeys, hostPub, deviceKeys } = await setup();
  const client = await createClientHello({ mode: 'resume', deviceKeys });
  const server = await acceptClientHello({ helloText: client.helloText, hostKeys });
  const done = await client.complete(server.challengeText, { hostPublicKey: hostPub });
  const { c, s, toServer } = messengers(done.cipher, server.cipher);
  await c.send('one');
  const frame = toServer[0];
  const tampered = new Uint8Array(frame);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(s.receive(tampered), (e) => e.code === 'bad-mac');
  assert.equal(await s.receive(frame), 'one');
  await assert.rejects(s.receive(frame), (e) => e.code === 'bad-seq');
});

test('host key survives a JWK round trip', async () => {
  const hostKeys = await generateKeyPair(true);
  const jwk = await exportPrivateJwk(hostKeys.privateKey);
  const restored = await keyPairFromJwk(jwk);
  assert.deepEqual(await exportPublicKey(restored.publicKey), await exportPublicKey(hostKeys.publicKey));
  const deviceKeys = await generateKeyPair(false);
  const client = await createClientHello({ mode: 'resume', deviceKeys });
  const server = await acceptClientHello({ helloText: client.helloText, hostKeys: restored });
  const done = await client.complete(server.challengeText, { hostPublicKey: await exportPublicKey(hostKeys.publicKey) });
  const { c, s, toServer } = messengers(done.cipher, server.cipher);
  await c.send('ok');
  assert.deepEqual(await drain(s, toServer), ['ok']);
});

test('malformed hellos are rejected', () => {
  assert.throws(() => parseClientHello('not json'), HandshakeError);
  assert.throws(() => parseClientHello(JSON.stringify({ t: 'hello', v: 2, mode: 'resume' })), (e) => e.code === 'bad-version');
  assert.throws(() => parseClientHello(JSON.stringify({ t: 'hello', v: 1, mode: 'root', dk: 'x', ek: 'y', n: 'z' })), HandshakeError);
  assert.throws(() => parseClientHello('x'.repeat(5000)), HandshakeError);
});

test('pairing fragment round trip and validation', async () => {
  const token = randomBytes(16);
  const fp = randomBytes(16);
  const frag = encodePairingFragment({ url: 'https://abc-def.trycloudflare.com', token, hostFingerprint: fp, name: 'Asif’s PC' });
  const parsed = decodePairingFragment('#' + frag);
  assert.equal(parsed.url, 'https://abc-def.trycloudflare.com');
  assert.deepEqual(parsed.token, token);
  assert.deepEqual(parsed.hostFingerprint, fp);
  assert.equal(parsed.name, 'Asif’s PC');
  const insecure = encodePairingFragment({ url: 'http://evil.example.com', token, hostFingerprint: fp, name: '' });
  assert.equal(decodePairingFragment(insecure), null);
  assert.equal(decodePairingFragment(encodePairingFragment({ url: 'http://localhost.evil.com', token, hostFingerprint: fp, name: '' })), null);
  assert.equal(decodePairingFragment(encodePairingFragment({ url: 'https://x.trycloudflare.com/path?q', token, hostFingerprint: fp, name: '' })), null);
  assert.ok(decodePairingFragment(encodePairingFragment({ url: 'http://127.0.0.1:8787', token, hostFingerprint: fp, name: '' })));
  assert.equal(decodePairingFragment('#nothing'), null);
});
