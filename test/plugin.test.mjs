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
