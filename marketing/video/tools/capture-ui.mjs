// Captures the real Pocket Pilot phone UI for the marketing videos: the demo app is driven through its
// states in headless Edge/Chrome and each screen's live DOM is saved, so the videos show the actual
// app (sharp at any zoom), styled by the app's own CSS scoped under `.pp-app`.
//   node marketing/video/tools/capture-ui.mjs
// Writes marketing/video/assets/ui/fragments.js (window.PP_UI) and assets/ui/app.scoped.css.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage, sleep } from '../../../scripts/lib/headless.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = path.join(repo, 'marketing', 'video', 'assets', 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

// ------------------------------------------------------------------ CSS scoping

/** Splits a CSS text into top-level blocks: { prelude, body } (body null for `@import x;`-style statements). */
function blocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    if (open === -1) break;
    if (semi !== -1 && semi < open && !css.slice(i, semi).includes('{')) {
      out.push({ prelude: css.slice(i, semi).trim(), body: null });
      i = semi + 1;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    out.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j) });
    i = j + 1;
  }
  return out;
}

function splitSelectors(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function scopeSelector(sel) {
  if (/data-theme/.test(sel)) return null;
  if (sel === ':root' || sel === 'html' || sel === 'body') return '.pp-app';
  return `.pp-app ${sel.replace(/^(html|body|:root)\s+/, '')}`;
}

/** Scopes the app's CSS under `.pp-app`: dark theme, phone layout, no desktop or reduced-motion rules. */
export function scopeCss(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const b of blocks(css)) {
    if (b.body === null) continue;
    if (b.prelude.startsWith('@keyframes')) {
      out.push(`${b.prelude} {${b.body}}`);
      continue;
    }
    if (b.prelude.startsWith('@media')) {
      const cond = b.prelude.slice(6).trim();
      if (/max-width:\s*4\d\dpx/.test(cond)) out.push(scopeCss(b.body)); // the phone rules, always on
      continue; // light theme, desktop widths, reduced motion
    }
    if (b.prelude.startsWith('@')) continue;
    const sels = splitSelectors(b.prelude).map(scopeSelector).filter(Boolean);
    if (sels.length) out.push(`${[...new Set(sels)].join(', ')} {${b.body}}`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ server + browser

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(repo, decodeURIComponent(url.pathname));
    if (!file.startsWith(repo)) return void res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Like the product screenshots: iPhone safe areas, no demo banner.
const PHONE = `(() => {
  document.documentElement.style.setProperty('--safe-top', '47px');
  document.documentElement.style.setProperty('--safe-bottom', '30px');
  document.querySelector('.demo-banner')?.remove();
  document.querySelector('.shell')?.classList.remove('has-banner');
  return true;
})()`;

// The screen as a fragment: blob: pictures inlined, asset paths pointing at the video's assets.
const EXTRACT = `(async () => {
  document.querySelector('.demo-banner')?.remove();
  const shell = document.querySelector('.shell');
  shell.classList.remove('has-banner');
  for (const t of shell.querySelectorAll('.toast')) t.remove();
  for (const img of shell.querySelectorAll('img[src^="blob:"]')) {
    // The app's CSP has no blob: in connect-src, so no fetch(): draw the loaded picture instead.
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 400;
    c.height = img.naturalHeight || 400;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    img.setAttribute('src', c.toDataURL('image/png'));
  }
  for (const ta of shell.querySelectorAll('textarea')) ta.textContent = ta.value;
  for (const input of shell.querySelectorAll('input')) if (input.value) input.setAttribute('value', input.value);
  return shell.outerHTML;
})()`;

const click = (selector, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)}) || (e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('not found: ' + ${JSON.stringify(`${selector} ${text || ''}`)}); el.click(); return true; })()`;

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, close } = await launchBrowser();
  const shots = {};
  try {
    const page = await newPage(cdp, { width: 390, height: 844, dpr: 2 });
    const open = async (hash = '', wait = '.srow, .composer') => {
      // A fresh app for every state: a hash change alone would keep sheets and demo progress.
      await page.goto('about:blank');
      await page.goto(`${base}/pwa/?demo${hash}`);
      await page.waitFor(`document.querySelector(${JSON.stringify(wait)})`);
      await page.eval(PHONE);
      await sleep(900);
    };
    const save = async (name) => {
      await sleep(250);
      shots[name] = await page.eval(EXTRACT);
      console.log(`  ${name.padEnd(12)} ${(shots[name].length / 1024).toFixed(0)} KB`);
    };
    const chat = (id) => `#/s/${encodeURIComponent(`copilotcli:/${id}`)}`;

    await open();
    await save('home');
    await page.eval(click('.gtabs button', 'Folders'));
    await sleep(600);
    await save('folders');

    await open();
    await page.eval(click('.newbar'));
    await page.waitFor('document.querySelector(".sheet textarea")');
    await page.eval(`(() => { const ta = document.querySelector('.sheet textarea'); ta.value = 'Add a dark mode toggle to the settings page'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    await save('newSession');

    await open(chat('demo-auth'), '.confirm');
    await save('approval');
    await page.eval(click('.composer .pick', 'Model'));
    await page.waitFor('document.querySelector(".sheet .list-item")');
    await sleep(600);
    await save('models');
    await open(chat('demo-auth'), '.confirm');
    await page.eval(click('.confirm button', 'Allow Once'));
    await page.waitFor('document.querySelector(".chat").textContent.includes("open a pull request") && !document.querySelector(".activity-line")', 30000);
    await sleep(600);
    await save('approved');

    await open(chat('demo-dates'), '.composer');
    await page.waitFor('document.querySelector(".confirm")');
    await save('question');

    await open(chat('demo-flaky'), '.composer');
    await save('history');

    await open(chat('demo-dark'), '.composer');
    await page.waitFor('document.querySelector(".thumb.ready img")');
    await save('picture');
    await page.eval(click('.thumb'));
    await page.waitFor('document.querySelector(".viewer img")');
    await sleep(700);
    await save('viewer');

    await open(chat('demo-dark'), '.composer');
    await page.eval(`(() => { const ta = document.querySelector('.composer textarea'); ta.value = 'Also make the toggle remember the system theme'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
    await page.eval(click('.composer .send'));
    await page.waitFor('document.querySelector(".pending-item")', 5000).catch(() => {});
    await save('steer');

    // First run: the welcome screen with "Scan the QR code".
    await page.goto(`${base}/pwa/`);
    await page.waitFor('document.querySelector(".hero")');
    await page.eval(PHONE);
    await sleep(800);
    await save('welcome');
    await page.close();
  } finally {
    await close();
    server.close();
  }

  fs.mkdirSync(outDir, { recursive: true });
  const rewrite = (html) => html.replaceAll('src="./icons/', 'src="assets/img/').replaceAll("src='./icons/", "src='assets/img/");
  const body = Object.entries(shots).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(rewrite(v))},`).join('\n');
  fs.writeFileSync(path.join(outDir, 'fragments.js'), `// Generated by tools/capture-ui.mjs from the Pocket Pilot demo app. Do not edit.\nwindow.PP_UI = {\n${body}\n};\n`);
  fs.writeFileSync(path.join(outDir, 'app.scoped.css'), `/* Generated by tools/capture-ui.mjs from pwa/css/app.css. Do not edit. */\n${scopeCss(fs.readFileSync(path.join(repo, 'pwa', 'css', 'app.css'), 'utf8'))}\n`);
  for (const icon of ['icon.svg', 'bot.svg']) fs.copyFileSync(path.join(repo, 'pwa', 'icons', icon), path.join(repo, 'marketing', 'video', 'assets', 'img', icon));
  console.log(`Wrote ${Object.keys(shots).length} screens to ${path.relative(repo, outDir)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
