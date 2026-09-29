#!/usr/bin/env node
// End-to-end check of the GitHub Copilot plugin against the REAL Copilot runtime:
//   runtime (with copilot-plugin loaded) -> extension process -> hub -> encrypted relay -> phone store.
// The phone pairs, sees the session, sends a message, approves a shell command and gets the answer;
// then messages typed "on the PC" show up on the phone, a picture attached to one included. Uses a
// throwaway POCKET_PILOT_HOME, a local tunnel (no cloudflared) and a small model.
//   node scripts/e2e-copilot.mjs [--sdk <copilot-sdk dir>] [--cli <copilot executable>] [--model gpt-5-mini]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const localApp = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub Copilot', 'copilot-sdk') : '';
const sdkDir = arg('sdk', process.env.COPILOT_SDK_DIR || localApp);
function onPath(name) {
  if (path.isAbsolute(name)) return name;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) for (const ext of exts) {
    const p = path.join(dir, name + ext);
    if (dir && fs.existsSync(p)) return p;
  }
  return name;
}
const cli = onPath(arg('cli', process.env.COPILOT_CLI_PATH || 'copilot'));
const model = arg('model', 'gpt-5-mini');
const watchdog = setTimeout(() => fail('timed out'), 6 * 60 * 1000);
const t0 = Date.now();
const step = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${m}`);
let debugDump = () => {};
function fail(m) {
  console.error(`E2E FAILED: ${m}`);
  try {
    debugDump();
  } catch (err) {
    console.error('debug dump failed', err);
  }
  process.exit(1);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-ws-'));
fs.writeFileSync(path.join(ws, 'README.md'), '# e2e workspace\n');
process.env.POCKET_PILOT_HOME = home;
process.env.POCKET_PILOT_DEBUG = '1';
fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ enabled: true, settings: { tunnel: 'none', passkey: 'off', requireApproval: false, rendezvous: false } }));

// Your own Copilot settings can switch extensions off (Customize → Extensions) and list installed
// plugins: run with a copy of the config (for the sign-in) and settings that leave Pocket Pilot on.
const realCopilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-copilot-'));
const readJsonFile = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const copilotConfig = readJsonFile(path.join(realCopilotHome, 'config.json')) || {};
delete copilotConfig.installedPlugins;
fs.writeFileSync(path.join(copilotHome, 'config.json'), JSON.stringify(copilotConfig));
const copilotSettings = readJsonFile(path.join(realCopilotHome, 'settings.json')) || {};
if (copilotSettings.extensions?.disabledExtensions) copilotSettings.extensions.disabledExtensions = copilotSettings.extensions.disabledExtensions.filter((id) => !/pocket-pilot/i.test(id));
fs.writeFileSync(path.join(copilotHome, 'settings.json'), JSON.stringify(copilotSettings));
process.env.COPILOT_HOME = copilotHome;

const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(path.join(sdkDir, 'index.js')).href);
const ipc = await import(pathToFileURL(path.join(root, 'copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib/ipc.mjs')).href);
const { pairWithHost, HostConnection } = await import('../pwa/js/net/host-connection.js');
const { HostStore } = await import('../pwa/js/model/host-store.js');

async function until(fn, what, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) fail(`waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

let pendingPermission = null;
// A copy of the plugin, so the test can "update" it while the runtime runs (see step 7b).
const pluginDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-plugin-')), 'copilot-plugin');
fs.cpSync(path.join(root, 'copilot-plugin'), pluginDir, { recursive: true });
const client = new CopilotClient({
  connection: RuntimeConnection.forStdio({ path: cli }),
  workingDirectory: ws,
  builtinPluginDirectories: [pluginDir],
  env: { ...process.env },
});
await client.start();
step(`runtime started (${cli})`);
const session = await client.createSession({
  workingDirectory: ws,
  model,
  streaming: true,
  requestExtensions: true,
  // Act like the app's UI: leave approvals and questions pending so the phone can answer them.
  onPermissionRequest: () => new Promise((resolve) => {
    pendingPermission = resolve;
  }),
  onUserInputRequest: () => new Promise(() => {}),
});
step(`session ${session.sessionId} created in ${ws}`);
const seen = [];
session.on((e) => seen.push(`${e.type}${e.data?.toolName ? `:${e.data.toolName}` : ''}${e.data?.permissionRequest ? `:${e.data.permissionRequest.kind}` : ''}`));

