import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pairWithHost, HostConnection } from '../pwa/js/net/host-connection.js';
import { encodePairingFragment, createClientHello, SecureMessenger } from '../pwa/js/core/secure-channel.js';
import { newSecret, codeAt, stepAt } from '../pwa/js/core/totp.js';
import { AhpClient } from '../pwa/vendor/ahp/client/index.js';

const waitUntil = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const require = createRequire(import.meta.url);
const ws = require('../extension/core/wslite.js');
const { RelayServer } = require('../extension/core/relay.js');
const { DeviceStore, MemorySecrets } = require('../extension/core/store.js');
const { loadHostIdentity } = require('../extension/core/identity.js');

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();

/** Minimal fake agent host speaking just enough AHP for the relay tests. */
function startFakeAgentHost() {
  const state = { tokens: [], received: [], connections: 0 };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('tkn') !== 'secret-connection-token') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const c = ws.acceptUpgrade(req, socket, head);
    state.connections++;
    c.on('message', (text) => {
      const m = JSON.parse(text);
      state.received.push(m);
      const reply = (result) => c.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      if (m.method === 'initialize') {
        reply({
          protocolVersion: '0.9.0',
          serverSeq: 10,
          snapshots: [{
            resource: 'ahp-root://',
            fromSeq: 10,
            state: { agents: [{ provider: 'copilotcli', displayName: 'Copilot', description: '', models: [], protectedResources: [{ resource: 'https://api.github.com', scopes_supported: ['read:user'] }] }] },
          }],
        });
        // VS Code answers this for every client; the relay must not (the agent host's token is global).
        c.send(JSON.stringify({ jsonrpc: '2.0', method: 'auth/required', params: { channel: 'ahp-root://', resource: 'https://api.github.com' } }));
      } else if (m.method === 'authenticate') {
        state.tokens.push(m.params);
        reply({});
      } else if (m.method === 'listSessions') {
        reply({ items: [{ resource: 'copilotcli:/s1', provider: 'copilotcli', title: 'Test session', status: 1 }] });
      } else if (m.method === 'dispatchAction') {
        c.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: { channel: m.params.channel, action: m.params.action, serverSeq: 11, origin: { clientId: 'x', clientSeq: m.params.clientSeq } } }));
      } else if (m.id !== undefined) {
        reply({});
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const endpoint = { type: 'editor', pid: process.pid, protocolVersion: '0.9.0', connectionToken: 'secret-connection-token', endpoint: { type: 'tcp', host: '127.0.0.1', port: server.address().port } };
    resolve({ server, state, endpoint });
  }));
}

function softWebAuthn(origin) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credId = crypto.randomBytes(16);
  const rpId = new URL(origin).hostname;
  let counter = 0;
  const calls = { register: 0, assert: 0 };
  const ad = (flags, attested) => {
    const head = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4)]);
    head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, credId, Buffer.from([0xa5])]);
  };
  return {
    calls,
    async register({ challenge }) {
      calls.register++;
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      return { id: b64u(credId), clientDataJSON: b64u(cd), authenticatorData: b64u(ad(0x45, true)), publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })), publicKeyAlgorithm: -7 };
    },
    async assert({ challenge }) {
      calls.assert++;
      counter++;
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const a = ad(0x05, false);
      const signature = crypto.sign('sha256', Buffer.concat([a, sha256(cd)]), { key: privateKey, dsaEncoding: 'der' });
      return { id: b64u(credId), clientDataJSON: b64u(cd), authenticatorData: b64u(a), signature: b64u(signature) };
    },
  };
}

