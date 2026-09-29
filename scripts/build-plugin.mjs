#!/usr/bin/env node
// Assembles the GitHub Copilot plugin (copilot-plugin/): copies the shared core (relay, tunnel,
// pairing, passkeys, push), the AHP client/types, the secure channel and the QR encoder into the
// extension's vendor/ folder with the same relative layout, stamps the version and adds the LICENSE.
// The folder is committed so `copilot plugin install mithawala/pocket-pilot:copilot-plugin` works.
//   node scripts/build-plugin.mjs          # write
//   node scripts/build-plugin.mjs --check  # exit 1 if anything is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const plugin = path.join(root, 'copilot-plugin');
const ext = path.join(plugin, 'com.github.copilot', 'extensions', 'pocket-pilot');
const vendor = path.join(ext, 'vendor');
const check = process.argv.includes('--check');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const want = new Map();
const add = (src, dest) => want.set(path.join(vendor, dest), fs.readFileSync(path.join(root, src)));
for (const f of fs.readdirSync(path.join(root, 'extension', 'core'))) if (f.endsWith('.js')) add(`extension/core/${f}`, `extension/core/${f}`);
for (const f of ['secure-channel.js', 'bytes.js']) add(`pwa/js/core/${f}`, `pwa/js/core/${f}`);
add('pwa/package.json', 'pwa/package.json');
for (const f of walk(path.join(root, 'pwa', 'vendor', 'ahp'))) {
  const rel = path.relative(root, f).split(path.sep).join('/');
  if (!rel.includes('/ws/')) add(rel, rel);
}
add('media/vendor/qrcode.js', 'media/vendor/qrcode.js');
want.set(path.join(plugin, 'LICENSE'), fs.readFileSync(path.join(root, 'LICENSE')));
want.set(path.join(ext, 'version.json'), Buffer.from(`${JSON.stringify({ version: pkg.version }, null, 2)}\n`));

const manifestPath = path.join(plugin, 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
want.set(manifestPath, Buffer.from(`${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`));
const marketPath = path.join(root, '.github', 'plugin', 'marketplace.json');
const market = JSON.parse(fs.readFileSync(marketPath, 'utf8'));
market.plugins = market.plugins.map((p) => (p.name === manifest.name ? { ...p, version: pkg.version } : p));
want.set(marketPath, Buffer.from(`${JSON.stringify(market, null, 2)}\n`));

const existing = fs.existsSync(vendor) ? walk(vendor) : [];
const stale = existing.filter((f) => !want.has(f));
const changed = [...want].filter(([f, buf]) => !fs.existsSync(f) || !fs.readFileSync(f).equals(buf)).map(([f]) => f);

if (check) {
  const bad = [...changed, ...stale].map((f) => path.relative(root, f));
  if (bad.length) {
    console.error(`copilot-plugin is out of date (run node scripts/build-plugin.mjs):\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log('copilot-plugin is up to date');
  process.exit(0);
}

for (const f of stale) fs.rmSync(f);
for (const f of changed) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, want.get(f));
}
console.log(`copilot-plugin ${pkg.version}: ${changed.length} file(s) written, ${stale.length} removed, ${want.size} total`);