// Empty sessions (like the app's internal warm-up sessions) stay off the phone: talk to it first.
if (fs.existsSync(path.join(home, 'hub.json'))) fail('an empty session must not host the hub');
await session.sendAndWait({ prompt: 'Reply with just the word ready.' }, 120000);
step('first message typed on the PC');

const hub = await until(() => {
  const h = ipc.readJson(path.join(home, 'hub.json'));
  return h && ipc.isAlive(h.pid) ? h : null;
}, 'the hub to start (extension -> hub)', 90000);
step(`hub running (pid ${hub.pid})`);

const ch = await ipc.connect(hub.port, hub.token, { pid: process.pid });
const hubRpc = new ipc.Rpc(ch, {});
const status = await hubRpc.request('pair', {}, 60000);
step(`pairing link ready (${status.sessions} session(s) attached)`);

const record = await pairWithHost({ fragment: `#${status.pairing.link.split('#')[1]}`, deviceName: 'e2e phone', platform: 'node', webauthn: {} });
const conn = new HostConnection(record, { webauthn: {} });
const store = new HostStore(conn, { unsubscribeDelayMs: 50 });
conn.start();
await until(() => store.sessionsLoaded && store.sessions.size, 'the phone to list sessions', 30000);
const uri = `copilotcli:/${session.sessionId}`;
const summary = store.sessions.get(uri) || fail(`session ${uri} not listed (got ${[...store.sessions.keys()]})`);
step(`phone sees "${summary.title}" in ${summary.project?.displayName} · models: ${store.models('copilotcli').length}`);

const release = store.watchSession(uri);
const chat = await until(() => store.chatFor(uri) && store.chatState.get(store.chatFor(uri)) && store.chatFor(uri), 'the chat snapshot', 30000);
const first = store.chatState.get(chat).turns[0];
if (!first || !/ready/i.test(first.message.text)) fail('the PC history is missing on the phone');
step(`phone has the PC history: "${first.message.text}" -> ${first.responseParts.filter((p) => p.kind === 'markdown').map((p) => p.content).join(' ').slice(0, 40)}`);
debugDump = () => {
  const cs = store.chatState.get(chat);
  console.error('runtime events:', seen.filter((s) => !/delta|partial|usage|model\.|hook\./.test(s)).join(' '));
  console.error('phone turns:', cs.turns.length, 'active:', JSON.stringify(cs.activeTurn ? { id: cs.activeTurn.id, msg: cs.activeTurn.message.text.slice(0, 40), parts: cs.activeTurn.responseParts.map((p) => p.kind + (p.toolCall ? `:${p.toolCall.toolName}:${p.toolCall.status}` : '')) } : null));
  console.error('phone errors:', JSON.stringify(store.errors.map((e) => e.message)));
  console.error('pending permission in harness:', !!pendingPermission);
};