async function setupRelay({ policy, approve = async () => true, relayOptions = {} } = {}) {
  const fake = await startFakeAgentHost();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-relay-'));
  const store = new DeviceStore(path.join(dir, 'devices.json'));
  const identity = await loadHostIdentity(new MemorySecrets(), 'Test PC');
  const approvals = [];
  const pol = { requireApproval: true, passkey: 'optional', passkeyGraceHours: 12, ...policy };
  const relay = new RelayServer({
    identity,
    store,
    getAgentEndpoint: () => fake.endpoint,
    approveDevice: async (info) => { approvals.push(info); return approve(info); },
    allowedOrigins: () => ['http://localhost:5173'],
    policy: () => pol,
    welcomeExtras: () => ({ vapidPublicKey: 'BVAPID', rendezvous: null, pwaUrl: 'http://localhost:5173/' }),
    isReadAllowed: (uri) => String(uri).startsWith('file:///allowed/'),
    ...relayOptions,
  });
  const port = await relay.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const newFragment = async () => {
    const t = await relay.createPairingToken(60000);
    return '#' + encodePairingFragment({ url, token: t.token, hostFingerprint: identity.fingerprint, name: identity.name });
  };
  return { fake, relay, store, identity, approvals, url, newFragment, policy: pol, cleanup: async () => { await relay.close(); fake.server.close(); } };
}

function waitEvent(target, type, pred = () => true, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const h = (e) => {
      if (!pred(e.detail)) return;
      clearTimeout(t);
      target.removeEventListener(type, h);
      resolve(e.detail);
    };
    target.addEventListener(type, h);
  });
}

test('pair, approve, passkey, relay AHP through the allowlist without touching the agent host sign-in', async () => {
  const env = await setupRelay();
  const wa = softWebAuthn('http://localhost:5173');
  let conn;
  try {
    const statuses = [];
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Test iPhone', platform: 'iOS', webauthn: wa, onStatus: (s) => statuses.push(s) });
    assert.ok(statuses.includes('approval'));
    assert.ok(statuses.includes('passkey'));
    assert.equal(env.approvals.length, 1);
    assert.equal(env.approvals[0].name, 'Test iPhone');
    assert.equal(record.hostName, 'Test PC');
    assert.equal(record.passkey, true);
    const dev = env.store.list()[0];
    assert.equal(dev.name, 'Test iPhone');
    assert.ok(dev.passkey?.credentialId);

    // Resume (within passkey grace period: no biometric prompt)
    conn = new HostConnection(record, { webauthn: wa });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    const { transport, welcome } = await ready;
    assert.equal(welcome.deviceId, dev.id);
    assert.equal(wa.calls.assert, 0);

    const client = new AhpClient(transport, { requestTimeoutMs: 10000 });
    client.connect();
    const init = await client.initialize({ clientId: 'phone-1', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] });
    assert.equal(init.protocolVersion, '0.9.0');
    const list = await client.request('listSessions', { channel: 'ahp-root://' });
    assert.equal(list.items[0].title, 'Test session');
    assert.equal(env.fake.state.tokens.length, 0, 'the relay must never sign in to the agent host (its token is shared with VS Code)');

    // Blocked methods never reach the agent host.
    await assert.rejects(client.request('resourceWrite', { channel: 'ahp-root://', uri: 'file:///etc/x', data: 'x' }), /not allowed/);
    await assert.rejects(client.request('authenticate', { channel: 'ahp-root://', resource: 'x', token: 'stolen' }), /not allowed/);
    await assert.rejects(client.request('resourceRead', { channel: 'ahp-root://', uri: 'file:///c:/secret.txt' }), /not allowed/);
    await client.request('resourceRead', { channel: 'ahp-root://', uri: 'file:///allowed/readme.md' });
    assert.ok(!env.fake.state.received.some((m) => m.method === 'resourceWrite'));
    assert.equal(env.fake.state.received.filter((m) => m.method === 'authenticate').length, 0);

    // Raw frames: JSON-RPC batches, reserved ids and bare objects must never reach the agent host.
    transport.send(JSON.stringify([{ jsonrpc: '2.0', id: 900, method: 'resourceWrite', params: { channel: 'ahp-root://', uri: 'file:///x', data: 'x' } }]));
    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 'pp:1', method: 'listSessions', params: { channel: 'ahp-root://' } }));
    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 901 }));
    await client.request('listSessions', { channel: 'ahp-root://' });
    assert.ok(!env.fake.state.received.some((m) => Array.isArray(m) || (m.id === 'pp:1' && m.method === 'listSessions') || m.id === 901), 'smuggled frames were forwarded');

    // Dispatch round-trips as an action notification.
    const events = client.events();
    client.dispatch('ahp-chat:/c1', { type: 'chat/turnStarted', turnId: 't1', startedAt: new Date().toISOString(), message: { text: 'hi', origin: { kind: 'user' } } });
    const ev = await events.next();
    assert.equal(ev.value.event.params.action.turnId, 't1');

    // Presence reaches the relay.
    conn.setVisible(false);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(env.relay.isDeviceVisible(dev.id), false);

    // Revocation disconnects the phone and marks it unpaired.
    const unpaired = waitEvent(conn, 'state', (d) => d.state === 'unpaired');
    env.store.remove(dev.id);
    env.relay.revokeDevice(dev.id);
    await unpaired;
    await client.shutdown();
  } finally {
    conn?.stop();
    await env.cleanup();
  }
});

