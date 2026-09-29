// The "Get notified" card at the top of the sessions list: offered while useful, and closable for good.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('window', globalThis);
define('location', { pathname: '/pocket-pilot/app/', href: 'https://mithawala.github.io/pocket-pilot/app/', hash: '', search: '', hostname: 'mithawala.github.io' });
define('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5, serviceWorker: {} });
define('localStorage', { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) });
define('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
define('PushManager', function PushManager() {});
define('Notification', { permission: 'default' });

const { AppController } = await import('../pwa/js/ui/app.js');

function paired() {
  const app = new AppController({});
  app.hosts = [{ hostId: 'h1', hostName: 'Studio PC' }];
  app.currentId = 'h1';
  app.active = { conn: { state: 'online' } };
  return app;
}

test('push prompt: offered while notifications are off, not in the demo or while offline', () => {
  const app = paired();
  assert.ok(app.pushPrompt(), 'offered');
  app.active.conn.state = 'connecting';
  assert.equal(app.pushPrompt(), null, 'not while connecting');
  app.active.conn.state = 'online';
  app.hosts[0].pushEnabled = true;
  Notification.permission = 'granted';
  assert.equal(app.pushPrompt(), null, 'not once notifications are on');
  Notification.permission = 'default';
  assert.equal(new AppController({ demo: true }).pushPrompt(), null, 'not in the demo');
});

test('push prompt: closing the card hides it for good on this device, Home Screen advice included', () => {
  const app = paired();
  navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
  assert.ok(app.pushPrompt(), 'iPhone Safari gets the Home Screen advice');
  let changes = 0;
  app.addEventListener('change', () => changes++);
  app.hidePushPrompt();
  assert.equal(changes, 1, 're-renders at once');
  assert.equal(app.pushPrompt(), null, 'closed');
  assert.equal(paired().pushPrompt(), null, 'still closed after the app restarts');
  storage.clear();
  assert.ok(paired().pushPrompt(), 'only this device\'s choice');
});
