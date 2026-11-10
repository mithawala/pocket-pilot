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
import { pathToFileURL, fileURLToPath } from 'node:url';
import { childUri, Download } from '../pwa/js/lib/files.js';

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
  const state = { tokens: [], received: [], connections: 0, conns: [] };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('tkn') !== 'secret-connection-token') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const c = ws.acceptUpgrade(req, socket, head);
    state.connections++;
    state.conns.push(c);
    c.on('message', (text) => {
      const m = JSON.parse(text);
      state.received.push(m);
      // Left unanswered (a very large chat the host never finishes sending).
      if (m.id !== undefined && state.hang?.(m)) return;
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
      } else if (m.method === 'subscribe' && state.chats?.[m.params.channel]) {
        reply({ snapshot: { resource: m.params.channel, fromSeq: 10, state: state.chats[m.params.channel] } });
      } else if (m.method === 'dispatchAction') {
        c.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: { channel: m.params.channel, action: m.params.action, serverSeq: 11, origin: { clientId: 'x', clientSeq: m.params.clientSeq } } }));
        // What the host itself sends next (the agent's answer, say), as VS Code does: without an origin.
        for (const action of state.serverActions?.(m.params) || []) c.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: { channel: m.params.channel, action, serverSeq: 12 } }));
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

test('a device that can no longer use its passkey sets up another factor after a yes on the PC', async () => {
  const env = await setupRelay({ policy: { passkey: 'required', passkeyGraceHours: 0, requireApproval: false } });
  const wa = softWebAuthn('http://localhost:5173');
  const conns = [];
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Louise iPhone', platform: 'iPhone · Home Screen app', webauthn: wa });
    assert.equal(env.approvals.length, 0, 'pairing needed no approval on this PC');
    const dev = env.store.list()[0];
    assert.ok(dev.passkey?.credentialId);

    // The app that kept the passkey was turned off, so Face ID finds nothing: set up again, with codes this time.
    const secret = newSecret();
    const states = [];
    const conn = new HostConnection(record, {
      webauthn: wa,
      confirmPasskey: async () => ({ reset: true }),
      enrollFactor: async (req) => {
        assert.deepEqual(req.alternatives, ['totp']);
        assert.equal(req.deviceName, 'Louise iPhone');
        return { totp: { secret, code: await codeAt(secret, stepAt()) } };
      },
    });
    conns.push(conn);
    conn.addEventListener('state', (e) => states.push(e.detail.state));
    const ready = waitEvent(conn, 'ready');
    conn.start();
    const { welcome } = await ready;
    assert.equal(env.approvals.length, 1, 'setting up again always needs a yes on the PC, even when pairing does not');
    assert.equal(env.approvals[0].reset, true);
    assert.ok(states.includes('approval') && states.includes('setup'), states.join(','));
    assert.equal(welcome.factor, 'totp');
    let now = env.store.list()[0];
    assert.equal(now.id, dev.id, 'the same device, not a new pairing');
    assert.equal(now.passkey, null);
    assert.equal(now.totp.secret, secret);
    conn.stop();

    // And back to a passkey from the code prompt ("Lost your authenticator app?").
    const back = new HostConnection(record, { webauthn: wa, askCode: async () => ({ reset: true }) });
    conns.push(back);
    const ready2 = waitEvent(back, 'ready');
    back.start();
    const { welcome: w2 } = await ready2;
    now = env.store.list()[0];
    assert.equal(w2.factor, 'passkey');
    assert.ok(now.passkey?.credentialId);
    assert.equal(now.totp, undefined);
    assert.equal(env.approvals.length, 2);
  } finally {
    for (const c of conns) c.stop();
    await env.cleanup();
  }
});