// 1. The phone sends a message that needs a shell command.
store.sendMessage(uri, { text: 'Use the shell tool to run exactly this command: echo pocket-pilot-e2e — then reply with one short sentence that includes the word done.' });
step('phone sent a message');
const pending = await until(() => store.chatState.get(chat).activeTurn?.responseParts.find((p) => p.kind === 'toolCall' && p.toolCall.status === 'pending-confirmation'), 'the approval request on the phone');
step(`phone shows approval: "${pending.toolCall.confirmationTitle}" ${JSON.stringify(pending.toolCall.options.map((o) => o.label))}`);
await until(() => store.sessions.get(uri).status & 16, 'the "needs input" status');
store.confirmTool(chat, store.chatState.get(chat).activeTurn.id, pending.toolCall.toolCallId, true, 'approve-once');
step('phone approved');
const done = await until(() => {
  const cs = store.chatState.get(chat);
  return !cs.activeTurn && cs.turns.length >= 1 ? cs : null;
}, 'the turn to finish', 180000);
const turn = done.turns[done.turns.length - 1];
const tools = turn.responseParts.filter((p) => p.kind === 'toolCall');
const text = turn.responseParts.filter((p) => p.kind === 'markdown').map((p) => p.content).join('\n');
const out = tools.map((p) => (p.toolCall.content || []).map((c) => c.text).join('')).join('\n');
step(`turn ${turn.state}: ${tools.length} tool call(s) [${tools.map((p) => `${p.toolCall.toolName}:${p.toolCall.status}`).join(', ')}]`);
if (!/pocket-pilot-e2e/.test(out)) fail(`tool output missing: ${out.slice(0, 200)}`);
if (!/done/i.test(text)) fail(`reply missing "done": ${text.slice(0, 200)}`);
if (pendingPermission) step('(the harness UI never answered: the phone did)');
step(`reply: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);

// 2. A message typed on the PC shows up on the phone.
await session.send({ prompt: 'Reply with just the word pineapple.' });
const pc = await until(() => {
  const cs = store.chatState.get(chat);
  const last = cs.turns[cs.turns.length - 1];
  return !cs.activeTurn && last?.message.text.includes('pineapple') ? last : null;
}, 'the PC message on the phone', 120000);
step(`PC turn mirrored: "${pc.message.text}" -> ${pc.responseParts.filter((p) => p.kind === 'markdown').map((p) => p.content).join(' ').slice(0, 60)}`);

// 2b. A picture attached on the PC (outside the session folder) shows on the phone, which may read it.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-pictures-'));
const shot = path.join(shotDir, 'screenshot.png');
fs.writeFileSync(shot, PNG);
await session.send({ prompt: 'Reply with just the word picture.', attachments: [{ type: 'file', path: shot, displayName: 'screenshot.png' }] });
const withPicture = await until(() => {
  const cs = store.chatState.get(chat);
  const last = cs.turns[cs.turns.length - 1];
  return !cs.activeTurn && last?.message.attachments?.some((a) => a.displayKind === 'image') ? last : null;
}, 'the attached picture on the phone', 120000);
const picture = withPicture.message.attachments.find((a) => a.displayKind === 'image');
const read = await store.readImage(picture.uri);
if (read.encoding !== 'base64' || !Buffer.from(read.data, 'base64').equals(PNG)) fail(`the phone read the wrong bytes for ${picture.uri}`);
step(`PC picture on the phone: ${picture.label} (${read.contentType}, ${PNG.length} bytes read through the relay)`);
fs.rmSync(shotDir, { recursive: true, force: true });

// 3. The agent asks a question; the phone answers it.
store.sendMessage(uri, { text: 'Use the ask_user tool to ask me whether I prefer tabs or spaces, with the two choices "Tabs" and "Spaces". After I answer, reply with one sentence that repeats my choice.' });
const ask = await until(() => store.chatState.get(chat).activeTurn?.responseParts.find((p) => p.kind === 'inputRequest' && !p.response), 'the question on the phone', 180000);
const q = ask.request.questions[0];
step(`phone shows question: "${q.message}" ${JSON.stringify((q.options || []).map((o) => o.label))}`);
const pick = (q.options || []).find((o) => /spaces/i.test(o.label));
store.answerInput(chat, ask.request.id, 'accept', { [q.id]: pick ? { state: 'submitted', value: { kind: 'selected', value: pick.id } } : { state: 'submitted', value: { kind: 'text', value: 'Spaces' } } });
const answered = await until(() => {
  const cs = store.chatState.get(chat);
  const last = cs.turns[cs.turns.length - 1];
  return !cs.activeTurn && /tabs or spaces/i.test(last?.message.text || '') ? last : null;
}, 'the answered turn', 180000);
const reply = answered.responseParts.filter((p) => p.kind === 'markdown').map((p) => p.content).join(' ');
if (!/spaces/i.test(reply)) fail(`the reply does not repeat the phone's answer: ${reply.slice(0, 160)}`);
step(`answer reached the agent: ${reply.replace(/\s+/g, ' ').slice(0, 100)}`);

// 4. Switching the agent mode from the phone changes the runtime's mode.
store.setConfig(uri, { mode: 'plan' });
await until(async () => (await session.rpc.mode.get().catch(() => null)) === 'plan', 'plan mode in the runtime', 20000);
await until(() => store.sessionState.get(uri)?.config?.values?.mode === 'plan', 'plan mode on the phone', 20000);
store.setConfig(uri, { mode: 'interactive' });
await until(async () => (await session.rpc.mode.get().catch(() => null)) === 'interactive', 'interactive mode again', 20000);
step('mode switched from the phone: interactive -> plan -> interactive');

// 5. The model choice syncs both ways: the phone switches the runtime, and a switch on the PC shows on the phone.
store.setModel(chat, { id: 'gpt-5.4-mini', config: { thinkingLevel: 'low' } });
await until(async () => {
  const cur = await session.rpc.model.getCurrent().catch(() => null);
  return cur?.modelId === 'gpt-5.4-mini' && cur.reasoningEffort === 'low';
}, 'the phone\'s model in the runtime', 30000);
await session.setModel('gpt-5-mini', { reasoningEffort: 'high' });
await until(() => store.modelFor(chat)?.id === 'gpt-5-mini' && store.modelFor(chat).config?.thinkingLevel === 'high', 'the PC\'s model on the phone', 30000);
step('model synced: phone -> runtime (GPT-5.4 mini · Low) and runtime -> phone (GPT-5 mini · High)');

// 6. Steering from the phone reaches the running agent.
store.sendMessage(uri, { text: 'Use the shell tool to run: Start-Sleep -Seconds 8 ; then reply with one short sentence.', model: store.modelFor(chat) });
await until(() => store.chatState.get(chat).activeTurn?.responseParts.some((p) => p.kind === 'toolCall'), 'the long command to start', 120000);
const pendingSleep = await until(() => store.chatState.get(chat).activeTurn?.responseParts.find((p) => p.kind === 'toolCall' && p.toolCall.status === 'pending-confirmation'), 'the sleep approval', 60000);
store.confirmTool(chat, store.chatState.get(chat).activeTurn.id, pendingSleep.toolCall.toolCallId, true, 'approve-once');
store.steer(uri, { text: 'When you are done, end your reply with the word steered.' });
const steered = await until(() => {
  const c = store.chatState.get(chat);
  const last = c.turns[c.turns.length - 1];
  return !c.activeTurn && /Start-Sleep/.test(last?.message.text || '') ? last : null;
}, 'the steered turn to finish', 180000);
const steeredText = steered.responseParts.filter((p) => p.kind === 'markdown').map((p) => p.content).join(' ');
if (!/steer/i.test(steeredText)) fail(`the steering message did not reach the agent: ${steeredText.slice(0, 200)}`);
step(`steering reached the running agent: ${steeredText.replace(/\s+/g, ' ').slice(0, 90)}`);

// 7. The chat that turned remote access on can be closed and deleted: another open chat takes the hub
//    over on the same local port (and the same tunnel), so the phone reconnects by itself.
const canvasList = await session.rpc.canvas?.list?.().catch((err) => ({ error: err.message }));
if (canvasList?.canvases) {
  if (!canvasList.canvases.some((c) => c.id === 'pocket-pilot' || c.canvasId === 'pocket-pilot' || c.displayName === 'Pocket Pilot')) fail(`the Pocket Pilot panel (canvas) is not declared: ${JSON.stringify(canvasList)}`);
  step(`Pocket Pilot panel (canvas) declared for the GitHub Copilot app (${canvasList.canvases.length} canvas(es) in this runtime)`);
} else {
  step(`canvas API not available in this runtime (${canvasList?.error || 'no canvas.list'}): skipped`);
}
const second = await client.createSession({ workingDirectory: ws, model, requestExtensions: true, onPermissionRequest: () => new Promise(() => {}) });
await second.sendAndWait({ prompt: 'Reply with just the word second.' }, 120000);
const secondUri = `copilotcli:/${second.sessionId}`;
await until(() => store.sessions.has(secondUri), 'the second chat on the phone', 60000);
release();
const deletedAt = Date.now();
await session.disconnect().catch(() => {});
await client.deleteSession(session.sessionId).catch((err) => step(`deleteSession: ${err.message}`));
const moved = await until(() => {
  const h = ipc.readJson(path.join(home, 'hub.json'));
  return h && ipc.isAlive(h.pid) && h.pid !== hub.pid ? h : null;
}, 'another chat to take over the hub', 60000);
if (moved.relayPort !== hub.relayPort) fail(`the new hub listens on another port (${moved.relayPort} instead of ${hub.relayPort}): devices would lose the address`);
await until(() => conn.state === 'online' && store.sessions.has(secondUri) && !store.sessions.has(uri), 'the phone to reconnect to the new hub', 90000);
step(`deleted the chat that started remote access: chat ${second.sessionId.slice(0, 8)} took over (hub ${hub.pid} -> ${moved.pid}, same port ${moved.relayPort}); the phone reconnected in ${((Date.now() - deletedAt) / 1000).toFixed(1)}s without pairing again`);

// 7b. The plugin is updated while the app runs: the next chat has the newer version and takes the hub
//     over from the older one (same port and tunnel), so the phone moves to it by itself.
const versionFile = path.join(pluginDir, 'com.github.copilot', 'extensions', 'pocket-pilot', 'version.json');
fs.writeFileSync(versionFile, `${JSON.stringify({ version: '99.0.0' }, null, 2)}\n`);
const updatedAt = Date.now();
const newer = await client.createSession({ workingDirectory: ws, model, requestExtensions: true, onPermissionRequest: () => new Promise(() => {}) });
await newer.sendAndWait({ prompt: 'Reply with just the word newer.' }, 120000);
const upgraded = await until(() => {
  const h = ipc.readJson(path.join(home, 'hub.json'));
  return h && ipc.isAlive(h.pid) && h.version === '99.0.0' ? h : null;
}, 'the newer version to take the hub over', 90000);
if (upgraded.relayPort !== moved.relayPort) fail(`the newer hub listens on another port (${upgraded.relayPort} instead of ${moved.relayPort})`);
await until(() => conn.state === 'online' && store.sessions.has(`copilotcli:/${newer.sessionId}`), 'the phone to reach the newer hub', 90000);
step(`plugin updated while running: the newer version took over (hub ${moved.pid} -> ${upgraded.pid}, same port) and the phone followed in ${((Date.now() - updatedAt) / 1000).toFixed(1)}s`);
const hubAfter = upgraded;

// 5. `/pocket-pilot off` works from any chat, even one that is not on the phone (no messages yet).
const other = await client.createSession({ workingDirectory: ws, model, requestExtensions: true, onPermissionRequest: () => new Promise(() => {}) });
await new Promise((r) => setTimeout(r, 1500));
const statusLog = [];
other.on((e) => {
  if (/log|info|message/.test(e.type) && e.data?.message) statusLog.push(String(e.data.message));
});
const res = await other.rpc.commands.execute({ commandName: 'pocket-pilot', args: 'status' });
if (res?.error) fail(`/pocket-pilot status failed: ${res.error}`);
await until(() => statusLog.some((l) => /Tunnel:/.test(l)), 'the status report in an unattached chat', 15000);
step(`status from an unattached chat: ${statusLog.find((l) => /Tunnel:/.test(l)).split('\n')[1]}`);
await other.rpc.commands.execute({ commandName: 'pocket-pilot', args: 'off' });
await until(() => !fs.existsSync(path.join(home, 'hub.json')), 'the hub to stop after /pocket-pilot off', 20000);
await until(() => conn.state !== 'online', 'the phone to be disconnected', 20000);
step(`/pocket-pilot off from an unattached chat stopped the hub (pid ${hubAfter.pid}) and disconnected the phone`);
await other.disconnect().catch(() => {});
await second.disconnect().catch(() => {});
await newer.disconnect().catch(() => {});

store.dispose();
conn.stop();
await session.disconnect().catch(() => {});
await client.stop().catch(() => {});
await hubRpc.request('stop').catch(() => {});
ch.close();
clearTimeout(watchdog);
for (const dir of [home, ws, copilotHome, path.dirname(pluginDir)]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
step('E2E OK');
process.exit(0);
