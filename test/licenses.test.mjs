import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('licenses: every vendored library ships its license and is listed in the notices', () => {
  const dirs = fs.readdirSync(path.join(root, 'pwa', 'vendor'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(dirs.length > 0);
  for (const d of dirs) assert.ok(fs.existsSync(path.join(root, 'pwa', 'vendor', d, 'LICENSE')), `pwa/vendor/${d}/LICENSE`);
  assert.ok(fs.existsSync(path.join(root, 'media', 'vendor', 'LICENSE')), 'media/vendor/LICENSE');
  const notices = read('THIRD-PARTY-NOTICES.md');
  for (const d of dirs) assert.ok(notices.includes(`pwa/vendor/${d}/`), `THIRD-PARTY-NOTICES.md lists pwa/vendor/${d}/`);
  assert.ok(notices.includes('media/vendor/'));
});

test('licenses: the icon sets are credited with their license texts', () => {
  const notices = read('THIRD-PARTY-NOTICES.md');
  for (const [name, text] of [['Feather', 'Copyright (c) 2013-2023 Cole Bemis'], ['Lucide', 'ISC License'], ['Octicons', 'GitHub Inc.']]) {
    assert.ok(notices.includes(`### ${name}`) && notices.includes(text), name);
  }
  assert.match(read('pwa', 'js', 'ui', 'common.js'), /Feather.*Lucide/);
  assert.match(read('site', 'index.html'), /Feather.*Lucide.*Octicons/);
  assert.match(read('LICENSE'), /THIRD-PARTY-NOTICES\.md/);
});

test('licenses: the notices ship with the extension, the Copilot plugin and the site', () => {
  assert.match(read('scripts', 'package-vsix.mjs'), /'THIRD-PARTY-NOTICES\.md'/);
  assert.match(read('scripts', 'build-site.mjs'), /'THIRD-PARTY-NOTICES\.md'/);
  assert.equal(read('copilot-plugin', 'THIRD-PARTY-NOTICES.md'), read('THIRD-PARTY-NOTICES.md'));
  assert.equal(read('copilot-plugin', 'com.github.copilot', 'extensions', 'pocket-pilot', 'vendor', 'media', 'vendor', 'LICENSE'), read('media', 'vendor', 'LICENSE'));
});