test('passkey is re-verified after the grace period', async () => {
  const env = await setupRelay({ policy: { passkeyGraceHours: 0 } });
  const wa = softWebAuthn('http://localhost:5173');
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Pixel', platform: 'Android', webauthn: wa });
    const conn = new HostConnection(record, { webauthn: wa });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    await ready;
    assert.equal(wa.calls.assert, 1);
    assert.equal(env.store.list()[0].passkey.signCount, 1);
    conn.stop();
  } finally {
    await env.cleanup();
  }
});

test('declined approval and reused pairing codes fail', async () => {
  const env = await setupRelay({ approve: async () => false });
  const wa = softWebAuthn('http://localhost:5173');
  try {
    const fragment = await env.newFragment();
    await assert.rejects(pairWithHost({ fragment, deviceName: 'X', platform: 'iOS', webauthn: wa }), (e) => e.code === 'denied');
    await assert.rejects(pairWithHost({ fragment, deviceName: 'X', platform: 'iOS', webauthn: wa }), (e) => e.untrusted && e.peerCode === 'pairing-expired');
    assert.equal(env.store.list().length, 0);
  } finally {
    await env.cleanup();
  }
});

test('required passkey blocks devices that cannot create one; unknown devices are unpaired', async () => {
  const env = await setupRelay({ policy: { passkey: 'required', allowTotp: false } });
  const noPasskey = { register: async () => { throw new Error('NotAllowedError'); }, assert: async () => { throw new Error('no'); } };
  try {
    await assert.rejects(pairWithHost({ fragment: await env.newFragment(), deviceName: 'Old phone', platform: 'x', webauthn: noPasskey }), (e) => e.code === 'passkey-required');
    const wa = softWebAuthn('http://localhost:5173');
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Good phone', platform: 'iOS', webauthn: wa });
    env.store.clear();
    const conn = new HostConnection(record, { webauthn: wa });
    const unpaired = waitEvent(conn, 'state', (d) => d.state === 'unpaired');
    conn.start();
    await unpaired;
  } finally {
    await env.cleanup();
  }
});

