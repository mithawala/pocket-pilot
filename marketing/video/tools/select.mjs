// Makes one composition the project's index.html, which `hyperframes lint | check | snapshot | preview`
// read (render takes -c compositions/<name>.html directly).
//   node marketing/video/tools/select.mjs walk-away
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
const src = path.join(root, 'compositions', `${name}.html`);
if (!name || !fs.existsSync(src)) {
  console.error(`Usage: node tools/select.mjs <${fs.readdirSync(path.join(root, 'compositions')).map((f) => f.replace(/\.html$/, '')).join(' | ')}>`);
  process.exit(1);
}
fs.copyFileSync(src, path.join(root, 'index.html'));
console.log(`index.html <- compositions/${name}.html`);
