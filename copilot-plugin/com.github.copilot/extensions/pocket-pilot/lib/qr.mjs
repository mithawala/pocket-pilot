// QR codes for the pairing link: SVG for the pairing page, block characters for terminals.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const qrcode = createRequire(import.meta.url)(path.join(here, '..', 'vendor', 'media', 'vendor', 'qrcode.js'));

function make(text, level) {
  const qr = qrcode(0, level);
  qr.addData(text, 'Byte');
  qr.make();
  return qr;
}

export function renderQrSvg(text) {
  const qr = make(text, 'M');
  const n = qr.getModuleCount();
  const m = 3;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const size = n + m * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** Light-on-dark block QR (two modules per character row) that phones scan from a terminal. */
export function renderQrText(text) {
  const qr = make(text, 'L');
  const n = qr.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
