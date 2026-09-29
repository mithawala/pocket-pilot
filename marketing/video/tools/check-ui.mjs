// Renders captured screens with the scoped app CSS next to each other, to check them against the app.
//   node marketing/video/tools/check-ui.mjs [screen ...]   -> marketing/video/renders/ui-check.png (git-ignored)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage, sleep } from '../../../scripts/lib/headless.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screens = process.argv.slice(2).length ? process.argv.slice(2) : ['home', 'approval', 'approved', 'question', 'models', 'newSession', 'picture', 'viewer'];
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/assets/ui/app.scoped.css"><link rel="stylesheet" href="/assets/lib/kit.css">
<style>body{margin:0;background:#111;display:flex;flex-wrap:wrap;gap:24px;padding:24px;width:${screens.length * 414 + 24}px}
.cell{position:relative;width:390px;height:844px;overflow:hidden;border-radius:12px}</style>
<script src="/assets/ui/fragments.js"></script></head><body>
${screens.map((s) => `<div class="cell"><div class="pp-app" data-screen="${s}"></div></div>`).join('')}
<script>for (const el of document.querySelectorAll('[data-screen]')) el.innerHTML = window.PP_UI[el.dataset.screen];</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  const file = path.join(root, decodeURIComponent(url.pathname));
  fs.readFile(file, (err, data) => {
    if (err) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { cdp, close } = await launchBrowser();
try {
  const page = await newPage(cdp, { width: screens.length * 414 + 24, height: 892, dpr: 1, mobile: false });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await sleep(800);
  fs.mkdirSync(path.join(root, 'renders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'renders', 'ui-check.png'), await page.capture());
  console.log('wrote renders/ui-check.png');
} finally {
  await close();
  server.close();
}