test('authenticator app instead of a passkey: set up while pairing, asked for again after the grace period', async () => {
  const env = await setupRelay({ policy: { passkey: 'required', passkeyGraceHours: 0 } });
  const secret = newSecret();
  const conns = [];
  try {
    // The phone offers the setup key it prepared and a matching code.
    const offered = [];
    const record = await pairWithHost({
      fragment: await env.newFragment(), deviceName: 'Linux laptop', platform: 'Linux · Firefox',
      factor: async (req) => {
        offered.push(req.alternatives);
        await new Promise((r) => setTimeout(r, 300)); // the person takes a moment; the pairing waits
        return { totp: { secret, code: await codeAt(secret, stepAt()) } };
      },
    });
    assert.deepEqual(offered, [['totp']]);
    assert.equal(record.factor, 'totp');
    assert.equal(record.passkey, false);
    const dev = env.store.list()[0];
    assert.equal(dev.totp.secret, secret);
    assert.equal(dev.passkey, null);

    // Next connection: a wrong code first, then the next valid one (the enrollment step can't be reused).
    const asked = [];
    const answers = ['000000'];
    const conn = new HostConnection(record, { askCode: async (req) => { asked.push(req); return answers.shift() ?? codeAt(secret, stepAt() + 1); } });
    conns.push(conn);
    const ready = waitEvent(conn, 'ready');
    conn.start();
    const { welcome } = await ready;
    assert.equal(welcome.factor, 'totp');
    assert.deepEqual(asked.map((a) => a.wrong), [false, true]);
    assert.equal(asked[0].hostName, 'Test PC');
    const after = env.store.list()[0].totp;
    assert.ok(after.lastStep > dev.totp.lastStep, 'the code used is remembered');
    assert.equal(after.failures, 0, 'a right code clears the wrong ones');
    conn.stop();

    // A code typed just before the connection dropped goes along with the next one: no second prompt.
    const now = stepAt();
    env.store.update(dev.id, (d) => ({ totp: { ...d.totp, lastStep: now - 2 } }));
    const quiet = new HostConnection(record, { askCode: async () => { throw new Error('should not ask'); } });
    conns.push(quiet);
    quiet._code = { code: await codeAt(secret, now), at: Date.now() };
    const ready2 = waitEvent(quiet, 'ready');
    quiet.start();
    await ready2;
    assert.equal(env.store.list()[0].totp.lastStep, now);
    quiet.stop();

    // The same code never works twice.
    const replay = new HostConnection(record, { askCode: async () => codeAt(secret, now) });
    conns.push(replay);
    const locked = waitEvent(replay, 'state', (d) => d.state === 'locked', 15000);
    replay.start();
    assert.match((await locked).detail, /Too many wrong codes/);
    assert.equal(env.store.list()[0].totp.failures, 5);
  } finally {
    for (const c of conns) c.stop();
    await env.cleanup();
  }
});

test('authenticator codes lock the device after too many wrong ones, and can be turned off on the PC', async () => {
  const env = await setupRelay({ policy: { passkey: 'required', passkeyGraceHours: 0 } });
  const secret = newSecret();
  const conns = [];
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Tablet', platform: 'x', factor: async () => ({ totp: { secret, code: await codeAt(secret, stepAt()) } }) });
    const dev = env.store.list()[0];
    env.store.update(dev.id, (d) => ({ totp: { ...d.totp, failures: 9 } }));
    const wrong = new HostConnection(record, { askCode: async () => '123456' });
    conns.push(wrong);
    let locked = waitEvent(wrong, 'state', (d) => d.state === 'locked');
    wrong.start();
    assert.match((await locked).detail, /Try again in 15 minutes/);
    const t = env.store.list()[0].totp;
    assert.ok(t.lockedUntil > Date.now() + 14 * 60000, 'locked for 15 minutes');
    assert.equal(t.lockouts, 1);
    // While locked, even the right code isn't asked for.
    const later = new HostConnection(record, { askCode: async () => { throw new Error('should not ask'); } });
    conns.push(later);
    locked = waitEvent(later, 'state', (d) => d.state === 'locked');
    later.start();
    assert.match((await locked).detail, /Try again in 1[45] minutes/);

    // Authenticator apps turned off on the PC: new pairings get no such option, set-up devices must pair again.
    env.policy.allowTotp = false;
    const offered = [];
    await assert.rejects(
      pairWithHost({ fragment: await env.newFragment(), deviceName: 'Other', platform: 'x', factor: async (req) => { offered.push(req.alternatives); return { totp: { secret, code: await codeAt(secret, stepAt()) } }; } }),
      (e) => e.code === 'passkey-required' && /passkey/.test(e.message),
    );
    assert.deepEqual(offered, [[]]);
    env.store.update(dev.id, (d) => ({ totp: { ...d.totp, lockedUntil: 0 } }));
    const off = new HostConnection(record, { askCode: async () => codeAt(secret, stepAt()) });
    conns.push(off);
    const unpaired = waitEvent(off, 'state', (d) => d.state === 'unpaired');
    off.start();
    assert.match((await unpaired).detail, /no longer accepts authenticator app codes/);
  } finally {
    for (const c of conns) c.stop();
    await env.cleanup();
  }
});

