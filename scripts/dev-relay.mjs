#!/usr/bin/env node
// Standalone relay for development and testing — the same core the extension uses, without VS Code.
//   node scripts/dev-relay.mjs [--port 8787] [--passkey off|optional|required] [--tunnel] [--approve auto|deny]
// Prints a pairing link. Secrets live in .dev-relay/ (git-ignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { RelayServer } = require(path.join(root, 'extension/core/relay.js'));
const { DeviceStore, FileSecrets } = require(path.join(root, 'extension/core/store.js'));
const identityLib = require(path.join(root, 'extension/core/identity.js'));
const agentHost = require(path.join(root, 'extension/core/agentHost.js'));
const { SessionMonitor } = require(path.join(root, 'extension/core/monitor.js'));
const { TunnelManager } = require(path.join(root, 'extension/core/tunnel.js'));
const { encodePairingFragment } = await import('../pwa/js/core/secure-channel.js');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const port = Number(arg('port', 8787));
const passkey = arg('passkey', 'optional');
const approve = arg('approve', 'auto');
const stateDir = path.join(root, '.dev-relay');
fs.mkdirSync(stateDir, { recursive: true });

const userData = process.env.VSCODE_USER_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Code');
const log = (l, m) => console.log(`${new Date().toISOString().slice(11, 19)} [${l}] ${m}`);
const secrets = new FileSecrets(path.join(stateDir, 'secrets.json'));
const identity = await identityLib.loadHostIdentity(secrets, `${os.hostname()} (dev)`);
const vapid = await identityLib.loadVapid(secrets);
const store = new DeviceStore(path.join(stateDir, 'devices.json'));
const monitor = new SessionMonitor({ getEndpoint: () => agentHost.selectEndpoint(userData), log });
monitor.start();

let publicUrl = null;
const relay = new RelayServer({
  identity,
  store,
  getAgentEndpoint: () => agentHost.selectEndpoint(userData),
  approveDevice: async (info) => {
    log('info', `Pairing request from "${info.name}" (${info.platform}) -> ${approve}`);
    return approve === 'auto';
  },
  allowedOrigins: () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(publicUrl ? [publicUrl] : []), ...String(process.env.PP_ORIGINS || '').split(',').filter(Boolean)],
  policy: () => ({ requireApproval: true, passkey, passkeyGraceHours: Number(arg('grace', 12)) }),
  welcomeExtras: () => ({ vapidPublicKey: vapid.publicKey, rendezvous: null, pwaUrl: null }),
  isReadAllowed: () => true,
  saveUpload: async ({ name, data }) => {
    const dir = path.join(stateDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`);
    fs.writeFileSync(file, data);
    return { path: file, uri: `file:///${file.replace(/\\/g, '/')}` };
  },
  pwaDir: path.join(root, 'pwa'),
  log,
});
await relay.listen(port, '127.0.0.1');
log('info', `Relay on http://127.0.0.1:${port}  agent host: ${agentHost.describeEndpoint(agentHost.selectEndpoint(userData))}`);

if (flag('tunnel')) {
  const tm = new TunnelManager({ storageDir: path.join(stateDir, 'tunnel'), log });
  const bin = tm.findBinary() || (await tm.download((m) => log('info', m)));
  publicUrl = await tm.start(port, bin);
  process.on('SIGINT', () => tm.stop().then(() => process.exit(0)));
}

async function printLink() {
  const base = publicUrl || `http://127.0.0.1:${port}`;
  const t = await relay.createPairingToken(30 * 60 * 1000);
  const frag = encodePairingFragment({ url: base, token: t.token, hostFingerprint: identity.fingerprint, name: identity.name });
  const link = `${base}/#${frag}`;
  fs.writeFileSync(path.join(stateDir, 'pairing-link.txt'), link);
  log('info', `Pairing link (single use, 30 min): ${link}`);
}
await printLink();
relay.on('pairing-token-used', () => setTimeout(printLink, 500));
relay.on('paired', (d) => log('info', `PAIRED ${d.name} passkey=${!!d.passkey}`));
monitor.on('transition', (t) => log('info', `transition ${t.kind}: ${t.session.title}`));
