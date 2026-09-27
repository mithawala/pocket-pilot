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
  const calls = { warnings: [], infos: [], errors: [], sessions: [], context: [], posted: [] };
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
        state: { focused: false, active: false },
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
        getSession: async (provider, scopes, opts) => { calls.sessions.push({ provider, scopes, opts }); return { accessToken: 'gho_smoke_test_token', scopes }; },
      },
      env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
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
  try {
    delete require.cache[require.resolve('../extension/extension.js')];
    const ext = require('../extension/extension.js');
    ({ service } = await ext.activate(makeContext(storage)));
    service.userData = realUserData;
    assert.ok(mock.commands.has('pocketPilot.start'));
    assert.equal(service.state, 'stopped', 'must not start before the user asked once');

    await mock.api.commands.executeCommand('pocketPilot.start');
    assert.equal(service.state, 'running', service.error || '');
    assert.ok(mock.calls.sessions.some((s) => s.opts?.createIfNone), 'asks for GitHub consent on first start');
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
    const ready = new Promise((r) => conn.addEventListener('ready', (e) => r(e.detail), { once: true }));
    conn.start();
    const { transport, welcome } = await ready;
    assert.ok(welcome.vapidPublicKey, 'welcome carries the VAPID key for push');
    const { AhpClient } = await import('../pwa/vendor/ahp/client/index.js');
    const client = new AhpClient(transport, { requestTimeoutMs: 30000 });
    client.connect();
    await client.initialize({ clientId: `smoke-${Date.now()}`, protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] });
    const { items } = await client.request('listSessions', { channel: 'ahp-root://' });
    assert.ok(Array.isArray(items) && items.length > 0, 'real sessions visible through the extension relay');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(service.viewState().devices[0].online, true);

    await client.shutdown();
    conn.stop();
    await mock.api.commands.executeCommand('pocketPilot.stop');
    assert.equal(service.state, 'stopped');
  } finally {
    if (service) await service.dispose();
    uninstall();
  }
});
