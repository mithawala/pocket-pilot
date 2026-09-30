// Checks that the app screens inside the videos are the app, untouched: no rule from the videos' own
// CSS (kit.css, a composition's <style>) may match an element inside `.pp-app` unless it says so
// (its selector names .pp-app), and no screen may mention a product the videos leave out.
//   node marketing/video/tools/check-screens.mjs          (every composition and every scene of D)
// Exits 1 on any finding. Needs Edge or Chrome (PP_BROWSER).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage, sleep } from '../../../scripts/lib/headless.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = /Claude/;
const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.wav': 'audio/wav' };

// A page that mounts one sub-composition the way HyperFrames does: its template's nodes, scripts run.
const HOST = (scene) => `<!doctype html><html><head><meta charset="utf-8">
<script>window.__timelines = {};</script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<link rel="stylesheet" href="/assets/ui/app.scoped.css"><link rel="stylesheet" href="/assets/lib/kit.css">
<script src="/assets/ui/fragments.js"></script><script src="/assets/lib/kit.js"></script>
<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#000}#root{position:relative;width:1920px;height:1080px}</style>
</head><body><div id="root"></div><script>
fetch(${JSON.stringify(`/${scene}`)}).then((r) => r.text()).then((html) => {
  const tpl = new DOMParser().parseFromString(html, 'text/html').querySelector('template');
  for (const node of [...tpl.content.childNodes]) {
    if (node.nodeName === 'SCRIPT') { const s = document.createElement('script'); s.textContent = node.textContent; document.getElementById('root').appendChild(s); }
    else document.getElementById('root').appendChild(document.importNode(node, true));
  }
});
</script></body></html>`;

const CHECK = `(() => {
  const findings = [];
  const inApp = (el) => !!el.closest('.pp-app');
  for (const sheet of document.styleSheets) {
    const file = sheet.href ? sheet.href.split('/').pop() : 'inline <style>';
    if (file === 'app.scoped.css') continue;
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!rule.selectorText) continue;
      for (const part of rule.selectorText.split(',').map((s) => s.trim())) {
        if (part.includes('.pp-app')) continue; // meant for the app
        let hits;
        try { hits = [...document.querySelectorAll(part)].filter(inApp); } catch { continue; }
        if (hits.length) findings.push(file + ' :: ' + part + ' -> ' + hits.length + ' app element(s), e.g. ' + hits[0].tagName.toLowerCase() + (hits[0].className && typeof hits[0].className === 'string' ? '.' + hits[0].className.trim().split(/\\s+/).join('.') : ''));
      }
    }
  }
  const text = document.getElementById('root')?.textContent || '';
  const m = text.match(${FORBIDDEN});
  if (m) findings.push('text mentions "' + m[0] + '": …' + text.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\\s+/g, ' ') + '…');
  for (const el of document.querySelectorAll('#root [aria-label], #root [title], #root [alt]')) {
    for (const a of ['aria-label', 'title', 'alt']) if (${FORBIDDEN}.test(el.getAttribute(a) || '')) findings.push(a + ' mentions it: ' + el.getAttribute(a));
  }
  return findings;
})()`;

const targets = [
  ...['walk-away', 'kinetic', 'in-sync'].map((n) => ({ name: n, file: `compositions/${n}.html`, id: n })),
  ...fs.readdirSync(path.join(root, 'compositions', 'kinetic-sync')).filter((f) => f.endsWith('.html')).map((f) => ({ name: `kinetic-sync/${f}`, scene: `compositions/kinetic-sync/${f}`, id: `ks-${f.replace('.html', '')}` })),
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const t = targets.find((x) => url.pathname === `/_host/${x.name}`);
  if (t) return void res.writeHead(200, { 'content-type': 'text/html' }).end(HOST(t.scene));
  if (url.pathname.startsWith('/_page_')) {
    // Served from the root like HyperFrames does, so the compositions' assets/ paths resolve.
    const html = fs.readFileSync(path.join(root, 'compositions', decodeURIComponent(url.pathname.slice(7))), 'utf8').replace('<head>', '<head><script>window.__timelines = {};</script>');
    return void res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  fs.readFile(file, (err, data) => (err ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const { cdp, close } = await launchBrowser();
let total = 0;
try {
  for (const t of targets) {
    const page = await newPage(cdp, { width: 1920, height: 1080, dpr: 1, mobile: false });
    await page.goto(t.scene ? `${base}/_host/${t.name}` : `${base}/_page_${t.id}.html`);
    await page.waitFor(`window.__timelines && window.__timelines[${JSON.stringify(t.id)}]`, 20000);
    await sleep(300);
    const findings = await page.eval(CHECK);
    total += findings.length;
    console.log(`${findings.length ? '✗' : '✓'} ${t.name}${findings.length ? '' : ': the app screens are untouched'}`);
    for (const f of findings) console.log(`    ${f}`);
    await page.close();
  }
} finally {
  await close();
  server.close();
}
process.exitCode = total ? 1 : 0;
