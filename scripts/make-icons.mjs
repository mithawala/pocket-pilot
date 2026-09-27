#!/usr/bin/env node
// Generates every Pocket Pilot icon (SVG + PNG) from one geometry definition, with no dependencies:
// a tiny supersampling rasterizer + PNG encoder (zlib). Run: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- geometry (128 x 128 design grid)
const GRAD = { x1: 0, y1: 0, x2: 128, y2: 128, stops: [[0, [109, 93, 252]], [0.55, [79, 120, 255]], [1, [34, 193, 238]]] };
const plane = [
  { poly: [[22, 58], [106, 26], [56, 72]], fill: [255, 255, 255, 1] },
  { poly: [[56, 72], [106, 26], [74, 104]], fill: [228, 233, 255, 1] },
  { poly: [[56, 72], [74, 104], [60, 94]], fill: [190, 202, 253, 1] },
  { circle: [27, 92, 4.2], fill: [255, 255, 255, 0.7] },
  { circle: [38.5, 101, 3.1], fill: [255, 255, 255, 0.55] },
  { circle: [48.5, 107.5, 2.2], fill: [255, 255, 255, 0.4] },
];

function transform(shapes, s, dx, dy) {
  return shapes.map((sh) => {
    if (sh.poly) return { ...sh, poly: sh.poly.map(([x, y]) => [x * s + dx, y * s + dy]) };
    if (sh.circle) return { ...sh, circle: [sh.circle[0] * s + dx, sh.circle[1] * s + dy, sh.circle[2] * s] };
    return sh;
  });
}

// ---- SVG output
function svg({ rounded = true, bleed = false, mono = false } = {}) {
  const inner = bleed ? transform(plane, 0.72, 18, 18) : plane;
  const color = (f) => (mono ? `rgba(255,255,255,${f[3]})` : `rgba(${f[0]},${f[1]},${f[2]},${f[3]})`);
  const shapes = inner.map((sh) => sh.poly
    ? `<path d="M${sh.poly.map((p) => p.map((v) => +v.toFixed(2)).join(' ')).join('L')}Z" fill="${color(sh.fill)}"/>`
    : `<circle cx="${+sh.circle[0].toFixed(2)}" cy="${+sh.circle[1].toFixed(2)}" r="${+sh.circle[2].toFixed(2)}" fill="${color(sh.fill)}"/>`).join('');
  const bg = mono ? '' : `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${GRAD.stops.map(([o, c]) => `<stop offset="${o}" stop-color="rgb(${c.join(',')})"/>`).join('')}</linearGradient></defs><rect width="128" height="128" rx="${rounded ? 28 : 0}" fill="url(#g)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${bg}${shapes}</svg>\n`;
}

// ---- rasterizer
function gradAt(x, y) {
  const { x1, y1, x2, y2, stops } = GRAD;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [o0, c0] = stops[i - 1];
      const [o1, c1] = stops[i];
      const k = (t - o0) / (o1 - o0);
      return [0, 1, 2].map((j) => c0[j] + (c1[j] - c0[j]) * k);
    }
  }
  return stops[stops.length - 1][1];
}

function inRoundRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = x < r ? r : x > w - r ? w - r : x;
  const cy = y < r ? r : y > h - r ? h - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function raster(size, { rounded = true, bleed = false, mono = false } = {}) {
  const shapes = bleed ? transform(plane, 0.72, 18, 18) : plane;
  const ss = 4;
  const scale = 128 / size;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * scale;
          const y = (py + (sy + 0.5) / ss) * scale;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          if (!mono && (rounded ? inRoundRect(x, y, 128, 128, 28) : true)) {
            [cr, cg, cb] = gradAt(x, y);
            ca = 1;
          }
          for (const sh of shapes) {
            const hit = sh.poly ? inPoly(x, y, sh.poly) : (x - sh.circle[0]) ** 2 + (y - sh.circle[1]) ** 2 <= sh.circle[2] ** 2;
            if (!hit) continue;
            const [fr, fg, fb, fa] = mono ? [255, 255, 255, sh.fill[3]] : sh.fill;
            const na = fa + ca * (1 - fa);
            if (na > 0) {
              cr = (fr * fa + cr * ca * (1 - fa)) / na;
              cg = (fg * fa + cg * ca * (1 - fa)) / na;
              cb = (fb * fa + cb * ca * (1 - fa)) / na;
            }
            ca = na;
          }
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      out[i + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
    }
  }
  return out;
}

// ---- PNG encoder
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(rel, data) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  console.log(`wrote ${rel} (${data.length} bytes)`);
}

write('media/logo.svg', svg());
write('pwa/icons/icon.svg', svg());
write('pwa/icons/maskable.svg', svg({ rounded: false, bleed: true }));
write('media/icon.png', png(128, raster(128)));
write('pwa/icons/icon-192.png', png(192, raster(192)));
write('pwa/icons/icon-512.png', png(512, raster(512)));
write('pwa/icons/maskable-512.png', png(512, raster(512, { rounded: false, bleed: true })));
write('pwa/icons/apple-touch-icon.png', png(180, raster(180, { rounded: false })));
write('pwa/icons/badge-96.png', png(96, raster(96, { mono: true })));
write('pwa/favicon.png', png(64, raster(64)));
write('media/activity.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><rect x="5.5" y="2.5" width="13" height="19" rx="2.8"/><path d="M8.6 12.1 15.6 9l-2 6.6-1.7-2.7z"/><path d="M11.9 12.9 15.6 9"/><path d="M10.5 19h3"/></svg>\n');
