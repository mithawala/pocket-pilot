#!/usr/bin/env node
// Generates every Pocket Pilot icon from one design: the visor bot climbing out of a jeans pocket
// (option 12 in design/icons/). SVGs are written directly; PNGs are rendered with headless
// Edge/Chrome (scripts/lib/headless.mjs), so no image libraries are needed.
// Run: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage } from './lib/headless.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFS = `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset="1" stop-color="#0f172a"/></linearGradient>
<radialGradient id="glow" cx=".5" cy=".42" r=".55"><stop offset="0" stop-color="#6366f1" stop-opacity=".55"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></radialGradient>
<linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#c3cfdf"/></linearGradient>
<linearGradient id="visor" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".55" stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
<linearGradient id="pocket" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d42c4"/><stop offset="1" stop-color="#1b2785"/></linearGradient>`;

// 512 × 512 design grid (same as design/icons/12-visor-bot-pocket.svg).
const ART = `<g transform="translate(25.6 2) scale(.9)">
<path d="M318 126L344 86" stroke="#c3cfdf" stroke-width="9" stroke-linecap="round"/>
<circle cx="348" cy="78" r="13" fill="#f472b6"/>
<path d="M128 296C128 172 184 110 256 110S384 172 384 296C384 340 352 372 308 372H204C160 372 128 340 128 296Z" fill="url(#metal)"/>
<circle cx="136" cy="286" r="11" fill="#94a3b8"/>
<circle cx="376" cy="286" r="11" fill="#94a3b8"/>
<rect x="150" y="198" width="212" height="102" rx="51" fill="url(#visor)"/>
<path d="M178 222Q226 206 278 212" stroke="#fff" stroke-opacity=".55" stroke-width="10" stroke-linecap="round" fill="none"/>
<circle cx="220" cy="254" r="22" fill="#fff" opacity=".25"/>
<circle cx="292" cy="254" r="22" fill="#fff" opacity=".25"/>
<circle cx="220" cy="254" r="11" fill="#fff"/>
<circle cx="292" cy="254" r="11" fill="#fff"/>
</g>
<path d="M88 296Q256 262 424 296L406 416Q400 444 372 448H140Q112 444 106 416Z" fill="url(#pocket)"/>
<path d="M110 310Q256 280 402 310" stroke="#8ea4ff" stroke-width="6" stroke-dasharray="16 12" stroke-linecap="round" fill="none"/>
<path d="M150 342H362" stroke="#3f55d6" stroke-width="4" stroke-linecap="round" opacity=".7"/>
<ellipse cx="172" cy="288" rx="30" ry="21" fill="url(#metal)"/>
<ellipse cx="340" cy="288" rx="30" ry="21" fill="url(#metal)"/>
<path d="M162 282v12M178 280v14M332 280v14M348 282v12" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"/>`;

/** radius: tile corner radius (0 = full bleed for maskable / iOS). scale: shrink the art into the maskable safe zone. */
function iconSvg({ radius = 112, scale = 1 } = {}) {
  const off = +(256 * (1 - scale)).toFixed(2);
  const art = scale === 1 ? ART : `<g transform="translate(${off} ${off}) scale(${scale})">${ART}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Pocket Pilot</title><defs>${DEFS}</defs><rect width="512" height="512" rx="${radius}" fill="url(#bg)"/><rect width="512" height="512" rx="${radius}" fill="url(#glow)"/>${art}</svg>\n`;
}

// Android notification badge: a white silhouette (only the alpha channel is used).
const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="#fff">
<path d="M15.3 6.4l1.7-2.8" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>
<circle cx="17.4" cy="3.1" r="1.25"/>
<path fill-rule="evenodd" d="M6.2 13.4V12C6.2 8.1 8.8 5.5 12 5.5S17.8 8.1 17.8 12V13.4ZM9.9 8.9H14.1A1.7 1.7 0 0 1 14.1 12.3H9.9A1.7 1.7 0 0 1 9.9 8.9Z"/>
<circle cx="10.5" cy="10.6" r=".75"/><circle cx="13.5" cy="10.6" r=".75"/>
<path d="M3.4 15.1Q12 13.3 20.6 15.1L19.8 20.1Q19.6 21.2 18.4 21.3H5.6Q4.4 21.2 4.2 20.1Z"/>
</g></svg>\n`;

// VS Code activity bar glyph: outline in the style of the codicons (VS Code tints it).
const ACTIVITY = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 6.3l1.6-2.6"/><circle cx="17.3" cy="3.1" r="1.05" fill="currentColor" stroke="none"/><path d="M6.4 13.1v-1C6.4 8.3 8.9 5.6 12 5.6s5.6 2.7 5.6 6.5v1"/><rect x="8.5" y="8.8" width="7" height="3.3" rx="1.65"/><path d="M3.6 15q8.4-1.9 16.8 0l-.9 5a1.3 1.3 0 0 1-1.3 1.1H5.8a1.3 1.3 0 0 1-1.3-1.1z"/></svg>\n`;

function write(rel, data) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  console.log(`wrote ${rel} (${data.length} bytes)`);
}

async function rasterize(cdp, svg, size) {
  const page = await newPage(cdp, { width: size, height: size, dpr: 1, mobile: false, transparent: true });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  await page.setContent(`<!DOCTYPE html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="${src}"></body></html>`);
  await page.waitFor('document.images[0] && document.images[0].complete && document.images[0].naturalWidth > 0');
  const png = await page.capture({ format: 'png', clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}

const standard = iconSvg();
const maskable = iconSvg({ radius: 0, scale: 0.8 });
const fullBleed = iconSvg({ radius: 0 });

write('media/logo.svg', standard);
write('pwa/icons/icon.svg', standard);
write('pwa/icons/maskable.svg', maskable);
write('media/activity.svg', ACTIVITY);

const { cdp, close } = await launchBrowser();
try {
  write('media/icon.png', await rasterize(cdp, standard, 256));
  write('pwa/icons/icon-192.png', await rasterize(cdp, standard, 192));
  write('pwa/icons/icon-512.png', await rasterize(cdp, standard, 512));
  write('pwa/icons/maskable-512.png', await rasterize(cdp, maskable, 512));
  write('pwa/icons/apple-touch-icon.png', await rasterize(cdp, fullBleed, 180));
  write('pwa/icons/badge-96.png', await rasterize(cdp, BADGE, 96));
  write('pwa/favicon.png', await rasterize(cdp, standard, 64));
} finally {
  await close();
}