test('malformed request targets get a 400 instead of crashing the relay', async () => {
  const env = await setupRelay();
  const net = await import('node:net');
  const raw = (lines) => new Promise((resolve) => {
    const s = net.connect(Number(new URL(env.url).port), '127.0.0.1', () => s.write(lines));
    let data = '';
    s.on('data', (d) => {
      data += d;
    });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    setTimeout(() => s.destroy(), 1500);
  });
  try {
    const plain = await raw('GET //x:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(plain, /^HTTP\/1\.1 400/);
    const upgrade = await raw('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    assert.match(upgrade, /^HTTP\/1\.1 400/);
    const health = await fetch(`${env.url}/health`).then((r) => r.json());
    assert.equal(health.ok, true, 'still serving');
  } finally {
    await env.cleanup();
  }
});

test('the phone gets corrected session statuses, including changes pushed by the PC', async () => {
  const { effectiveStatus } = require('../extension/core/monitor.js');
  // A working main chat with an old failed sub-agent: the session is working, not failed.
  const state = { defaultChat: 'a', chats: [{ resource: 'a', status: 8 }, { resource: 'b', status: 2, interactivity: 'read-only' }] };
  assert.equal(effectiveStatus(32 | 2, state), 32 | 8);
  assert.equal(effectiveStatus(2, { defaultChat: 'a', chats: [{ resource: 'a', status: 1 }, { resource: 'b', status: 16 }] }), 16, 'needs input anywhere still shows');
  assert.equal(effectiveStatus(2, { defaultChat: 'a', chats: [{ resource: 'a', status: 2 }] }), 2, 'a failed main chat is a failed session');

  const env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' }, relayOptions: { adjustSummary: (s) => (s.resource === 'copilotcli:/s1' ? { ...s, status: 40 } : s) } });
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    const { transport } = await ready;
    const client = new AhpClient(transport, { requestTimeoutMs: 10000 });
    client.connect();
    await client.initialize({ clientId: 'phone-status', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] });
    const list = await client.request('listSessions', { channel: 'ahp-root://' });
    assert.equal(list.items[0].status, 40, 'listSessions results are corrected');
    const events = client.events();
    env.relay.pushSummaryChange('copilotcli:/s1', { status: 33 });
    const ev = await events.next();
    assert.equal(ev.value.event.type, 'sessionSummaryChanged');
    assert.deepEqual(ev.value.event.params.changes, { status: 33 });
    await client.shutdown().catch(() => {});
  } finally {
    conn?.stop();
    await env.cleanup();
  }
});

test('connections from foreign origins are refused', async () => {
  const env = await setupRelay();
  try {
    const port = new URL(env.url).port;
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'https://evil.example' } });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('upgrade', () => resolve(101));
      req.on('error', () => resolve(-1));
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await env.cleanup();
  }
});

