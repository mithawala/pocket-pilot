// Live, read-only integration check: phone client -> encrypted relay -> the REAL VS Code agent host.
// Usage: node scripts/live-check.mjs [sessionFilter]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pairWithHost, HostConnection } from '../pwa/js/net/host-connection.js';
import { encodePairingFragment } from '../pwa/js/core/secure-channel.js';
import { AhpClient } from '../pwa/vendor/ahp/client/index.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../pwa/vendor/ahp/types/index.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { RelayServer } = require(path.join(root, 'extension/core/relay.js'));
const { DeviceStore, MemorySecrets } = require(path.join(root, 'extension/core/store.js'));
const { loadHostIdentity } = require(path.join(root, 'extension/core/identity.js'));
const agentHost = require(path.join(root, 'extension/core/agentHost.js'));
const { SessionMonitor } = require(path.join(root, 'extension/core/monitor.js'));

const watchdog = setTimeout(() => { console.error('live-check: timed out'); process.exit(2); }, 60000);
const userData = process.env.VSCODE_USER_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Code');
const endpoint = agentHost.selectEndpoint(userData);
if (!endpoint) {
  console.error('No live VS Code agent host endpoint found under', userData);
  process.exit(1);
}
console.log('agent host:', agentHost.describeEndpoint(endpoint).replace(/pipe\\[^\s]+/, 'pipe\\…'));

const identity = await loadHostIdentity(new MemorySecrets(), os.hostname());
const store = new DeviceStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-live-')), 'devices.json'));
// The same session monitor the extension runs: it corrects statuses the host over-reports as errors.
const monitor = new SessionMonitor({ getEndpoint: () => endpoint });
monitor.start();
for (let i = 0; i < 100 && !monitor.connected; i++) await new Promise((r) => setTimeout(r, 100));
for (let i = 0; i < 50 && [...monitor.tracked.values()].some((t) => !t.state); i++) await new Promise((r) => setTimeout(r, 100));
const relay = new RelayServer({
  identity, store,
  getAgentEndpoint: () => endpoint,
  approveDevice: async () => true,
  allowedOrigins: () => [],
  policy: () => ({ requireApproval: false, passkey: 'off', passkeyGraceHours: 12 }),
  welcomeExtras: () => ({}),
  adjustSummary: (s) => monitor.adjustSummary(s),
  log: (l, m) => console.log(`[relay:${l}]`, m),
});
const port = await relay.listen(0);
const t = await relay.createPairingToken();
const url = `http://127.0.0.1:${port}`;
const record = await pairWithHost({ fragment: '#' + encodePairingFragment({ url, token: t.token, hostFingerprint: identity.fingerprint, name: identity.name }), deviceName: 'live-check', platform: 'node', webauthn: {} });
console.log('paired device', record.deviceId);

const conn = new HostConnection(record, { webauthn: {} });
const ready = new Promise((r) => conn.addEventListener('ready', (e) => r(e.detail), { once: true }));
conn.start();
const { transport } = await ready;
const client = new AhpClient(transport, { requestTimeoutMs: 45000 });
client.connect();
const init = await client.initialize({ clientId: `pocket-pilot-live-${Date.now()}`, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], initialSubscriptions: ['ahp-root://'] });
const rootState = init.snapshots.find((s) => s.resource === 'ahp-root://')?.state;
console.log('negotiated protocol', init.protocolVersion, '| agents:', (rootState?.agents || []).map((a) => `${a.displayName} (${a.models.length} models)`).join(', '));
const { items } = await client.request('listSessions', { channel: 'ahp-root://' });
console.log(`sessions through the encrypted relay: ${items.length} (status as the phone sees it; host's raw status in brackets when corrected)`);
for (const s of items) {
  const raw = monitor.sessions.get(s.resource)?.status;
  console.log(`  ${String(s.status).padStart(3)}${raw !== undefined && raw !== s.status ? ` [${raw}]` : ''}  ${s.title}`);
}
const filter = process.argv[2];
const target = filter ? items.find((s) => s.title.toLowerCase().includes(filter.toLowerCase()) || s.resource.includes(filter)) : items[0];
if (target) {
  const t0 = Date.now();
  const { result } = await client.subscribe(target.resource);
  const st = result.snapshot.state;
  const chat = st.defaultChat || st.chats?.[0]?.resource;
  const { result: cr } = await client.subscribe(chat);
  const cs = cr.snapshot.state;
  const bytes = JSON.stringify(cs).length;
  console.log(`opened "${target.title}": ${cs.turns.length} turns, activeTurn=${!!cs.activeTurn}, inputNeeded=${(st.inputNeeded || []).length}, snapshot ${(bytes / 1024).toFixed(0)} KB in ${Date.now() - t0} ms`);
  console.log('session config:', JSON.stringify(st.config || {}).slice(0, 600));
  const last = cs.turns[cs.turns.length - 1];
  if (last) console.log('last user message:', JSON.stringify(last.message.text.slice(0, 120)), '| model:', JSON.stringify(last.message.model));
  for (const r of st.inputNeeded || []) console.log('input needed:', r.kind, JSON.stringify(r).slice(0, 400));
}
await client.shutdown();
conn.stop();
await relay.close();
monitor.stop();
clearTimeout(watchdog);
console.log('live-check OK');
process.exit(0);
