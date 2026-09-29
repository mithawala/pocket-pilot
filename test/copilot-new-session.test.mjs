import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// The phone runtime keeps its list under POCKET_PILOT_HOME: a throwaway one (set before the modules load).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-new-session-'));
process.env.POCKET_PILOT_HOME = home;
const lib = '../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib';
const { CopilotAgentHost } = await import(`${lib}/agent-host.mjs`);
const { PhoneRuntime, takeExpected, runtimePath, isInstalledPlugin } = await import(`${lib}/phone-runtime.mjs`);
const { rootReducer, sessionReducer, chatReducer, SUPPORTED_PROTOCOL_VERSIONS } = await import('../pwa/vendor/ahp/types/index.js');
const { HostStore } = await import('../pwa/js/model/host-store.js');
const agentHost = createRequire(import.meta.url)('../extension/core/agentHost.js');

const MODELS = [{ id: 'gpt-5.4', name: 'GPT-5.4', policy: { state: 'enabled' }, capabilities: { supports: { reasoning_effort: ['low', 'medium', 'high'] } } }];

async function until(fn, ms = 4000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeConnection(transport) {
  const conn = new EventTarget();
  conn.state = 'online';
  queueMicrotask(() => conn.dispatchEvent(new CustomEvent('ready', { detail: { transport } })));
  return conn;
}

function fakeBridge() {
  const calls = [];
  return { calls, request: async (op, params) => (calls.push({ op, params }), true) };
}

test('new session from the phone: the host starts it, waits for its extension, then the first message goes out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-new-cwd-'));
  const created = [];
  const bridge = fakeBridge();
  const host = new CopilotAgentHost({
    reducers: { rootReducer, sessionReducer, chatReducer }, supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    // What the hub does: start the session; its extension attaches it here a moment later.
    createSession: async (req) => {
      created.push(req);
      setTimeout(() => host.attach({ sessionId: req.sessionId, cwd: req.cwd, title: 'New session', history: [], bridge }), 30);
    },
  });
  host.setModels(MODELS);
  const store = new HostStore(fakeConnection(agentHost.transportFor(host.openConnection())), { unsubscribeDelayMs: 10 });
  try {
    await until(() => store.sessionsLoaded);
    assert.deepEqual(store.models('copilotcli').map((m) => m.id), ['auto', 'gpt-5.4']);
    const uri = await store.createSession({
      provider: 'copilotcli', folder: pathToFileURL(dir).href, text: 'Fix the tests', modelAtStart: true,
      model: { id: 'gpt-5.4', config: { thinkingLevel: 'high' } }, config: { mode: 'plan', autoApprove: 'default' },
    });
    assert.equal(created.length, 1);
    assert.equal(`copilotcli:/${created[0].sessionId}`, uri, 'the phone names the session');
    assert.equal(created[0].cwd, dir);
    assert.deepEqual(created[0].config, { mode: 'plan', autoApprove: 'default' });
    assert.deepEqual(created[0].model, { id: 'gpt-5.4', reasoningEffort: 'high' }, 'as runtime arguments');
    const send = await until(() => bridge.calls.find((c) => c.op === 'send'));
    assert.equal(send.params.prompt, 'Fix the tests');
    assert.equal(store.sessions.has(uri), true);
  } finally {
    store.dispose();
    host.closeAll();
  }
});

test('new session from the phone: clear errors, and a folder browser without hidden folders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-new-list-'));
  for (const d of ['src', 'docs', '.git', '$Recycle.Bin']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'README.md'), '#');
  const host = new CopilotAgentHost({ reducers: { rootReducer, sessionReducer, chatReducer }, supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS], createTimeoutMs: 200, createSession: async () => {} });
  const plain = new CopilotAgentHost({ reducers: { rootReducer, sessionReducer, chatReducer }, supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] });
  const conn = { id: 'c', subs: new Set() };
  const listed = await host._handle(conn, 'resourceList', { uri: pathToFileURL(dir).href });
  assert.deepEqual(listed.entries.map((e) => e.name).sort(), ['docs', 'src']);
  await assert.rejects(host._handle(conn, 'resourceList', { uri: pathToFileURL(path.join(dir, 'gone')).href }), /no longer exists/);
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  await assert.rejects(host._handle(conn, 'createSession', { channel: 'copilotcli:/../x', workingDirectories: [pathToFileURL(dir).href] }), /Invalid session address/);
  await assert.rejects(host._handle(conn, 'createSession', { channel: `copilotcli:/${id}`, workingDirectories: [] }), /Choose a folder/);
  await assert.rejects(host._handle(conn, 'createSession', { channel: `copilotcli:/${id}`, workingDirectories: [pathToFileURL(dir).href] }), /did not start on your PC in time/);
  await assert.rejects(plain._handle(conn, 'createSession', { channel: `copilotcli:/${id}`, workingDirectories: [pathToFileURL(dir).href] }), /Start new sessions in the GitHub Copilot app/);
});

