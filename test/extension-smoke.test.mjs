// Loads the real extension entry point against a mocked `vscode` API and drives the full flow:
// activate -> start -> pairing QR -> phone pairs (approval dialog) -> AHP through the relay -> stop.
// The live part needs a running VS Code agent host and is skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Module = require('module');

function createVscodeMock(settings, answers) {
  const commands = new Map();
  const calls = { warnings: [], infos: [], errors: [], sessions: [], context: [], posted: [], opened: [] };
  class EventEmitter {
    constructor() { this.listeners = new Set(); this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
    fire(v) { for (const l of this.listeners) l(v); }
    dispose() { this.listeners.clear(); }
  }
  const Uri = {
    parse(s) {
      const u = new URL(s);
      return { scheme: u.protocol.replace(':', ''), path: u.pathname, fsPath: u.protocol === 'file:' ? fileURLToPath(u) : u.pathname, toString: () => s };
    },
    file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => pathToFileURL(p).href }),
    joinPath: (base, ...parts) => Uri.file(path.join(base.fsPath, ...parts)),
  };
  const log = { info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() {} };
  return {
    calls,
    commands,
    api: {
      EventEmitter,
      Uri,
      ThemeColor: class { constructor(id) { this.id = id; } },
      StatusBarAlignment: { Left: 1, Right: 2 },
      ProgressLocation: { Notification: 15, Window: 10 },
      window: {
        state: { focused: true, active: true },
        onDidChangeWindowState: () => ({ dispose() {} }),
        createOutputChannel: () => log,
        registerWebviewViewProvider: () => ({ dispose() {} }),
        registerUriHandler: () => ({ dispose() {} }),
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        showInformationMessage: async (msg, ...items) => { calls.infos.push(msg); return answers.info?.(msg, items); },
        showWarningMessage: async (msg, ...items) => { calls.warnings.push(msg); return answers.warning?.(msg, items); },
        showErrorMessage: async (msg) => { calls.errors.push(msg); },
        showQuickPick: async () => undefined,
        withProgress: async (_o, fn) => fn({ report() {} }),
      },
      commands: {
        registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
        executeCommand: async (id, ...args) => {
          if (id === 'setContext') calls.context.push(args);
          const fn = commands.get(id);
          return fn ? fn(...args) : undefined;
        },
      },
      workspace: {
        name: 'smoke-test',
        getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
      },
      authentication: {
        // Never hand out a token: the live agent host would adopt it for every VS Code session.
        getSession: async (provider, scopes, opts) => { calls.sessions.push({ provider, scopes, opts }); return undefined; },
      },
      env: { clipboard: { writeText: async () => {} }, openExternal: async (target) => { calls.opened.push(target); return true; } },
    },
  };
}

function installMock(api) {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return orig.call(this, request, ...rest);
  };
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: api };
  return () => {
    Module._resolveFilename = orig;
    delete require.cache.vscode;
  };
}

function makeContext(storage) {
  const secrets = new Map();
  const state = new Map();
  return {
    subscriptions: [],
    globalStorageUri: { fsPath: storage },
    extensionUri: { fsPath: root },
    extensionPath: root,
    extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); } },
  };
}

const realUserData = process.env.VSCODE_USER_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Code');
const agentHost = require('../extension/core/agentHost.js');
const live = agentHost.selectEndpoint(realUserData);

