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
fs.copyFileSync(path.join(repo, 'THIRD-PARTY-NOTICES.md'), path.join(out, 'THIRD-PARTY-NOTICES.md'));
for (const page of ['index.html', '404.html']) {
  const p = path.join(out, page);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('%VERSION%', version));
}
fs.writeFileSync(path.join(out, 'img', 'app-qr.svg'), qrSvg(`${SITE_URL}app/`));

// Browsers keep favicons for a long time: version the icon links by content so a new icon shows up.
function versionIcons(file) {
  if (!fs.existsSync(file)) return;
  const html = fs.readFileSync(file, 'utf8').replace(/href="(\.\/[^"?]*?(?:icon\.svg|favicon\.png|apple-touch-icon\.png))"/g, (m, url) => {
    const src = path.join(path.dirname(file), url);
    if (!fs.existsSync(src)) return m;
    return `href="${url}?v=${crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 8)}"`;
  });
  fs.writeFileSync(file, html);
}
for (const f of ['index.html', '404.html', 'app/index.html']) versionIcons(path.join(out, f));

// Content-based release name: every release changes sw.js, so installed apps update themselves, and boot.js
// (loaded fresh from index.html) checks that the service worker serves this release before the app starts.
const appDir = path.join(out, 'app');
const hash = crypto.createHash('sha256');
for (const rel of listFiles(appDir).sort()) hash.update(rel).update(fs.readFileSync(path.join(appDir, rel)));
const cacheVersion = `pp-${hash.digest('hex').slice(0, 12)}`;
const stamp = (rel, marker, value) => {
  const p = path.join(appDir, rel);
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes(marker)) throw new Error(`${rel}: marker ${marker} not found`);
  fs.writeFileSync(p, src.replace(marker, value));
};
stamp('sw.js', "const VERSION = 'pp-v1';", `const VERSION = '${cacheVersion}';`);
// The service worker installs every file of the release before it serves any (see installRelease in sw.js).
const releaseFiles = listFiles(appDir).filter((rel) => rel !== 'sw.js').sort().map((rel) => `./${rel.split(path.sep).join('/')}`);
stamp('sw.js', 'const FILES = [];', `const FILES = ${JSON.stringify(releaseFiles)};`);
stamp('js/boot.js', "const BUILD = 'pp-v1';", `const BUILD = '${cacheVersion}';`);
stamp('index.html', 'src="./js/boot.js"', `src="./js/boot.js?v=${cacheVersion}"`);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`Built ${listFiles(out).length} files into ${out} (v${version}, app cache ${cacheVersion})`);
