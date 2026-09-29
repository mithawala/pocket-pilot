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

test('devices: Edge, Chrome and Firefox on an iPhone are named by their browser, not as Safari', async () => {
  const { deviceDescription } = await import('../pwa/js/lib/format.js');
  const { pairInHomeScreenApp } = await import('../pwa/js/lib/push.js');
  const cases = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.0.3485.54 Mobile/15E148 Safari/605.1.15', 'iPhone · Edge'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1', 'iPhone · Chrome'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15', 'iPhone · Firefox'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 'iPhone · Safari'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.3485.54', 'Android · Edge'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.54', 'Windows · Edge'],
  ];
  for (const [ua, platform] of cases) {
    navigator.userAgent = ua;
    assert.equal(deviceDescription().platform, platform);
  }
  // Every iPhone browser keeps its Home Screen app apart, so each gets the "Home Screen first" advice.
  navigator.userAgent = cases[0][0];
  assert.equal(pairInHomeScreenApp(), true);
});
