// Shows each captured screen the way the videos show it (inside the video kit's iPhone, with kit.css)
// next to the real app in the same state (renders/ui-real/<name>.png, written by capture-ui.mjs).
// They must look the same, apart from the phone's status bar drawn over the top.
//   node marketing/video/tools/check-ui.mjs [screen ...]   -> marketing/video/renders/ui-check.png (git-ignored)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage, sleep } from '../../../scripts/lib/headless.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = ['home', 'approval', 'approved', 'question', 'models', 'history', 'newSession', 'picture', 'steer', 'viewer', 'welcome'];
const screens = process.argv.slice(2).length ? process.argv.slice(2) : all;
const W = 426 + 16 + 390 + 40;
const COLS = Math.min(3, screens.length);
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/assets/ui/app.scoped.css"><link rel="stylesheet" href="/assets/lib/kit.css">
<style>html,body{margin:0;background:#111;overflow:visible}body{display:grid;grid-template-columns:repeat(${COLS},${W}px);gap:30px 0;padding:24px;width:${COLS * W + 48}px}
.pair{display:flex;gap:16px;align-items:flex-start}.pair>.label{position:absolute;margin:-22px 0 0;font:600 15px/1 sans-serif;color:#9da5b4}
.dev{position:relative;width:426px;height:880px}.real{width:390px;height:844px;margin-top:18px;border-radius:52px;display:block}</style>
<script src="/assets/ui/fragments.js"></script><script src="/assets/lib/kit.js"></script></head><body>
${screens.map((s, i) => `<div class="pair"><div class="label">${s} — video (left) · real app (right)</div><div class="dev" id="d${i}"></div><img class="real" src="/renders/ui-real/${s}.png"></div>`).join('')}
<script>
${JSON.stringify(screens)}.forEach((s, i) => { document.getElementById('d' + i).innerHTML = PP.phone({ id: 'p' + i, screen: s }); });
for (const sc of document.querySelectorAll('.pp-app .scroll')) sc.scrollTop = sc.querySelector('.chat') ? sc.scrollHeight : 0;
</script></body></html>`;

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  const file = path.join(root, decodeURIComponent(url.pathname));
  fs.readFile(file, (err, data) => (err ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { cdp, close } = await launchBrowser();
try {
  const rows = Math.ceil(screens.length / COLS);
  const page = await newPage(cdp, { width: COLS * W + 48, height: rows * 910 + 48, dpr: 1, mobile: false });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await sleep(1200);
  fs.mkdirSync(path.join(root, 'renders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'renders', 'ui-check.png'), await page.capture());
  console.log('wrote renders/ui-check.png');
} finally {
  await close();
  server.close();
}
