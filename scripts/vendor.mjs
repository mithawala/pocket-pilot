#!/usr/bin/env node
// Downloads pinned third-party files from jsDelivr (works even when the npm registry is blocked)
// and records/validates their SHA-256 hashes in scripts/vendor-lock.json.
//
//   node scripts/vendor.mjs            download missing files, verify all against the lock
//   node scripts/vendor.mjs --update   re-download everything and rewrite the lock
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(root, 'scripts', 'vendor-lock.json');
const update = process.argv.includes('--update');
const CDN = 'https://cdn.jsdelivr.net/npm';

const AHP = '@microsoft/agent-host-protocol@0.9.0';

/** @type {{pkg:string, from:string, to:string, url?:string, patch?:(s:string)=>string}[]} */
const files = [
  { pkg: 'preact@10.29.8', from: 'dist/preact.module.js', to: 'pwa/vendor/preact/preact.module.js' },
  {
    pkg: 'preact@10.29.8', from: 'hooks/dist/hooks.module.js', to: 'pwa/vendor/preact/hooks.module.js',
    patch: (s) => s.replace(/from\s*["']preact["']/g, 'from"./preact.module.js"'),
  },
  { pkg: 'preact@10.29.8', from: 'LICENSE', to: 'pwa/vendor/preact/LICENSE' },
  { pkg: 'htm@3.1.1', from: 'dist/htm.module.js', to: 'pwa/vendor/htm/htm.module.js' },
  { pkg: 'htm@3.1.1', from: 'LICENSE', to: 'pwa/vendor/htm/LICENSE' },
  { pkg: 'marked@18.0.14', from: 'lib/marked.esm.js', to: 'pwa/vendor/marked/marked.esm.js' },
  { pkg: 'marked@18.0.14', from: 'LICENSE', to: 'pwa/vendor/marked/LICENSE' },
  { pkg: 'dompurify@3.4.16', from: 'dist/purify.es.mjs', to: 'pwa/vendor/dompurify/purify.es.js' },
  { pkg: 'dompurify@3.4.16', from: 'LICENSE', to: 'pwa/vendor/dompurify/LICENSE' },
  { pkg: 'qrcode-generator@2.0.4', from: 'dist/qrcode.js', to: 'media/vendor/qrcode.js' },
  { pkg: 'jsqr@1.4.0', from: 'dist/jsQR.js', to: 'pwa/vendor/jsqr/jsQR.js' },
  { pkg: 'jsqr@1.4.0', from: 'LICENSE', to: 'pwa/vendor/jsqr/LICENSE' },
];

async function fetchText(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 4) throw new Error(`GET ${url} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function ahpFiles() {
  const [name, version] = [AHP.slice(0, AHP.lastIndexOf('@')), AHP.slice(AHP.lastIndexOf('@') + 1)];
  const res = await fetch(`https://data.jsdelivr.com/v1/packages/npm/${name}@${version}?structure=flat`);
  if (!res.ok) throw new Error(`jsDelivr listing failed: ${res.status}`);
  const listing = await res.json();
  const out = listing.files
    .map((f) => f.name.replace(/^\//, ''))
    .filter((n) => n.startsWith('dist/') && n.endsWith('.js'))
    .map((n) => ({ pkg: AHP, from: n, to: `pwa/vendor/ahp/${n.slice('dist/'.length)}`, patch: stripSourceMap }));
  out.push({
    pkg: AHP, from: 'LICENSE', to: 'pwa/vendor/ahp/LICENSE',
    url: 'https://raw.githubusercontent.com/microsoft/agent-host-protocol/main/LICENSE',
  });
  return out;
}

function stripSourceMap(s) {
  return s.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function main() {
  const lock = fs.existsSync(lockPath) && !update ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : {};
  const all = [...files, ...(await ahpFiles())];
  const newLock = {};
  let downloaded = 0;
  for (const f of all) {
    const dest = path.join(root, f.to);
    let content;
    if (!update && fs.existsSync(dest)) {
      content = fs.readFileSync(dest, 'utf8');
    } else {
      content = await fetchText(f.url || `${CDN}/${f.pkg}/${f.from}`);
      if (f.patch) content = f.patch(content);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
      downloaded++;
    }
    const hash = sha256(content);
    if (lock[f.to] && lock[f.to].sha256 !== hash) {
      throw new Error(`Hash mismatch for ${f.to}: expected ${lock[f.to].sha256}, got ${hash}`);
    }
    newLock[f.to] = { source: `${f.pkg}/${f.from}`, sha256: hash };
  }
  fs.writeFileSync(lockPath, JSON.stringify(newLock, null, 2) + '\n');
  console.log(`vendor: ${all.length} files ok (${downloaded} downloaded)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