test('extension activates, starts, pairs a phone and relays AHP (live agent host)', { skip: !live && 'no running VS Code agent host' }, async () => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ext-')), 'User', 'globalStorage', 'mithawala.pocket-pilot');
  const settings = { 'tunnel.mode': 'none', 'security.passkey': 'off', 'security.requireApproval': true, 'rendezvous.enabled': false, pwaUrl: '' };
  const mock = createVscodeMock(settings, { warning: (msg, items) => (/Allow "/.test(msg) ? 'Allow' : undefined) });
  const uninstall = installMock(mock.api);
  let service;
  let stopConn;
  try {
    delete require.cache[require.resolve('../extension/extension.js')];
    const ext = require('../extension/extension.js');
    ({ service } = await ext.activate(makeContext(storage)));
    service.userData = realUserData;
    assert.ok(mock.commands.has('pocketPilot.start'));
    assert.equal(service.state, 'stopped', 'must not start before the user asked once');

    await mock.api.commands.executeCommand('pocketPilot.start');
    assert.equal(service.state, 'running', service.error || '');
    assert.ok(!mock.calls.sessions.some((s) => s.opts?.createIfNone), 'starting remote access must not ask for a GitHub sign-in');
    assert.ok(mock.calls.context.some(([k, v]) => k === 'pocketPilot.running' && v === true));
    const vs = service.viewState();
    assert.ok(vs.pairing?.link.includes('#pair=1.'));
    assert.match(vs.pairing.svg, /^<svg/);

    // Sidebar renders and receives state.
    const posted = [];
    const view = { webview: { options: {}, cspSource: 'vscode-resource:', asWebviewUri: (u) => u.fsPath, onDidReceiveMessage: () => {}, postMessage: (m) => posted.push(m) }, onDidChangeVisibility: () => {}, visible: true };
    service.sidebar.resolveWebviewView(view);
    assert.match(view.webview.html, /Content-Security-Policy/);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(posted.some((m) => m.type === 'state' && m.state.state === 'running'));

    // A phone pairs using the QR link.
    const { pairWithHost, HostConnection } = await import('../pwa/js/net/host-connection.js');
    const record = await pairWithHost({ fragment: vs.pairing.link.slice(vs.pairing.link.indexOf('#')), deviceName: 'Smoke phone', platform: 'test', webauthn: {} });
    assert.ok(mock.calls.warnings.some((w) => w.includes('Smoke phone')), 'approval dialog shown');
    assert.equal(service.store.list().length, 1);

    const conn = new HostConnection(record, { webauthn: {} });
    stopConn = () => conn.stop();
    const ready = new Promise((r) => conn.addEventListener('ready', (e) => r(e.detail), { once: true }));
    conn.start();
    const { transport, welcome } = await ready;
    assert.ok(welcome.vapidPublicKey, 'welcome carries the VAPID key for push');
    const { AhpClient } = await import('../pwa/vendor/ahp/client/index.js');
    const { PROTOCOL_VERSIONS } = await import('../pwa/js/core/protocol.js');
    const client = new AhpClient(transport, { requestTimeoutMs: 30000 });
    client.connect();
    // What the phone offers: VS Code accepts only its own protocol version (0.10.x for 1.141).
    await client.initialize({ clientId: `smoke-${Date.now()}`, protocolVersions: [...PROTOCOL_VERSIONS], initialSubscriptions: ['ahp-root://'] });
    const { items } = await client.request('listSessions', { channel: 'ahp-root://' });
    assert.ok(Array.isArray(items) && items.length > 0, 'real sessions visible through the extension relay');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(service.viewState().devices[0].online, true);
    assert.ok(mock.calls.sessions.every((s) => s.scopes.join() === 'gist'), 'only the optional auto-reconnect gist may use GitHub; the agent host stays signed in by VS Code');

    await client.shutdown();
    conn.stop();
    await mock.api.commands.executeCommand('pocketPilot.stop');
    assert.equal(service.state, 'stopped');
  } finally {
    // A connection left open would keep the test process running after a failure.
    stopConn?.();
    if (service) await service.dispose();
    uninstall();
  }
});

test('updates: a VSIX install is offered a newer GitHub release and installs it in one click', async () => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-upd-')), 'User', 'globalStorage', 'mithawala.pocket-pilot');
  const mock = createVscodeMock({}, { info: (msg) => (/is available/.test(msg) ? 'Update' : undefined) });
  const installed = [];
  mock.commands.set('workbench.extensions.installExtension', (uri) => installed.push(uri.fsPath));
  const uninstall = installMock(mock.api);
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    if (String(url).endsWith('/releases/latest')) {
      return new Response(JSON.stringify({
        tag_name: 'v99.0.0',
        html_url: 'https://github.com/mithawala/pocket-pilot/releases/tag/v99.0.0',
        assets: [{ name: 'pocket-pilot.vsix', browser_download_url: 'https://github.com/mithawala/pocket-pilot/releases/download/v99.0.0/pocket-pilot.vsix' }],
      }), { status: 200 });
    }
    if (String(url).endsWith('/pocket-pilot.vsix')) return new Response(Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(4000)]), { status: 200 });
    return realFetch(url, init);
  };
  let service;
  try {
    delete require.cache[require.resolve('../extension/extension.js')];
    const ext = require('../extension/extension.js');
    ({ service } = await ext.activate(makeContext(storage)));
    await service.checkForUpdate({ quiet: false });
    assert.equal(service.update.version, '99.0.0');
    assert.equal(service.viewState().update.version, '99.0.0', 'the panel shows the update');
    assert.equal(installed.length, 1, 'installed through VS Code');
    assert.match(installed[0], /pocket-pilot-99\.0\.0\.vsix$/);
    assert.ok(mock.calls.infos.some((m) => /99\.0\.0 is installed/.test(m)), 'asks to reload');
    assert.ok(fetched.every((u) => u.startsWith('https://api.github.com/') || u.startsWith('https://github.com/')));
  } finally {
    globalThis.fetch = realFetch;
    await service?.dispose();
    uninstall();
  }
});