test('setting up a device again is refused without a yes on the PC', async () => {
  const env = await setupRelay({ policy: { passkey: 'required', passkeyGraceHours: 0 }, approve: async (info) => !info.reset });
  const wa = softWebAuthn('http://localhost:5173');
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Stolen phone', platform: 'x', webauthn: wa });
    conn = new HostConnection(record, { webauthn: wa, confirmPasskey: async () => ({ reset: true }), enrollFactor: async () => { throw new Error('should not get this far'); } });
    const locked = waitEvent(conn, 'state', (d) => d.state === 'locked');
    conn.start();
    assert.match((await locked).detail, /declined/);
    assert.ok(env.store.list()[0].passkey?.credentialId, 'the old passkey stays');
  } finally {
    conn?.stop();
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

test('a very long chat reaches the phone slimmed: finished tool output trimmed, answers and running tools intact', async () => {
  const CHAT = 'ahp-chat://default/long';
  const output = 'line of tool output\n'.repeat(20000);
  const turns = Array.from({ length: 30 }, (_, i) => ({
    id: `t${i}`,
    message: { text: `step ${i}` },
    state: 'complete',
    responseParts: [
      { kind: 'markdown', id: `m${i}`, content: `Answer ${i}: ${'detail '.repeat(3000)}` },
      { kind: 'toolCall', toolCall: { status: 'completed', toolCallId: `c${i}`, toolName: 'run', toolInput: JSON.stringify({ command: 'npm test' }), content: [{ type: 'text', text: output }, { type: 'embeddedResource', data: crypto.randomBytes(30000).toString('base64'), contentType: 'image/png' }] } },
    ],
  }));
  const running = { status: 'running', toolCallId: 'live', toolName: 'run', content: [{ type: 'text', text: output }] };
  const env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' } });
  env.fake.state.chats = { [CHAT]: { turns, activeTurn: { id: 'now', message: { text: 'go on' }, responseParts: [{ kind: 'toolCall', toolCall: running }] } } };
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    const { transport } = await ready;
    const sizes = [];
    const realDeliver = transport._deliver.bind(transport);
    transport._deliver = (text) => {
      sizes.push(text.length);
      realDeliver(text);
    };
    const client = new AhpClient(transport, { requestTimeoutMs: 20000 });
    client.connect();
    await client.initialize({ clientId: 'phone-long', protocolVersions: ['0.9.0'], initialSubscriptions: [] });
    const { result } = await client.subscribe(CHAT);
    const raw = JSON.stringify(env.fake.state.chats[CHAT]).length;
    const got = result.snapshot.state;
    assert.ok(raw > 12e6, `test chat is ${raw} chars`);
    assert.ok(Math.max(...sizes) < raw / 5, `the phone got ${Math.max(...sizes)} of ${raw} chars`);
    assert.equal(got.turns.length, 30);
    got.turns.forEach((t, i) => {
      assert.equal(t.responseParts[0].content, turns[i].responseParts[0].content, 'answers are never trimmed');
      const [text, image] = t.responseParts[1].toolCall.content;
      assert.equal(image.data, '', 'screenshots are not sent');
      assert.ok(text.text.length < (i >= 20 ? 6100 : 400), `turn ${i}: ${text.text.length}`);
      assert.match(text.text, /trimmed: \d+ KB more on your computer/);
      assert.equal(t.responseParts[1].toolCall.toolInput, JSON.stringify({ command: 'npm test' }));
    });
    assert.deepEqual(got.activeTurn.responseParts[0].toolCall, running, 'a running tool call is left alone');
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

test('files: a paired phone lists, finds and downloads the files in session folders, in pieces, and nothing outside them', async () => {
  const { isInFolder } = require('../extension/core/attachments.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-files-out-'));
  fs.mkdirSync(path.join(dir, 'renders'));
  const film = crypto.randomBytes(3 * 512 * 1024 + 12345);
  fs.writeFileSync(path.join(dir, 'renders', 'promo final #1.mp4'), film);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Notes\n');
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(dir, 'README.md'), old, old);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const root = pathToFileURL(dir).href;
  const checked = [];
  const isReadAllowed = (uri) => {
    checked.push(uri);
    try {
      return isInFolder(fileURLToPath(String(uri)), dir);
    } catch {
      return false;
    }
  };
  const env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' }, relayOptions: { isReadAllowed } });
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    await ready;
    assert.equal(conn.canBrowseFiles, true, 'the PC says it can');

    const list = await conn.files('list', { uri: root });
    assert.deepEqual(list.entries.map((e) => `${e.type}:${e.name}`).sort(), ['directory:.git', 'directory:node_modules', 'directory:renders', 'file:README.md']);
    assert.equal(list.entries.find((e) => e.name === 'README.md').size, 8);
    const recent = await conn.files('recent', { uri: root });
    assert.deepEqual(recent.files.map((f) => f.path), ['renders/promo final #1.mp4', 'README.md'], 'newest first, without .git and node_modules');

    const fileUri = childUri(childUri(root, 'renders'), 'promo final #1.mp4');
    const st = await conn.files('stat', { uri: fileUri });
    assert.deepEqual([st.type, st.size], ['file', film.length]);
    // The phone's own download: a few pieces at a time through the encrypted channel, joined in order.
    const d = new Download(conn, fileUri);
    const finished = new Promise((resolve) => d.addEventListener('change', () => ['done', 'failed'].includes(d.state) && resolve()));
    d.start();
    await finished;
    assert.equal(d.state, 'done', d.error?.message);
    assert.ok(Buffer.from(await d.blob.arrayBuffer()).equals(film), 'the same file, byte for byte');

    // Two downloads at once and a listing: more requests than the PC runs at a time, so some wait their turn.
    const two = [new Download(conn, fileUri), new Download(conn, fileUri)];
    const both = two.map((x) => new Promise((resolve) => x.addEventListener('change', () => ['done', 'failed'].includes(x.state) && resolve())));
    two.forEach((x) => x.start());
    const listed = conn.files('list', { uri: root });
    await Promise.all(both);
    assert.deepEqual(two.map((x) => x.state), ['done', 'done'], two.map((x) => x.error?.message).join());
    assert.equal((await listed).entries.length, 4);

    // A piece is at most 1 MB, however much is asked for.
    const big = await conn.files('read', { uri: fileUri, offset: 0, length: 50 * 1024 * 1024 });
    assert.equal(Buffer.from(big.data, 'base64').length, 1024 * 1024);

    // Nothing outside the session folders, however it is asked for.
    const secret = pathToFileURL(path.join(outside, 'secret.txt')).href;
    await assert.rejects(conn.files('read', { uri: secret, offset: 0, length: 10 }), (e) => e.code === 'denied');
    await assert.rejects(conn.files('list', { uri: pathToFileURL(outside).href }), (e) => e.code === 'denied');
    await assert.rejects(conn.files('recent', { uri: pathToFileURL(os.tmpdir()).href }), (e) => e.code === 'denied');
    await assert.rejects(conn.files('read', { uri: `${root}/../${path.basename(outside)}/secret.txt`, offset: 0, length: 10 }), (e) => e.code === 'denied', '.. is resolved before the check');
    await assert.rejects(conn.files('read', { uri: `${root}/..%2F${path.basename(outside)}%2Fsecret.txt`, offset: 0, length: 10 }), (e) => e.code === 'invalid');
    assert.ok(checked.every((u) => !u.includes('..')), 'the check sees the address as read');
    await assert.rejects(conn.files('read', { uri: 'https://example.com/x', offset: 0 }), (e) => e.code === 'invalid');
    await assert.rejects(conn.files('read', { uri: fileUri, offset: -1 }), (e) => e.code === 'invalid');
    await assert.rejects(conn.files('stat', { uri: childUri(root, 'gone.txt') }), (e) => e.code === 'not-found');
    await assert.rejects(conn.files('fly', { uri: root }), (e) => e.code === 'unsupported');

    // A link in the session folder that leads outside it: listed by the folder, but not opened.
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
    assert.ok((await conn.files('list', { uri: root })).entries.some((e) => e.name === 'link'));
    await assert.rejects(conn.files('list', { uri: childUri(root, 'link') }), (e) => e.code === 'denied');
    await assert.rejects(conn.files('read', { uri: childUri(childUri(root, 'link'), 'secret.txt'), offset: 0, length: 10 }), (e) => e.code === 'denied');
    assert.ok(!(await conn.files('recent', { uri: root })).files.some((f) => f.name === 'secret.txt'), 'Recent does not follow it');
  } finally {
    conn?.stop();
    await env.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('files: a PC without read access says so in its welcome and refuses file requests', async () => {
  const env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' }, relayOptions: { isReadAllowed: undefined } });
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    await ready;
    assert.equal(conn.canBrowseFiles, false);
    await assert.rejects(conn.files('list', { uri: pathToFileURL(os.tmpdir()).href }), (e) => e.code === 'unsupported');
  } finally {
    conn?.stop();
    await env.cleanup();
  }
});

test('files: a session folder reached through a link works, and its links lead nowhere else', async () => {
  const { isInFolder } = require('../extension/core/attachments.js');
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-files-real-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-files-out-'));
  const alias = path.join(os.tmpdir(), `pp-files-alias-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(path.join(real, 'README.md'), '# Notes\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(real, alias, 'junction');
  // The session's folder is the link (like /tmp on a Mac, which is /private/tmp).
  const isReadAllowed = (uri) => {
    try {
      return isInFolder(fileURLToPath(String(uri)), alias);
    } catch {
      return false;
    }
  };
  const env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' }, relayOptions: { isReadAllowed } });
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    await ready;
    const root = pathToFileURL(alias).href;
    assert.deepEqual((await conn.files('list', { uri: root })).entries.map((e) => e.name), ['README.md']);
    const piece = await conn.files('read', { uri: childUri(root, 'README.md'), offset: 0, length: 100 });
    assert.equal(Buffer.from(piece.data, 'base64').toString(), '# Notes\n');
    await assert.rejects(conn.files('read', { uri: pathToFileURL(path.join(outside, 'secret.txt')).href, offset: 0, length: 10 }), (e) => e.code === 'denied');
  } finally {
    conn?.stop();
    await env.cleanup();
    fs.rmSync(alias, { recursive: false, force: true });
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('links: what an agent links in a chat opens on the phone, even outside the session folders, and nothing else', async () => {
  const { isInFolder } = require('../extension/core/attachments.js');
  const { pathToUri } = await import('../pwa/js/core/links.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-work-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-dl-'));
  const shots = path.join(elsewhere, 'caip-se-manager-1.17.0-highlights');
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-secret-'));
  fs.mkdirSync(shots);
  fs.writeFileSync(path.join(shots, '1-leaderboard.png'), crypto.randomBytes(3000));
  fs.writeFileSync(path.join(shots, '2-encryption.png'), crypto.randomBytes(2000));
  fs.writeFileSync(path.join(elsewhere, 'other.txt'), 'not linked');
  fs.writeFileSync(path.join(secret, 'key.txt'), 'secret');
  fs.symlinkSync(secret, path.join(shots, 'sneaky'), 'junction');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-store-'));
  const linkedPathsFile = path.join(storage, 'linked-paths.json');
  const CHAT = 'ahp-chat:/caip';
  const answer = `The screenshots are in [caip-se-manager-1.17.0-highlights](${shots.replace(/\\/g, '/')}), numbered 1–5. Home: [home](${pathToUri(os.homedir())}).`;
  const isReadAllowed = (uri) => {
    try {
      return isInFolder(fileURLToPath(String(uri)), work);
    } catch {
      return false;
    }
  };
  const relayOptions = { isReadAllowed, linkedPathsFile };
  let env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' }, relayOptions });
  env.fake.state.chats = { [CHAT]: { turns: [{ id: 't1', message: { text: 'release notes' }, state: 'complete', responseParts: [{ kind: 'markdown', id: 'm1', content: answer }] }] } };
  let conn;
  const shotUri = childUri(pathToFileURL(shots).href, '1-leaderboard.png');
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    let ready = waitEvent(conn, 'ready');
    conn.start();
    const { transport } = await ready;
    assert.equal(conn.canOpenLinks, true);
    // Before the phone has seen the chat: outside the session folder, so no.
    await assert.rejects(conn.files('stat', { uri: shotUri }), (e) => e.code === 'denied' && /files and folders an agent links to/.test(e.message));

    const client = new AhpClient(transport, { requestTimeoutMs: 10000 });
    client.connect();
    await client.initialize({ clientId: 'phone-links', protocolVersions: ['0.9.0'], initialSubscriptions: [] });
    await client.subscribe(CHAT);
    // The linked folder, with what's in it.
    const folder = await conn.files('list', { uri: pathToFileURL(shots).href });
    assert.deepEqual(folder.entries.map((e) => e.name).sort(), ['1-leaderboard.png', '2-encryption.png', 'sneaky']);
    const piece = await conn.files('read', { uri: shotUri, offset: 0, length: 5000 });
    assert.ok(Buffer.from(piece.data, 'base64').equals(fs.readFileSync(path.join(shots, '1-leaderboard.png'))));
    // Still nothing else: a file next to it, a shortcut in it that leads elsewhere, the home folder.
    await assert.rejects(conn.files('stat', { uri: pathToFileURL(path.join(elsewhere, 'other.txt')).href }), (e) => e.code === 'denied');
    await assert.rejects(conn.files('read', { uri: childUri(childUri(pathToFileURL(shots).href, 'sneaky'), 'key.txt'), offset: 0, length: 10 }), (e) => e.code === 'denied');
    await assert.rejects(conn.files('list', { uri: pathToFileURL(os.homedir()).href }), (e) => e.code === 'denied' && /home folder/.test(e.message));
    await client.shutdown().catch(() => {});
    conn.stop();

    // After a restart (a new relay), links in chats the phone already loaded still open.
    await env.cleanup();
    env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' }, relayOptions });
    const record2 = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone 2', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record2, { webauthn: {} });
    ready = waitEvent(conn, 'ready');
    conn.start();
    await ready;
    assert.equal((await conn.files('stat', { uri: shotUri })).type, 'file');
  } finally {
    conn?.stop();
    await env.cleanup();
    for (const d of [work, elsewhere, secret, storage]) fs.rmSync(d, { recursive: true, force: true });
  }
});

async function linkedRelay({ relayOptions, links = '' }) {
  const env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' }, relayOptions });
  if (links) env.relay.links.scanText(links);
  const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
  const conn = new HostConnection(record, { webauthn: {} });
  const ready = waitEvent(conn, 'ready');
  conn.start();
  const { transport } = await ready;
  return { env, conn, transport };
}
const onlyIn = (folder) => (uri) => {
  const { isInFolder } = require('../extension/core/attachments.js');
  try {
    return isInFolder(fileURLToPath(String(uri)), folder);
  } catch {
    return false;
  }
};
const tooMuch = (e) => e.code === 'denied' && /home folder/.test(e.message);

test('links: another name for the home folder (a junction to it) opens no more than the home folder itself', async () => {
  const { pathToUri } = await import('../pwa/js/core/links.js');
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-home-')));
  const home = path.join(base, 'me');
  const work = path.join(base, 'work');
  const elsewhere = path.join(base, 'elsewhere');
  for (const d of [path.join(home, 'Documents'), path.join(home, 'AppData', 'Local', 'Acme'), work, elsewhere]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, 'Documents', 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(home, 'AppData', 'Local', 'Acme', 'token.txt'), 'token');
  const j = path.join(elsewhere, 'me');
  fs.symlinkSync(home, j, 'junction');
  const { env, conn } = await linkedRelay({
    relayOptions: { isReadAllowed: onlyIn(work), homeDir: home },
    links: `[me](${pathToUri(j)}) [local](${pathToUri(path.join(j, 'AppData', 'Local'))})`,
  });
  const at = (...p) => pathToFileURL(path.join(j, ...p)).href;
  try {
    await assert.rejects(conn.files('list', { uri: at() }), tooMuch, 'the home folder');
    await assert.rejects(conn.files('read', { uri: at('Documents', 'notes.txt'), offset: 0, length: 10 }), tooMuch, 'what is in it');
    await assert.rejects(conn.files('stat', { uri: at('Documents', 'no-such-file.txt') }), tooMuch, 'nor whether something is there');
    await assert.rejects(conn.files('read', { uri: at('AppData', 'Local', 'Acme', 'token.txt'), offset: 0, length: 10 }), tooMuch, 'app data');
    assert.equal((await conn.files('stat', { uri: at('AppData', 'Local') })).type, 'directory', 'a linked app-data folder shows its list');
    // A folder in the home folder is fine, through the junction too.
    env.relay.links.scanText(`[docs](${pathToUri(path.join(j, 'Documents'))})`);
    const piece = await conn.files('read', { uri: at('Documents', 'notes.txt'), offset: 0, length: 10 });
    assert.equal(Buffer.from(piece.data, 'base64').toString(), 'notes');
  } finally {
    conn.stop();
    await env.cleanup();
    fs.rmSync(j, { recursive: false, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('links: Windows short names (C:\\Users\\AMITHA~1) are the home folder too', { skip: process.platform !== 'win32' }, async (t) => {
  const { pathToUri } = await import('../pwa/js/core/links.js');
  // Windows often gives the temp folder by its short name (C:\Users\AMITHA~1\AppData\Local\Temp).
  const short = /^(.*~\d[^\\]*)\\AppData\\Local\\Temp$/i.exec(os.tmpdir())?.[1];
  if (!short || fs.realpathSync.native(short).toLowerCase() !== os.homedir().toLowerCase()) return t.skip('no short name for the home folder here');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-work-'));
  const { env, conn } = await linkedRelay({
    relayOptions: { isReadAllowed: onlyIn(work) },
    links: `[me](${pathToUri(short)}) [local](${pathToUri(path.join(short, 'AppData', 'Local'))})`,
  });
  try {
    await assert.rejects(conn.files('list', { uri: pathToFileURL(short).href }), tooMuch, `${short} is ${os.homedir()}`);
    await assert.rejects(conn.files('list', { uri: pathToFileURL(path.join(short, 'AppData', 'Local', 'Temp')).href }), tooMuch);
  } finally {
    conn.stop();
    await env.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  }
  return undefined;
});

test('links: a network share opens only as a session folder, and is not looked at otherwise', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-work-'));
  const { env, conn } = await linkedRelay({ relayOptions: { isReadAllowed: onlyIn(work) } });
  const realpath = fs.promises.realpath;
  const looked = [];
  fs.promises.realpath = (p, ...rest) => {
    looked.push(String(p));
    return realpath(p, ...rest);
  };
  try {
    // On Windows, \\pp-nohost.invalid\share\x.txt; elsewhere not a file of this computer at all.
    await assert.rejects(conn.files('stat', { uri: 'file://pp-nohost.invalid/share/x.txt' }), (e) => e.code === (process.platform === 'win32' ? 'denied' : 'invalid'));
    assert.deepEqual(looked, []);
  } finally {
    fs.promises.realpath = realpath;
    conn.stop();
    await env.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('links: what VS Code shows back from a message (/rename, !command) does not open; a path typed in a message that the agent links does', async () => {
  const { pathToUri } = await import('../pwa/js/core/links.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-work-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-out-'));
  for (const n of ['promo.mp4', 'renamed.txt', 'command.txt', 'ran.txt']) fs.writeFileSync(path.join(out, n), n);
  const at = (n) => path.join(out, n).replace(/\\/g, '/');
  const { env, conn, transport } = await linkedRelay({ relayOptions: { isReadAllowed: onlyIn(work) } });
  // As VS Code does: it answers `/rename <title>` and runs `!<command>` itself; the rest goes to the agent.
  env.fake.state.serverActions = ({ action: a }) => {
    if (a.type !== 'chat/turnStarted') return [];
    const { text } = a.message;
    const turnId = a.turnId;
    if (text.startsWith('/rename ')) return [{ type: 'chat/responsePart', turnId, part: { kind: 'markdown', id: 'r', content: `Renamed: ${text.slice(8).trim()}` } }];
    if (text.startsWith('!')) {
      return [
        { type: 'chat/toolCallStart', turnId, toolCallId: 'b', toolName: 'terminal', displayName: 'Terminal', intention: text.slice(1) },
        { type: 'chat/toolCallReady', turnId, toolCallId: 'b', invocationMessage: text.slice(1), toolInput: text.slice(1), confirmed: 'not-needed' },
        { type: 'chat/toolCallComplete', turnId, toolCallId: 'b', result: { success: true, pastTenseMessage: `Ran [ran.txt](${pathToUri(at('ran.txt'))})` } },
      ];
    }
    return [{ type: 'chat/responsePart', turnId, part: { kind: 'markdown', id: 'm', content: `Done: [promo.mp4](${at('promo.mp4')})` } }];
  };
  const client = new AhpClient(transport, { requestTimeoutMs: 10000 });
  client.connect();
  try {
    await client.initialize({ clientId: 'phone-echo', protocolVersions: ['0.9.0'], initialSubscriptions: [] });
    const CHAT = 'ahp-chat:/echo';
    const turn = (turnId, text) => client.dispatch(CHAT, { type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind: 'user' } } });
    turn('t1', `/rename [renamed](${pathToUri(at('renamed.txt'))})`);
    turn('t2', `!echo [command](${pathToUri(at('command.txt'))})`);
    turn('t3', `Render the promo and save it to ${at('promo.mp4')}`);
    const uri = (n) => pathToFileURL(at(n)).href;
    let opened = false;
    for (let i = 0; i < 100 && !opened; i++) {
      opened = await conn.files('stat', { uri: uri('promo.mp4') }).then(() => true, () => false);
      if (!opened) await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(opened, 'the file the agent linked opens, though its path was typed in the message');
    for (const n of ['renamed.txt', 'command.txt', 'ran.txt']) await assert.rejects(conn.files('stat', { uri: uri(n) }), (e) => e.code === 'denied', n);
  } finally {
    await client.shutdown().catch(() => {});
    conn.stop();
    await env.cleanup();
    for (const d of [work, out]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('links: a device cannot plant a link the computer would trust (it ends tool calls only as plain-text failures)', async () => {
  const env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' } });
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    const { transport } = await ready;
    const client = new AhpClient(transport, { requestTimeoutMs: 10000 });
    client.connect();
    await client.initialize({ clientId: 'phone-plant', protocolVersions: ['0.9.0'], initialSubscriptions: [] });
    const secret = pathToFileURL(path.join(os.homedir(), 'Documents', 'secret.txt')).href;
    // Continue without signing in, as the app sends it: passed on as it is.
    client.dispatch('ahp-chat:/c1', { type: 'chat/toolCallComplete', turnId: 't1', toolCallId: 'a', result: { success: false, pastTenseMessage: 'Skipped Search repositories', error: { message: 'The user chose to continue without signing in.', code: 'cancelled' } } });
    // A link in the text: defused. A "success", or more fields: never passed on.
    client.dispatch('ahp-chat:/c1', { type: 'chat/toolCallComplete', turnId: 't1', toolCallId: 'b', result: { success: false, pastTenseMessage: `Read [secret](${secret})`, invocationMessage: `[secret](${secret})`, error: { message: `[x](${secret})`, code: 'x' } } });
    client.dispatch('ahp-chat:/c1', { type: 'chat/toolCallComplete', turnId: 't1', toolCallId: 'c', result: { success: true, pastTenseMessage: 'ok' } });
    client.dispatch('ahp-chat:/c1', { type: 'chat/toolCallComplete', turnId: 't1', toolCallId: 'd' });
    await client.request('listSessions', { channel: 'ahp-root://' });
    const sent = env.fake.state.received.filter((m) => m.method === 'dispatchAction').map((m) => m.params.action);
    assert.deepEqual(sent.map((a) => a.toolCallId), ['a', 'b'], 'only failures are passed on');
    assert.deepEqual(sent[0].result, { success: false, pastTenseMessage: 'Skipped Search repositories', error: { message: 'The user chose to continue without signing in.', code: 'cancelled' } });
    assert.equal(sent[1].result.invocationMessage, undefined);
    assert.ok(![sent[1].result.pastTenseMessage, sent[1].result.error.message].some((s) => /\]\(/.test(s)), 'no link left');
    await assert.rejects(conn.files('stat', { uri: secret }), (e) => e.code === 'denied');
    await client.shutdown().catch(() => {});
  } finally {
    conn?.stop();
    await env.cleanup();
  }
});

test('agent host: when it stops while a phone is opening a chat, the phone is told what was opening, and the computer logs it', async () => {
  const logs = [];
  const env = await setupRelay({ policy: { requireApproval: false, passkey: 'off' }, relayOptions: { log: (l, m) => logs.push(`${l} ${m}`) } });
  env.fake.state.hang = (m) => m.method === 'subscribe' && m.params.channel === 'ahp-chat:/huge';
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    const statuses = [];
    conn.addEventListener('control', (e) => {
      if (e.detail.message.t === 'ahp.status') statuses.push(e.detail.message);
    });
    const ready = waitEvent(conn, 'ready');
    conn.start();
    const { transport } = await ready;
    const client = new AhpClient(transport, { requestTimeoutMs: 10000 });
    client.connect();
    await client.initialize({ clientId: 'phone-huge', protocolVersions: ['0.9.0'], initialSubscriptions: [] });
    const opening = client.subscribe('ahp-chat:/huge').catch((e) => e);
    await waitUntil(() => env.fake.state.received.some((m) => m.method === 'subscribe'));
    // VS Code's agent host runs out of memory and stops.
    const down = waitEvent(conn, 'state', (d) => d.state === 'offline');
    env.fake.state.conns.at(-1).close();
    assert.match((await down).detail, /agent host is not available/);
    const stopped = statuses.find((s) => s.stopped);
    assert.equal(stopped.connected, false);
    assert.deepEqual(stopped.loading, ['ahp-chat:/huge']);
    assert.equal(conn.hostDown, 1, 'it asks again less and less often');
    assert.ok(logs.some((l) => /stopped while "Phone" was opening ahp-chat:\/huge/.test(l)), logs.join('\n'));
    await opening;
  } finally {
    conn?.stop();
    await env.cleanup();
  }
});

test('agent host: a phone can start it again after VS Code gave up on it, and only then', async () => {
  let running = false;
  let endpoint = null;
  let restarts = 0;
  const env = await setupRelay({
    policy: { requireApproval: false, passkey: 'off' },
    relayOptions: {
      getAgentEndpoint: () => (running ? endpoint : null),
      restartAgentHost: async () => {
        restarts++;
        setTimeout(() => { running = true; }, 300);
      },
      restartWaitMs: 5000,
    },
  });
  endpoint = env.fake.endpoint;
  let conn;
  try {
    const record = await pairWithHost({ fragment: await env.newFragment(), deviceName: 'Phone', platform: 'iOS', webauthn: {} });
    conn = new HostConnection(record, { webauthn: {} });
    const statuses = [];
    conn.addEventListener('control', (e) => {
      if (e.detail.message.t === 'ahp.status') statuses.push(e.detail.message);
    });
    const down = waitEvent(conn, 'state', (d) => d.state === 'offline');
    conn.start();
    await down;
    assert.equal(conn.canRestartAgent, true);
    assert.deepEqual(statuses.at(-1), { t: 'ahp.status', connected: false, reason: 'The VS Code agent host is not running.', restartable: true });
    assert.equal(restarts, 0, 'not without the person asking');

    // The person taps Restart: the computer starts it, waits for it, and connects the phone to it.
    let up = waitEvent(conn, 'control', (d) => d.message.t === 'ahp.status' && d.message.connected);
    conn.restartAgent();
    await up;
    assert.equal(restarts, 1);
    assert.ok(statuses.some((s) => s.restarting && /Starting the VS Code agent host again/.test(s.reason)));
    assert.equal(conn.hostDown, 0);

    // While it runs, asking again doesn't restart it.
    up = waitEvent(conn, 'control', (d) => d.message.t === 'ahp.status' && d.message.connected);
    conn.restartAgent();
    await up;
    assert.equal(restarts, 1);
  } finally {
    conn?.stop();
    await env.cleanup();
  }
});