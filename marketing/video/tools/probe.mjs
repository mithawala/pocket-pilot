// Seeks a composition's timeline in headless Edge/Chrome and captures frames and/or evaluates
// expressions — a fast check between `hyperframes snapshot` runs.
//   node marketing/video/tools/probe.mjs walk-away --at 2.5,6,9.8 [--sheet] [--eval "expr"]
// Frames and the contact sheet go to marketing/video/renders/probe/ (git-ignored).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage, sleep } from '../../../scripts/lib/headless.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args[0];
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const times = (opt('--at') || '0').split(',').map(Number);
const expr = opt('--eval');
const sheet = args.includes('--sheet');
// --verify: renders the given times in three seek orders (forward, backward, shuffled) the way the
// HyperFrames runtime seeks, and reports every element whose state differs — a timeline must not
// depend on the order frames are rendered in.
const verify = args.includes('--verify');
const src = path.join(root, 'compositions', `${name}.html`);
if (!name || !fs.existsSync(src)) {
  console.error('Usage: node tools/probe.mjs <composition> --at t1,t2 [--sheet] [--eval expr]');
  process.exit(1);
}

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    const html = fs.readFileSync(src, 'utf8').replace('<head>', '<head><script>window.__timelines = {};</script>');
    return void res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  fs.readFile(file, (err, data) => {
    if (err) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const out = path.join(root, 'renders', 'probe');
fs.mkdirSync(out, { recursive: true });
const { cdp, close } = await launchBrowser();
const hfSeek = (t) => `(() => { const tl = window.__timelines[${JSON.stringify(name)}]; tl.pause(); tl.totalTime(${t} + 0.001, true); tl.totalTime(${t}, false); for (const a of document.getAnimations()) { a.pause(); a.currentTime = ${t} * 1000; } return 0; })()`;
const SIGNATURE = `(() => {
  const out = {};
  const els = document.querySelectorAll('#root *');
  const round = (s) => s.replace(/-?\\d+\\.\\d+(e-?\\d+)?/g, (n) => String(Math.round(Number(n) * 1000) / 1000));
  els.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const tr = cs.transform === 'matrix(1, 0, 0, 1, 0, 0)' ? 'none' : cs.transform;
    let v = round(cs.opacity + '|' + tr + '|' + cs.visibility);
    for (const a of ['cx', 'cy', 'd']) if (el.hasAttribute(a)) v += '|' + el.getAttribute(a);
    const key = (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '')) + '@' + i;
    out[key] = v;
  });
  return out;
})()`;
async function signatures(order) {
  const page = await newPage(cdp, { width: 1920, height: 1080, dpr: 1, mobile: false });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitFor(`window.__timelines && window.__timelines[${JSON.stringify(name)}]`);
  await page.eval(`(() => { const tl = window.__timelines[${JSON.stringify(name)}]; tl.progress(0.0001, true); tl.totalTime(0, false); return 0; })()`);
  const sig = {};
  for (const t of order) {
    await page.eval(hfSeek(t));
    sig[t] = await page.eval(SIGNATURE);
  }
  await page.close();
  return sig;
}
if (verify) {
  try {
    const rand = (() => { let a = 7; return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648); })();
    const shuffled = [...times].sort(() => rand() - 0.5);
    const runs = { forward: await signatures([...times].sort((a, b) => a - b)), backward: await signatures([...times].sort((a, b) => b - a)), shuffled: await signatures(shuffled) };
    let bad = 0;
    for (const t of times) {
      for (const k of Object.keys(runs.forward[t])) {
        const vals = Object.values(runs).map((r) => r[t][k]);
        if (vals.every((v) => v.startsWith('0|'))) continue; // invisible in every order
        if (new Set(vals).size > 1) {
          bad++;
          if (bad <= 40) console.log(`@${t}s ${k}\n   forward  ${vals[0]}\n   backward ${vals[1]}\n   shuffled ${vals[2]}`);
        }
      }
    }
    console.log(bad ? `${bad} difference(s) across seek orders` : `seek-safe: ${times.length} times x 3 orders agree`);
    process.exitCode = bad ? 1 : 0;
  } finally {
    await close();
    server.close();
  }
  process.exit();
}
try {
  const page = await newPage(cdp, { width: 1920, height: 1080, dpr: 1, mobile: false });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitFor(`window.__timelines && window.__timelines[${JSON.stringify(name)}]`);
  await page.eval(`(() => { const tl = window.__timelines[${JSON.stringify(name)}]; tl.progress(0.0001, true); tl.totalTime(0, false); return 0; })()`);
  await sleep(300);
  const files = [];
  for (const t of times) {
    await page.eval(hfSeek(t));
    await sleep(120);
    if (expr) console.log(`@${t}s`, JSON.stringify(await page.eval(`(() => { const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)]; return (${expr}); })()`)));
    if (!expr || sheet) {
      const file = path.join(out, `${name}-${String(t).replace('.', '_')}.jpg`);
      fs.writeFileSync(file, await page.capture({ format: 'jpeg', quality: 80 }));
      files.push([t, file]);
    }
  }
  if (sheet && files.length) {
    const cols = files.length > 4 ? 3 : 2;
    const cells = files.map(([t, f]) => `<figure><img src="data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${t}s</figcaption></figure>`).join('');
    const rows = Math.ceil(files.length / cols);
    const sheetPage = await newPage(cdp, { width: cols * 640, height: rows * 384, dpr: 1, mobile: false });
    await sheetPage.setContent(`<style>body{margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},640px)}figure{margin:0;position:relative}img{width:640px;height:360px;display:block}figcaption{height:24px;font:600 15px/24px sans-serif;color:#fff;padding-left:8px}</style>${cells}`);
    await sleep(400);
    fs.writeFileSync(path.join(out, `${name}-sheet.jpg`), await sheetPage.capture({ format: 'jpeg', quality: 82 }));
    console.log(`wrote renders/probe/${name}-sheet.jpg`);
  } else if (files.length) console.log(`wrote ${files.length} frame(s) to renders/probe/`);
} finally {
  await close();
  server.close();
}