test('tunnel: closing or reloading VS Code keeps the tunnel and its local port; Stop ends it', async () => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-keep-')), 'User', 'globalStorage', 'mithawala.pocket-pilot');
  const settings = { 'tunnel.mode': 'none', 'security.passkey': 'off', 'rendezvous.enabled': false, pwaUrl: '' };
  const run = async (fn) => {
    const mock = createVscodeMock(settings, {});
    const uninstall = installMock(mock.api);
    let service;
    try {
      delete require.cache[require.resolve('../extension/extension.js')];
      ({ service } = await require('../extension/extension.js').activate(makeContext(storage)));
      service.userData = path.join(storage, 'no-vscode');
      const stops = [];
      service.tunnel.stop = async (o) => {
        stops.push(o);
      };
      // After the first run remote access is still on, so activating starts it again by itself.
      await service.start({ interactive: false });
      for (let i = 0; i < 200 && service.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(service.state, 'running', service.error || '');
      return await fn(service, stops);
    } finally {
      await service?.dispose().catch(() => {});
      uninstall();
    }
  };
  const first = await run(async (service, stops) => {
    const port = service.relay.port;
    await service.dispose();
    assert.deepEqual(stops, [{ keep: true }], 'a window that closes leaves the tunnel running');
    return port;
  });
  await run(async (service, stops) => {
    assert.equal(service.relay.port, first, 'the next start listens where the tunnel forwards');
    await service.stop();
    assert.deepEqual(stops, [{ keep: false }], 'Stop ends the tunnel');
  });
});

