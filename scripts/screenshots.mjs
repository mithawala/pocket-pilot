// Regenerates the landing-page images in site/img/ — phone screenshots from the demo app (app/?demo),
// the real VS Code sidebar webview (media/sidebar.*) with a Dark Modern theme, and the social
// preview card — using headless Edge/Chrome over the DevTools protocol (no dependencies).
// Usage: node scripts/screenshots.mjs        (set PP_BROWSER to use a specific Chromium binary)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'site', 'img');
const require = createRequire(import.meta.url);
const qrcode = require('../media/vendor/qrcode.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__sidebar.html' || url.pathname === '/__og.html') {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(url.pathname === '/__og.html' ? ogHarness() : sidebarHarness());
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

function findBrowser() {
  const candidates = [
    process.env.PP_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  const bin = candidates.find((p) => fs.existsSync(p));
  if (!bin) throw new Error('No Edge/Chrome found; set PP_BROWSER');
  return bin;
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('DevTools connection failed'));
    });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
}

async function launchBrowser() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shots-'));
  const proc = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dataDir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-extensions', '--mute-audio', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dataDir, 'DevToolsActivePort');
  let lines = [];
  for (let i = 0; i < 150 && lines.length < 2; i++) {
    await sleep(100);
    if (fs.existsSync(portFile)) lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  }
  if (lines.length < 2) throw new Error('Browser did not start');
  const cdp = new Cdp(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await cdp.open();
  const close = async () => {
    await cdp.send('Browser.close').catch(() => {});
    await sleep(500);
    proc.kill();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { cdp, close };
}

async function newPage(cdp, { width, height, dpr = 2, mobile = true }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const page = {
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expression, timeout = 15000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await page.eval(`!!(${expression})`).catch(() => false)) return;
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${expression}`);
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(300);
      await page.waitFor('document.readyState === "complete"');
    },
    async shot(name, { format = 'webp', clip } = {}) {
      const r = await send('Page.captureScreenshot', { format, ...(format === 'png' ? {} : { quality: 88 }), ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
      const buf = Buffer.from(r.data, 'base64');
      fs.writeFileSync(path.join(outDir, name), buf);
      console.log(`  ${name}  ${(buf.length / 1024).toFixed(0)} KB`);
    },
    close: () => cdp.send('Target.closeTarget', { targetId }),
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
    const phone = await newPage(cdp, { width: 390, height: 844 });
    const demo = async (hash = '') => {
      await phone.goto(`${base}/pwa/?demo${hash}`);
      await phone.waitFor('document.querySelector(".srow, .composer")');
      await phone.eval(PHONE_CHROME);
      await sleep(1100);
    };
    await demo();
    await phone.shot('sessions.webp');
    await demo(`#/s/${encodeURIComponent('copilotcli:/demo-auth')}`);
    await phone.shot('approval.webp');
    await phone.eval(click('.composer .pick', 'Claude Opus 5.5'));
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
    const side = await newPage(cdp, { width: 330, height: 900, mobile: false });
    await side.goto(`${base}/__sidebar.html`);
    await side.waitFor('document.querySelector(".qr svg")');
    await sleep(500);
    const h = await side.eval('Math.ceil(document.documentElement.scrollHeight)');
    await side.shot('sidebar.webp', { clip: { x: 0, y: 0, width: 330, height: h } });
    await side.close();

    console.log('Rendering the social preview…');
    const og = await newPage(cdp, { width: 1200, height: 630, dpr: 1, mobile: false });
    await og.goto(`${base}/__og.html`);
    await og.waitFor('[...document.images].every((i) => i.complete && i.naturalWidth > 0)');
    await sleep(300);
    await og.shot('og.png', { format: 'png' });
    await og.close();
  } finally {
    await close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
