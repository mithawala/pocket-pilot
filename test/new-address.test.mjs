// A computer at a new address: its QR code scanned again (no new pairing), or a notification from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('window', globalThis);
define('location', { pathname: '/pocket-pilot/app/', href: 'https://mithawala.github.io/pocket-pilot/app/', hash: '', search: '', hostname: 'mithawala.github.io' });
define('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5, serviceWorker: {} });
define('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
define('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
define('PushManager', function PushManager() {});
define('Notification', { permission: 'granted' });

const { AppController } = await import('../pwa/js/ui/app.js');
const { HostConnection } = await import('../pwa/js/net/host-connection.js');
const { encodePairingFragment, fingerprint } = await import('../pwa/js/core/secure-channel.js');
const { b64u } = await import('../pwa/js/core/bytes.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hostKey = () => new Uint8Array(crypto.randomBytes(65));
async function linkFor(publicKey, url) {
  return `#${encodePairingFragment({ url, token: crypto.randomBytes(32), hostFingerprint: await fingerprint(publicKey), name: 'Marcuss-MacBook-Pro-4' })}`;
}

/** A device paired with two computers, the first one open; selecting another one only switches. */
function device() {
  const keys = { mac: hostKey(), devbox: hostKey() };
  const app = new AppController({});
  app.hosts = [
    { hostId: 'mac', hostName: 'Marcuss-MacBook-Pro-4.local · Copilot', hostKind: 'copilot', hostPublicKey: b64u(keys.mac), url: 'https://old-mac.trycloudflare.com', pushEnabled: true },
    { hostId: 'devbox', hostName: 'CPC-marcu-HQRJM · Copilot', hostKind: 'copilot', hostPublicKey: b64u(keys.devbox), url: 'https://old-devbox.trycloudflare.com' },
  ];
  app.currentId = 'mac';
  const moves = [];
  let pokes = 0;
  app.active = { host: app.hosts[0], conn: { state: 'offline', moveTo: (url) => moves.push(url), poke: () => pokes++ } };
  app.selectHost = async (id) => {
    app.currentId = id;
  };
  return { app, keys, moves, pokes: () => pokes };
}

test('a QR code from a paired computer only gives its new address: no new pairing', async () => {
  const { app, keys, moves } = device();
  const known = await app.pairedHostFor(await linkFor(keys.devbox, 'https://new-devbox.trycloudflare.com'));
  assert.equal(known.host.hostId, 'devbox');
  assert.equal(known.url, 'https://new-devbox.trycloudflare.com');

  // Another paired computer: its address is updated and it is opened.
  const host = await app.reconnectWithLink(await linkFor(keys.devbox, 'https://new-devbox.trycloudflare.com'));
  assert.equal(host?.hostId, 'devbox');
  assert.equal(app.hosts[1].url, 'https://new-devbox.trycloudflare.com');
  assert.equal(app.currentId, 'devbox');
  assert.deepEqual(moves, [], 'not the open connection');

  // The open one: its connection moves there.
  app.currentId = 'mac';
  assert.equal((await app.reconnectWithLink(await linkFor(keys.mac, 'https://new-mac.trycloudflare.com')))?.hostId, 'mac');
  assert.deepEqual(moves, ['https://new-mac.trycloudflare.com']);
});

test('a QR code from a computer this device is not paired with, or was removed from, pairs', async () => {
  const { app, keys } = device();
  assert.equal(await app.reconnectWithLink(await linkFor(hostKey(), 'https://other.trycloudflare.com')), null, 'another computer');
  assert.equal(await app.reconnectWithLink('#pair=1.garbage'), null);
  app.active.conn.state = 'unpaired';
  assert.equal(await app.reconnectWithLink(await linkFor(keys.mac, 'https://new-mac.trycloudflare.com')), null, 'removed on the computer: pair again');
  app.demo = true;
  assert.equal(await app.reconnectWithLink(await linkFor(keys.devbox, 'https://x.trycloudflare.com')), null, 'never in the demo');
});

test('the same address again just retries now', async () => {
  const { app, keys, moves, pokes } = device();
  assert.equal((await app.reconnectWithLink(await linkFor(keys.mac, 'https://old-mac.trycloudflare.com')))?.hostId, 'mac');
  assert.deepEqual(moves, []);
  assert.equal(pokes(), 1);
});

test('a new address in a notification: only from the computer this device takes notifications from', async () => {
  const { app, moves } = device();
  assert.equal(await app.moveHost('mac', 'https://pushed.trycloudflare.com', { fromPush: true }), true);
  assert.deepEqual(moves, ['https://pushed.trycloudflare.com']);
  assert.equal(await app.moveHost('devbox', 'https://pushed.trycloudflare.com', { fromPush: true }), false, 'notifications are on for the other one');
  assert.equal(app.hosts[1].url, 'https://old-devbox.trycloudflare.com');
  assert.equal(await app.moveHost('nope', 'https://x.trycloudflare.com'), false);
  for (const bad of ['javascript:alert(1)', 'https://evil.example/path', 'http://evil.example', '']) {
    assert.equal(await app.moveHost('mac', bad, { fromPush: true }), false, `not ${bad}`);
  }
  assert.deepEqual(moves, ['https://pushed.trycloudflare.com']);
});

test('the connection moves to the new address, and retries there at once', () => {
  const record = { hostId: 'h', url: 'https://old.trycloudflare.com' };
  const conn = new HostConnection(record, { webauthn: {} });
  const scheduled = [];
  conn._schedule = (ms) => scheduled.push(ms);
  const saved = [];
  conn.addEventListener('record', (e) => saved.push(e.detail.record.url));
  conn.stopped = false;
  conn.state = 'offline';
  conn.failures = 7;
  conn.attempt = 5;
  assert.equal(conn.moveTo('https://new.trycloudflare.com'), true);
  assert.equal(record.url, 'https://new.trycloudflare.com');
  assert.deepEqual(saved, ['https://new.trycloudflare.com'], 'stored');
  assert.deepEqual(scheduled, [0], 'right away');
  assert.equal(conn.failures, 0);
  assert.equal(conn.moveTo('https://new.trycloudflare.com'), false, 'already there');
  conn.state = 'connecting';
  assert.equal(conn.moveTo('https://newer.trycloudflare.com'), true);
  assert.deepEqual(scheduled, [0], 'an attempt under way retries at the new address when it fails');
});

test('without auto-reconnect, the offline banner offers to scan the QR code again', () => {
  const src = fs.readFileSync(path.join(root, 'pwa', 'js', 'ui', 'sessions.js'), 'utf8');
  assert.match(src, /const rescan = onScan && !conn\.record\?\.rendezvous && conn\.failures >= 2;/);
  assert.match(src, /New address\? Scan its QR code again: you stay paired\./);
  const app = fs.readFileSync(path.join(root, 'pwa', 'js', 'ui', 'app.js'), 'utf8');
  assert.equal(app.match(/onScan=\$\{\(\) => setScanning\(true\)\}/g).length, 5, 'from the sessions list and the chat, on phones and computers');
});
