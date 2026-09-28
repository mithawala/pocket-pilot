// Minimal headless Edge/Chrome driver over the DevTools protocol (no dependencies).
// Used by scripts/screenshots.mjs (product images) and scripts/make-icons.mjs (icon rasters).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
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

export async function launchBrowser() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-headless-'));
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

/** Opens a tab with a fixed viewport. `transparent` renders pages without a default white background. */
export async function newPage(cdp, { width, height, dpr = 2, mobile = true, transparent = false }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
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
    /** Replaces the page with the given HTML (no server needed). */
    async setContent(html) {
      const { frameTree } = await send('Page.getFrameTree');
      await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
      await sleep(50);
    },
    /** Screenshot as a Buffer (png, jpeg or webp). */
    async capture({ format = 'png', quality = 88, clip } = {}) {
      const r = await send('Page.captureScreenshot', { format, ...(format === 'png' ? {} : { quality }), ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
      return Buffer.from(r.data, 'base64');
    },
    reducedMotion: () => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }),
    close: () => cdp.send('Target.closeTarget', { targetId }),
  };
  return page;
}
