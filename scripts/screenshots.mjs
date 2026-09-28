// Regenerates the landing-page images in site/img/ — phone screenshots from the demo app (app/?demo),
// the real VS Code sidebar webview (media/sidebar.*) with One Dark colours, the social preview
// card and the README images in docs/images/ — using headless Edge/Chrome (scripts/lib/headless.mjs).
// Usage: node scripts/screenshots.mjs        (set PP_BROWSER to use a specific Chromium binary)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage, sleep } from './lib/headless.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'site', 'img');
const require = createRequire(import.meta.url);
const qrcode = require('../media/vendor/qrcode.js');
const DEMO_LINK = 'https://mithawala.github.io/pocket-pilot/app/?demo';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

function renderQrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 3} ${r + 3}h1v1h-1z`;
  const size = n + 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// VS Code "One Dark Pro" (Atom One Dark) colours for the variables the sidebar uses.
const VSCODE_DARK = `
:root { --vscode-foreground: #abb2bf; --vscode-font-family: "Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif; --vscode-font-size: 13px;
  --vscode-widget-border: #3e4452; --vscode-sideBarSectionHeader-background: #282c34; --vscode-badge-background: #4d78cc; --vscode-badge-foreground: #ffffff;
  --vscode-editorWarning-foreground: #e5c07b; --vscode-errorForeground: #e06c75; --vscode-button-background: #4d78cc; --vscode-button-foreground: #fff;
  --vscode-button-hoverBackground: #5a86dd; --vscode-button-secondaryBackground: #3a3f4b; --vscode-button-secondaryForeground: #d7dae0;
  --vscode-button-secondaryHoverBackground: #454b58; --vscode-textLink-foreground: #61afef; --vscode-toolbar-hoverBackground: rgba(90,93,94,.31);
  --vscode-editor-font-family: Consolas, "Courier New", monospace; }
