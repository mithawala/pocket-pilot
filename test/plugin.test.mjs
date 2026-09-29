import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'copilot-plugin');

test('copilot plugin: vendored core and version match the sources', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'build-plugin.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(fs.readFileSync(path.join(root, 'pwa', 'js', 'net', 'host-connection.js'), 'utf8'), new RegExp(`APP_VERSION = '${version.replace(/\./g, '\\.')}'`), 'the phone app reports the release version');
});

test('copilot plugin: Agent Plugins 1.0 layout', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'pocket-pilot');
  assert.equal(manifest.version, pkg.version);
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
  assert.deepEqual(Object.keys(manifest).filter((k) => !allowed.has(k)), [], 'only Agent Plugins 1.0 top-level fields');
  assert.ok(fs.existsSync(path.join(plugin, 'skills', 'pocket-pilot', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(plugin, 'com.github.copilot', 'extensions', 'pocket-pilot', 'extension.mjs')));
  const skill = fs.readFileSync(path.join(plugin, 'skills', 'pocket-pilot', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: pocket-pilot\r?\ndescription: .+\r?\n---/);
  const market = JSON.parse(fs.readFileSync(path.join(root, '.github', 'plugin', 'marketplace.json'), 'utf8'));
  assert.equal(market.plugins[0].name, 'pocket-pilot');
  assert.equal(market.plugins[0].source, './copilot-plugin');
});

// github/awesome-copilot's external plugin intake (eng/external-plugin-validation.mjs,
// eng/external-plugin-intake.mjs): what a listing needs besides the Agent Plugins 1.0 layout.
test('copilot plugin: meets the Awesome Copilot listing rules', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'plugin.json'), 'utf8'));
  assert.ok(manifest.description.length <= 500, 'description: 500 characters or fewer');
  assert.ok(manifest.keywords.length >= 1 && manifest.keywords.length <= 10, 'keywords: 1 to 10');
  for (const k of manifest.keywords) assert.match(k, /^[a-z0-9-]{1,30}$/, `keyword "${k}"`);
  assert.deepEqual(Object.keys(manifest.author).filter((k) => !['name', 'email', 'url'].includes(k)), []);
  assert.match(manifest.license, /^LicenseRef-[A-Za-z0-9.-]+$/, 'a license outside the SPDX list is written as LicenseRef-…');
  // Canvas plugins must say so and ship their preview at exactly this path.
  assert.ok(manifest.keywords.includes('canvas'));
  assert.equal(manifest.extensions?.['com.github.copilot']?.logo, 'assets/preview.png');
  const preview = fs.readFileSync(path.join(plugin, 'assets', 'preview.png'));
  assert.deepEqual([...preview.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG file');
  assert.ok(preview.length < 1024 * 1024, 'preview stays small (it is installed with the plugin)');
});