test('tunnel (network): a VS Code reload keeps the Cloudflare address; Stop ends cloudflared', { skip: !process.env.PP_NETWORK_TESTS && 'set PP_NETWORK_TESTS=1 (opens a real Cloudflare quick tunnel)', timeout: 240000 }, async () => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-net-')), 'User', 'globalStorage', 'mithawala.pocket-pilot');
  const cloudflared = [path.join(os.homedir(), '.pocket-pilot', 'copilot', 'tunnel', 'bin', 'cloudflared.exe'), path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'mithawala.pocket-pilot', 'bin', 'cloudflared.exe')].find((p) => fs.existsSync(p));
  const settings = { 'tunnel.mode': 'quick', 'tunnel.cloudflaredPath': cloudflared || '', 'security.passkey': 'off', 'rendezvous.enabled': false, pwaUrl: '' };
  const session = async (fn) => {
    const mock = createVscodeMock(settings, {});
    const uninstall = installMock(mock.api);
    let service;
    try {
      delete require.cache[require.resolve('../extension/extension.js')];
      ({ service } = await require('../extension/extension.js').activate(makeContext(storage)));
      service.userData = path.join(storage, 'no-vscode');
      await service.start({ interactive: false });
      for (let i = 0; i < 1200 && !(service.state === 'running' && service.publicUrl); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(service.publicUrl, service.error || 'no tunnel');
      return await fn(service);
    } finally {
      await service?.dispose().catch(() => {});
      uninstall();
    }
  };
  const first = await session(async (s) => s.publicUrl);
  const cf = JSON.parse(fs.readFileSync(path.join(storage, 'tunnel.json'), 'utf8'));
  const { alive } = require('../extension/leader.js');
  assert.ok(alive(cf.pid), 'cloudflared keeps running after the window closes');
  await session(async (s) => {
    assert.equal(s.publicUrl, first, 'same address after the reload');
    await s.stop();
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(alive(cf.pid), false, 'Stop ended cloudflared');
});

test('Open in browser: pairs this PC\'s browser with a one-time link, passed as a string so "#pair=" survives', async () => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-open-')), 'User', 'globalStorage', 'mithawala.pocket-pilot');
  const mock = createVscodeMock({ 'tunnel.mode': 'none', 'security.passkey': 'off', 'rendezvous.enabled': false, pwaUrl: '' }, {});
  const uninstall = installMock(mock.api);
  let service;
  try {
    delete require.cache[require.resolve('../extension/extension.js')];
    ({ service } = await require('../extension/extension.js').activate(makeContext(storage)));
    service.userData = path.join(storage, 'no-vscode');
    await mock.api.commands.executeCommand('pocketPilot.openLocalPwa');
    assert.deepEqual(mock.calls.opened, [], 'nothing to open while remote access is off');
    assert.match(mock.calls.errors.at(-1) || '', /Start remote access first/);

    await service.start({ interactive: false });
    for (let i = 0; i < 200 && service.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(service.state, 'running', service.error || '');
    await mock.api.commands.executeCommand('pocketPilot.openLocalPwa');
    assert.equal(mock.calls.opened.length, 1);
    const [target] = mock.calls.opened;
    assert.equal(typeof target, 'string', 'a Uri would be re-encoded to "#pair%3D…"');
    assert.equal(target, service.viewState().pairing.link);
    assert.match(target, /^http:\/\/127\.0\.0\.1:\d+\/#pair=1\./);
  } finally {
    await service?.stop().catch(() => {});
    await service?.dispose().catch(() => {});
    uninstall();
  }
});

test('settings: pairing links always open the hosted app, even with an old or unreachable app URL', async () => {
  const APP = 'https://mithawala.github.io/pocket-pilot/app/';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    for (const [value, expected] of [[undefined, APP], ['https://mithawala.github.io/pocket-pilot/', APP], ['https://mithawala.github.io/pocket-pilot', APP], ['https://mithawala.github.io/pocket-pilot/app', APP], ['https://example.com/pp', 'https://example.com/pp/']]) {
      const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-url-')), 'User', 'globalStorage', 'mithawala.pocket-pilot');
      const mock = createVscodeMock(value === undefined ? {} : { pwaUrl: value }, {});
      const uninstall = installMock(mock.api);
      let service;
      try {
        delete require.cache[require.resolve('../extension/extension.js')];
        ({ service } = await require('../extension/extension.js').activate(makeContext(storage)));
        await service._checkPwaUrl();
        const s = service.viewState().settings;
        assert.equal(s.pwaUrl, expected, `pwaUrl ${value}`);
        // Only a self-hosted copy that can't be reached falls back to the app served through the tunnel.
        assert.equal(s.pwaFallback, expected !== APP, `fallback for ${value}`);
      } finally {
        await service?.dispose();
        uninstall();
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