html, body { background: #21252b; }`;

function sidebarHarness() {
  const state = {
    state: 'running',
    error: null,
    standby: null,
    hostName: 'Studio PC',
    fingerprint: '7F3A-9C21-44DE-B08E',
    tunnel: { mode: 'quick', state: 'ready', url: 'https://quiet-meadow-lantern.trycloudflare.com', reachable: true },
    agentHost: { connected: true, found: true, counts: { total: 5, running: 1, inputNeeded: 1 } },
    rendezvous: { enabled: true, status: 'ready' },
    pairing: { link: DEMO_LINK, svg: renderQrSvg(DEMO_LINK), expiresAt: Date.now() + 9 * 60000 + 41000 },
    devices: [],
    settings: { passkey: 'required', requireApproval: true, pwaUrl: 'https://mithawala.github.io/pocket-pilot/app/', pwaFallback: false },
  };
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/media/sidebar.css"><style>${VSCODE_DARK}</style>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script></head>
<body><div id="root" data-logo="/media/logo.svg"></div><script src="/media/sidebar.js"></script>
<script>window.postMessage({ type: 'state', now: Date.now(), state: ${JSON.stringify(state).replace(/</g, '\\u003c')} }, '*');</script></body></html>`;
}

function ogHarness() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1200px; height: 630px; overflow: hidden; font-family: "Segoe UI", -apple-system, sans-serif; color: #fff;
    background: radial-gradient(900px 500px at 85% 20%, rgba(79,120,255,.35), transparent 60%), radial-gradient(700px 500px at 10% 100%, rgba(109,93,252,.35), transparent 60%), #0a0c11;
    display: flex; align-items: center; padding: 0 70px 0 84px; gap: 40px; }
  .copy { flex: 1; }
  .logo { width: 92px; height: 92px; border-radius: 22px; box-shadow: 0 18px 50px rgba(79,120,255,.45); }
  h1 { font-size: 78px; line-height: 1; margin: 30px 0 14px; letter-spacing: -2px; font-weight: 800; }
  p { font-size: 32px; margin: 0 0 34px; color: #c6ccda; }
  .chips { display: flex; gap: 12px; flex-wrap: wrap; }
  .chips span { font-size: 21px; padding: 9px 18px; border-radius: 99px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14); }
  .phone { width: 300px; height: 620px; margin-top: 150px; border-radius: 46px; padding: 11px; background: linear-gradient(160deg, #3a3f4d, #15181f); box-shadow: 0 40px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08) inset; transform: rotate(-4deg); }
  .phone img { width: 100%; height: 100%; object-fit: cover; object-position: top; border-radius: 36px; display: block; }
  </style></head><body>
  <div class="copy"><img class="logo" src="/pwa/icons/icon.svg" alt="">
  <h1>Pocket Pilot</h1><p>Your VS Code agents, in your pocket.</p>
  <div class="chips"><span>🔒 End-to-end encrypted</span><span>🪪 Passkeys</span><span>💸 Free</span></div></div>
  <div class="phone"><img src="/site/img/sessions.webp" alt=""></div></body></html>`;
}

function readmeHarness() {
  const phone = (img, lift = 0) => `<div class="phone" style="transform:translateY(${lift}px)"><div class="screen"><div class="status"><span>9:41</span><i class="island"></i><span class="bars"></span></div><img src="/site/img/${img}" alt=""></div></div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1280px; height: 700px; overflow: hidden; display: flex; align-items: center; justify-content: center; gap: 56px;
    background: radial-gradient(700px 420px at 50% 0%, rgba(82,139,255,.28), transparent 70%), radial-gradient(600px 400px at 10% 100%, rgba(198,120,221,.22), transparent 70%), #16181d; font-family: "Segoe UI", sans-serif; }
  .phone { width: 280px; padding: 10px; border-radius: 46px; background: linear-gradient(155deg, #3b404e, #1a1d25 45%, #0f1116); box-shadow: 0 40px 80px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.08); }
  .screen { position: relative; overflow: hidden; border-radius: 37px; background: #282c34; container-type: inline-size; }
  .screen img { display: block; width: 100%; height: auto; }
  .status { position: absolute; top: 0; left: 0; right: 0; height: 12cqw; display: flex; align-items: center; justify-content: space-between; padding: 0 7.4cqw 0 8.8cqw; font-size: 3.9cqw; font-weight: 600; color: #fff; }
  .island { position: absolute; left: 50%; top: 2.8cqw; width: 29cqw; height: 8.4cqw; margin-left: -14.5cqw; border-radius: 99px; background: #000; }
  .bars { position: relative; width: 7cqw; height: 3.4cqw; border: .45cqw solid rgba(255,255,255,.9); border-radius: 1.1cqw; }
  .screen::after { content: ''; position: absolute; left: 50%; bottom: 2cqw; width: 34cqw; height: 1.3cqw; margin-left: -17cqw; border-radius: 99px; background: rgba(255,255,255,.78); }
  </style></head><body>${phone('sessions.webp', 20)}${phone('approval.webp', -20)}${phone('chat.webp', 20)}</body></html>`;
}

/** The Copilot app plugin's pairing page as a panel (canvas), with sample state. */
async function copilotPanelHarness() {
  const { pairingPage } = await import('../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib/pairing-page.mjs');
  return pairingPage({ key: 'demo', hostName: 'Studio PC', embed: true }).replace('https://mithawala.github.io/pocket-pilot/app/icons/icon-192.png', '/pwa/icons/icon-192.png');
}
const copilotPanelState = () => ({
  hostName: 'Studio PC',
  tunnel: { url: 'https://quiet-meadow-lantern.trycloudflare.com', reachable: true, mode: 'quick' },
  sessions: 3,
  rendezvous: true,
  pairing: { link: DEMO_LINK, svg: renderQrSvg(DEMO_LINK), expiresAt: Date.now() + 9 * 60000 + 41000 },
  approvals: [],
  devices: [{ id: 'd1', name: 'iPhone', platform: 'iPhone · Safari', online: true, passkey: true }],
});

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const harness = { '/__sidebar.html': sidebarHarness, '/__og.html': ogHarness, '/__readme.html': readmeHarness, '/__copilot-panel.html': copilotPanelHarness }[url.pathname];
    if (harness) {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(await harness());
      return;
    }
    if (url.pathname === '/pair/state') {
      res.writeHead(200, { 'content-type': TYPES['.json'] });
      res.end(JSON.stringify(copilotPanelState()));
      return;
    }
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

/** Opens a page whose `shot(name, { format, clip, dir })` writes the capture into the repo and logs it. */
async function open(cdp, opts) {
  const page = await newPage(cdp, opts);
  page.shot = async (name, { format = 'webp', clip, dir = outDir } = {}) => {
    const buf = await page.capture({ format, clip });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    console.log(`  ${path.relative(repo, path.join(dir, name)).split(path.sep).join('/')}  ${(buf.length / 1024).toFixed(0)} KB`);
  };
  return page;
}

// Phone shots: iPhone-like safe areas (status bar / home indicator) so the product page can frame
// them uncropped, and without the demo banner.
const PHONE_CHROME = `document.head.insertAdjacentHTML('beforeend', '<style>:root{--safe-top:47px!important;--safe-bottom:30px!important}.demo-banner{display:none!important}.shell.has-banner .topbar{padding-top:calc(var(--safe-top) + 4px)!important}</style>')`;
const click = (selector, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('not found: ' + ${JSON.stringify(`${selector} ${text || ''}`)}); el.click(); return true; })()`;

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, close } = await launchBrowser();
  try {
    console.log('Capturing phone screens…');
    const phone = await open(cdp, { width: 390, height: 844 });
    const demo = async (hash = '') => {
      await phone.goto(`${base}/pwa/?demo${hash}`);
      await phone.waitFor('document.querySelector(".srow, .composer")');
      await phone.eval(PHONE_CHROME);
      await sleep(1100);
    };
    await demo();
    await phone.shot('sessions.webp');
    await phone.eval(click('.gtabs button', 'Folders'));
    await sleep(700);
    await phone.shot('folders.webp');
    await phone.eval(click('.gtabs button', 'Recent'));
    await sleep(300);
    await demo(`#/s/${encodeURIComponent('copilotcli:/demo-auth')}`);
    await phone.shot('approval.webp');
    await phone.eval(click('.composer .pick.opts'));
    await sleep(800);
    await phone.shot('models.webp');
    await demo(`#/s/${encodeURIComponent('copilotcli:/demo-flaky')}`);
    await phone.shot('chat.webp');
    await demo();
    await phone.eval(click('.newbar'));
    await sleep(800);
    await phone.shot('new-session.webp');
    await phone.goto(`${base}/pwa/`);
    await phone.waitFor('document.querySelector(".hero")');
    await phone.eval(PHONE_CHROME);
    await sleep(1000);
    await phone.shot('pair.webp');
    await phone.close();

    console.log('Capturing the VS Code sidebar…');
    const side = await open(cdp, { width: 330, height: 900, mobile: false });
    await side.goto(`${base}/__sidebar.html`);
    await side.waitFor('document.querySelector(".qr svg")');
    await sleep(500);
    const h = await side.eval('Math.ceil(document.documentElement.scrollHeight)');
    await side.shot('sidebar.webp', { clip: { x: 0, y: 0, width: 330, height: h } });
    await side.close();

    console.log('Capturing the GitHub Copilot app panel…');
    const panel = await open(cdp, { width: 340, height: 900, mobile: false });
    await panel.goto(`${base}/__copilot-panel.html`);
    await panel.waitFor('document.querySelector("#qr svg") && [...document.images].every((i) => i.complete && i.naturalWidth > 0)');
    await sleep(400);
    const ph = await panel.eval('Math.ceil(document.querySelector(".card").getBoundingClientRect().bottom + 8)');
    await panel.shot('copilot-panel.webp', { clip: { x: 0, y: 0, width: 340, height: ph } });
    await panel.close();

    console.log('Rendering the social preview…');
    const og = await open(cdp, { width: 1200, height: 630, dpr: 1, mobile: false });
    await og.goto(`${base}/__og.html`);
    await og.waitFor('[...document.images].every((i) => i.complete && i.naturalWidth > 0)');
    await sleep(300);
    await og.shot('og.png', { format: 'png' });
    await og.close();

    console.log('Rendering README images…');
    const docs = path.join(repo, 'docs', 'images');
    const banner = await open(cdp, { width: 1280, height: 700, dpr: 1, mobile: false });
    await banner.goto(`${base}/__readme.html`);
    await banner.waitFor('[...document.images].every((i) => i.complete && i.naturalWidth > 0)');
    await sleep(300);
    await banner.shot('screens.jpg', { format: 'jpeg', dir: docs });
    await banner.close();
    const how = await open(cdp, { width: 1200, height: 900, dpr: 1, mobile: false });
    await how.reducedMotion();
    await how.goto(`${base}/site/index.html`);
    await how.waitFor('document.querySelector("#how .diagram")');
    await sleep(500);
    const box = await how.eval('(() => { const r = document.querySelector("#how .diagram").getBoundingClientRect(); return { x: Math.max(0, r.left - 28), y: r.top + scrollY - 28, width: r.width + 56, height: r.height + 56 }; })()');
    await how.shot('how-it-works.png', { format: 'png', dir: docs, clip: box });
    await how.close();
  } finally {
    await close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