function fakeSdk() {
  const log = { created: [], resumed: [], clients: [] };
  const session = (id) => {
    const s = { sessionId: id, calls: [] };
    s.rpc = { mode: { set: async (p) => s.calls.push(['mode', p]) }, permissions: { setMode: async (p) => s.calls.push(['permissions', p]) } };
    return s;
  };
  class CopilotClient {
    constructor(opts) {
      this.opts = opts;
      log.clients.push(this);
    }
    async start() {}
    async createSession(cfg) {
      log.created.push(cfg);
      return (log.last = session(cfg.sessionId));
    }
    async resumeSession(id, cfg) {
      log.resumed.push({ id, cfg });
      return session(id);
    }
    async stop() {
      this.stopped = true;
    }
  }
  return { log, loadSdk: async () => ({ CopilotClient, RuntimeConnection: { forStdio: (o) => ({ kind: 'stdio', ...o }) } }) };
}

test('phone runtime: starts sessions in a runtime of its own, marked so they show up at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-phone-cwd-'));
  const sdk = fakeSdk();
  const id = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
  const rt = new PhoneRuntime({ loadSdk: sdk.loadSdk, cliPath: 'C:\\Tools\\copilot.exe', pluginDir: path.join(os.tmpdir(), 'dev-plugin') });
  await rt.create({ sessionId: id, cwd: dir, config: { mode: 'autopilot', autoApprove: 'autoApprove' }, model: { id: 'gpt-5.4', reasoningEffort: 'high' } });
  const [cfg] = sdk.log.created;
  assert.equal(cfg.sessionId, id);
  assert.equal(cfg.workingDirectory, dir);
  assert.equal(cfg.model, 'gpt-5.4');
  assert.equal(cfg.reasoningEffort, 'high');
  assert.equal(cfg.requestExtensions, true, 'Pocket Pilot (and other plugins) load in it');
  for (const h of ['onPermissionRequest', 'onUserInputRequest', 'onElicitationRequest', 'onExitPlanModeRequest']) assert.equal(typeof cfg[h], 'function', `${h}: the phone answers`);
  assert.deepEqual(sdk.log.last.calls, [['mode', { mode: 'autopilot' }], ['permissions', { mode: 'allow-all' }]]);
  const client = sdk.log.clients[0];
  assert.equal(client.opts.connection.path, 'C:\\Tools\\copilot.exe', 'the runtime the extension itself runs in');
  assert.equal(client.opts.connection.env.POCKET_PILOT_PHONE_RUNTIME, '1');
  assert.deepEqual(client.opts.builtinPluginDirectories, [path.join(os.tmpdir(), 'dev-plugin')], 'a plugin in development is loaded explicitly');
  assert.equal(takeExpected(id), true, 'its extension attaches before the first message');
  assert.equal(takeExpected(id), false, 'once');
  await assert.rejects(rt.create({ sessionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', cwd: path.join(dir, 'missing') }), /doesn't exist on your PC/);
  await rt.stop();
  assert.equal(client.stopped, true);

  // The next hub (after a move or a restart) brings recent sessions back to the phone, not old ones.
  const list = JSON.parse(fs.readFileSync(path.join(home, 'phone-sessions.json'), 'utf8'));
  list.push({ id: '9b2f6a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b', cwd: dir, lastActiveAt: Date.now() - 13 * 3600 * 1000 });
  fs.writeFileSync(path.join(home, 'phone-sessions.json'), JSON.stringify(list));
  const next = new PhoneRuntime({ loadSdk: sdk.loadSdk, cliPath: 'C:\\Tools\\copilot.exe' });
  assert.equal(await next.resumeRecent(), 1);
  assert.deepEqual(sdk.log.resumed.map((r) => r.id), [id]);
  assert.equal(typeof sdk.log.resumed[0].cfg.onPermissionRequest, 'function');
  await next.stop();
});

test('phone runtime: finds the runtime executable and tells installed plugins apart', () => {
  assert.equal(runtimePath('C:\\Users\\me\\AppData\\Local\\github-copilot-sdk\\cli\\1.0.87-0\\copilot.exe'), 'C:\\Users\\me\\AppData\\Local\\github-copilot-sdk\\cli\\1.0.87-0\\copilot.exe');
  assert.equal(runtimePath('/usr/local/bin/copilot'), '/usr/local/bin/copilot');
  assert.equal(runtimePath('C:\\Program Files\\nodejs\\node.exe'), undefined, 'let the SDK find it');
  const copilotHome = path.join(os.tmpdir(), '.copilot');
  assert.equal(isInstalledPlugin(path.join(copilotHome, 'installed-plugins', 'pocket-pilot', 'pocket-pilot'), copilotHome), true);
  assert.equal(isInstalledPlugin(path.join(os.tmpdir(), 'repo', 'copilot-plugin'), copilotHome), false);
});
