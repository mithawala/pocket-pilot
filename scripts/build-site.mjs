// Assemble the GitHub Pages site: landing page (site/) at the root, phone app (pwa/) under /app/.
// Usage: node scripts/build-site.mjs [outDir=dist/site]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(repo, 'dist', 'site'));
const APP_SKIP = new Set(['package.json', '.nojekyll']);
// Public URL of the site (the QR code on the page opens <site>/app/). Override for forks.
const SITE_URL = (process.env.PP_SITE_URL || 'https://mithawala.github.io/pocket-pilot/').replace(/\/?$/, '/');
const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const qrcode = createRequire(import.meta.url)('../media/vendor/qrcode.js');

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#0a0c11"/></svg>`;
}

function listFiles(dir, base = dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...listFiles(p, base));
    else files.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return files;
}

function copyTree(from, to, keep = () => true) {
  for (const rel of listFiles(from)) {
    if (!keep(rel)) continue;
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copyTree(path.join(repo, 'site'), out);
copyTree(path.join(repo, 'pwa'), path.join(out, 'app'), (rel) => !APP_SKIP.has(rel));
for (const page of ['index.html', '404.html']) {
  const p = path.join(out, page);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('%VERSION%', version));
}
fs.writeFileSync(path.join(out, 'img', 'app-qr.svg'), qrSvg(`${SITE_URL}app/`));

// Content-based cache version: every release changes sw.js, so installed apps update themselves.
const appDir = path.join(out, 'app');
const hash = crypto.createHash('sha256');
for (const rel of listFiles(appDir).sort()) hash.update(rel).update(fs.readFileSync(path.join(appDir, rel)));
const swPath = path.join(appDir, 'sw.js');
const marker = "const VERSION = 'pp-v1';";
const sw = fs.readFileSync(swPath, 'utf8');
if (!sw.includes(marker)) throw new Error('sw.js VERSION marker not found');
const cacheVersion = `pp-${hash.digest('hex').slice(0, 12)}`;
fs.writeFileSync(swPath, sw.replace(marker, `const VERSION = '${cacheVersion}';`));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`Built ${listFiles(out).length} files into ${out} (v${version}, app cache ${cacheVersion})`);