test('a device revoked during an in-flight handshake never becomes ready', async () => {
  const env = await setupRelay({ policy: { passkey: 'off' } });
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Stolen phone', platform: 'x', webauthn: {} });
    await waitUntil(() => env.relay.connections.size === 0);
    await new Promise((r) => setTimeout(r, 200));
    const connectionsBefore = env.fake.state.connections;
    const sock = new WebSocket(`${env.url.replace('http', 'ws')}/ws`);
    sock.binaryType = 'arraybuffer';
    const frames = [];
    let closed = null;
    sock.onmessage = (e) => frames.push(e.data);
    sock.onclose = (e) => { closed = e.code; };
    await new Promise((r) => { sock.onopen = r; });
    const hello = await createClientHello({ mode: 'resume', deviceKeys: record.deviceKeys });
    sock.send(hello.helloText);
    await waitUntil(() => frames.length > 0);
    const done = await hello.complete(frames.shift(), { hostPublicKey: Buffer.from(record.hostPublicKey, 'base64url') });
    // The owner removes the phone while the attacker holds back the auth frame.
    env.store.remove(record.deviceId);
    env.relay.revokeDevice(record.deviceId);
    const m = new SecureMessenger(done.cipher, (f) => { try { sock.send(f); } catch { /* closed */ } });
    await m.send('C' + JSON.stringify({ t: 'auth', visible: true }));
    await waitUntil(() => closed !== null, 5000);
    const texts = [];
    for (const f of frames) if (typeof f !== 'string') { const t = await m.receive(new Uint8Array(f)).catch(() => null); if (t) texts.push(t); }
    assert.ok(!texts.some((t) => t.includes('"welcome"')), 'must not welcome a revoked device');
    assert.equal(env.relay.activeConnections().length, 0);
    assert.equal(env.fake.state.connections, connectionsBefore, 'no agent host connection for a revoked device');
  } finally {
    await env.cleanup();
  }
});

test('a forged plaintext rejection cannot unpair the phone', async () => {
  const env = await setupRelay({ policy: { passkey: 'off' } });
  const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'x', webauthn: {} });
  await env.cleanup();
  // A malicious tunnel answers every hello with a fake, unauthenticated "revoked".
  const evil = http.createServer();
  evil.on('upgrade', (req, socket, head) => {
    const c = ws.acceptUpgrade(req, socket, head);
    c.on('message', () => c.send(JSON.stringify({ t: 'error', v: 1, code: 'revoked', message: 'Security update: re-pair at https://evil.example' })));
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const conn = new HostConnection({ ...record, url: `http://127.0.0.1:${evil.address().port}` }, { webauthn: {} });
  const states = [];
  conn.addEventListener('state', (e) => states.push(e.detail));
  try {
    conn.start();
    await waitUntil(() => states.some((s) => s.state === 'offline'), 5000);
    assert.ok(!states.some((s) => s.state === 'unpaired' || s.state === 'locked'), 'unauthenticated errors must not unpair');
    assert.ok(!states.some((s) => String(s.detail).includes('evil')), 'attacker text must not be shown');
    assert.equal(conn.stopped, false);
  } finally {
    conn.stop();
    evil.close();
  }
});

test('showing a new pairing code invalidates the previous one', async () => {
  const env = await setupRelay({ policy: { passkey: 'off' } });
  try {
    const oldCode = await env.newFragment();
    const newCode = await env.newFragment();
    await assert.rejects(pairWithHost({ fragment: oldCode, deviceName: 'A', platform: 'x', webauthn: {} }), (e) => e.untrusted && /expired/.test(e.message));
    const record = await pairWithHost({ fragment: newCode, deviceName: 'B', platform: 'x', webauthn: {} });
    assert.equal(record.deviceName, 'B');
  } finally {
    await env.cleanup();
  }
});

test('devices removed by another window are detected and reported', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-store-')), 'devices.json');
  const leader = new DeviceStore(file, { watch: true });
  const removed = [];
  leader.on('removed', (ids) => removed.push(...ids));
  try {
    leader.add({ id: 'd1', publicKey: 'k1', name: 'Phone' });
    const other = new DeviceStore(file);
    assert.equal(other.get('d1').name, 'Phone');
    other.remove('d1');
    await waitUntil(() => removed.includes('d1'), 6000);
    assert.equal(leader.get('d1'), null);
    assert.equal(leader.update('d1', { name: 'x' }), null, 'updates of removed devices must not resurrect them');
  } finally {
    leader.unwatch();
  }
});
