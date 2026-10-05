import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostComputer, defaultHostLabel, hostLabel, cleanHostLabel } from '../pwa/js/lib/format.js';
import { HostConnection } from '../pwa/js/net/host-connection.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('computer names: the computer and the app it serves, so VS Code and the Copilot app tell apart', () => {
  const vscode = { hostName: 'Marcuss-MacBook-Pro-4.local', hostKind: 'vscode' };
  const copilot = { hostName: 'Marcuss-MacBook-Pro-4.local · Copilot', hostKind: 'copilot' };
  assert.equal(hostComputer(vscode), 'Marcuss-MacBook-Pro-4', "a Mac's .local goes");
  assert.equal(hostComputer(copilot), 'Marcuss-MacBook-Pro-4', 'and the plugin\'s " · Copilot"');
  assert.equal(defaultHostLabel(vscode), 'Marcuss-MacBook-Pro-4 · VS Code');
  assert.equal(defaultHostLabel(copilot), 'Marcuss-MacBook-Pro-4 · Copilot app');
  assert.equal(defaultHostLabel({ hostName: 'CPC-amith-XGHZ8' }), 'CPC-amith-XGHZ8 · VS Code', 'paired before hosts said which app they are');
  assert.equal(defaultHostLabel({}), 'Computer · VS Code');
  assert.equal(hostLabel(copilot), 'Marcuss-MacBook-Pro-4 · Copilot app');
  assert.equal(hostLabel({ ...copilot, customName: 'Dev box' }), 'Dev box');
  assert.equal(cleanHostLabel('  Dev\n box   (Copilot) '), 'Dev box (Copilot)');
  assert.equal(cleanHostLabel('x'.repeat(80)).length, 60);
  assert.equal(cleanHostLabel('   '), '');
  assert.equal(cleanHostLabel(undefined), '');
});

test('computer names: a reconnect updates the record without losing the name you gave it', () => {
  const record = { hostId: 'h1', hostName: 'old-name', customName: 'Dev box', hostKind: 'vscode', url: 'https://x.trycloudflare.com' };
  const conn = new HostConnection(record, { webauthn: {} });
  const saved = [];
  conn.addEventListener('record', (e) => saved.push({ ...e.detail.record }));
  conn._updateRecord({ hostName: 'new-name', hostKind: 'copilot', rendezvous: undefined });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].hostName, 'new-name');
  assert.equal(saved[0].customName, 'Dev box', 'what the app writes back still has your name');
  assert.equal(conn.record, record, 'the app and the connection share one record');
});

test('computer names: renamed in the switcher and in Settings, and kept when paired again', () => {
  const app = fs.readFileSync(path.join(root, 'pwa', 'js', 'ui', 'app.js'), 'utf8');
  assert.match(app, /if \(!clean \|\| clean === defaultHostLabel\(h\)\) delete h\.customName;/, 'empty or the default name: the default');
  assert.match(app, /if \(before\?\.customName && !record\.customName\) record\.customName = before\.customName;/);
  assert.match(app, /aria-label=\$\{`Rename \$\{hostLabel\(h\)\}`\}/);
  const settings = fs.readFileSync(path.join(root, 'pwa', 'js', 'ui', 'settings.js'), 'utf8');
  assert.match(settings, /onClick=\$\{\(\) => setRenaming\(h\)\}>Rename<\/button>/);
  // Every name on screen is the label; the authenticator and passkey keep the name they were saved under.
  for (const f of ['app.js', 'settings.js', 'sessions.js']) {
    const src = fs.readFileSync(path.join(root, 'pwa', 'js', 'ui', f), 'utf8');
    assert.doesNotMatch(src, /\$\{(h|host|record)\.hostName\}/, `${f} shows hostLabel()`);
  }
});

test('the phone app says "computer": it runs on Macs too', () => {
  const dir = path.join(root, 'pwa', 'js');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js') && !f.includes('vendor'));
  const left = [];
  for (const f of files) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/\bPCs?\b/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) left.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(left, []);
});
