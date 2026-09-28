import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { lookupHostUrl } from '../pwa/js/net/rendezvous.js';

const require = createRequire(import.meta.url);
const { GistRendezvous, DESCRIPTION } = require('../extension/core/rendezvous.js');

/** A small fake of the GitHub gist API (one account): PATCH changes only the files it names. */
function fakeGitHub() {
  const gists = new Map();
  const calls = [];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const view = (id) => {
    const g = gists.get(id);
    return { id, description: g.description, owner: { login: 'mithawala' }, files: Object.fromEntries(Object.entries(g.files).map(([k, v]) => [k, { content: v.content, truncated: false }])) };
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method });
    if (url.startsWith('https://gist.githubusercontent.com/')) {
      const [, , , , id, , file] = url.split('?')[0].split('/');
      const content = gists.get(id)?.files[file]?.content;
      return { ok: !!content, status: content ? 200 : 404, text: async () => content };
    }
    const m = /^https:\/\/api\.github\.com\/gists(?:\/([^/?]+))?/.exec(url);
    if (!m) return json(404, {});
    const body = init.body ? JSON.parse(init.body) : null;
    if (!m[1] && method === 'POST') {
      const id = crypto.randomBytes(8).toString('hex');
      gists.set(id, { description: body.description, files: body.files });
      return json(201, view(id));
    }
    if (!m[1]) return json(200, [...gists.keys()].map((id) => ({ id, description: gists.get(id).description })));
    const g = gists.get(m[1]);
    if (!g) return json(404, { message: 'Not Found' });
    if (method === 'DELETE') {
      gists.delete(m[1]);
      return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
    }
    if (method === 'PATCH') {
      for (const [name, f] of Object.entries(body.files)) {
        if (f === null) delete g.files[name];
        else g.files[name] = f;
      }
    }
    return json(200, view(m[1]));
  };
  return { gists, calls, fetchImpl };
}

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rdv-')), 'rdv.json');
const pc = (gh, hostId, extra = {}) => new GistRendezvous({ getToken: async () => 'gho_test', stateFile: tmpState(), hostId, key: crypto.randomBytes(32), fetchImpl: gh.fetchImpl, ...extra });

test('all your PCs share one gist, one encrypted file each, readable only with that PC key', async () => {
  const gh = fakeGitHub();
  const desk = pc(gh, 'deskHost');
  assert.equal(await desk.publish('https://first-url.trycloudflare.com'), true);
  const info = desk.info();
  assert.equal(info.owner, 'mithawala');
  assert.equal(info.file, 'pc-deskHost.json');
  assert.equal((await lookupHostUrl(info, 'deskHost', gh.fetchImpl)).url, 'https://first-url.trycloudflare.com');

  // An address change updates the same gist.
  await desk.publish('https://second-url.trycloudflare.com');
  assert.equal(gh.calls.at(-1).method, 'PATCH');
  assert.equal((await lookupHostUrl(info, 'deskHost', gh.fetchImpl)).url, 'https://second-url.trycloudflare.com');

  // A second PC finds that gist and adds its own file; neither PC touches the other's.
  const laptop = pc(gh, 'laptopHost');
  await laptop.publish('https://laptop-url.trycloudflare.com');
  assert.equal(gh.gists.size, 1, 'one gist for every PC');
  assert.equal(laptop.info().gistId, info.gistId);
  assert.deepEqual(Object.keys([...gh.gists.values()][0].files).sort(), ['pc-deskHost.json', 'pc-laptopHost.json']);
  assert.equal([...gh.gists.values()][0].description, DESCRIPTION);
  assert.equal((await lookupHostUrl(info, 'deskHost', gh.fetchImpl)).url, 'https://second-url.trycloudflare.com');
  assert.equal((await lookupHostUrl(laptop.info(), 'laptopHost', gh.fetchImpl)).url, 'https://laptop-url.trycloudflare.com');

  // Wrong key or wrong host id yields nothing (no redirection possible).
  assert.equal(await lookupHostUrl({ ...info, key: crypto.randomBytes(32).toString('base64url') }, 'deskHost', gh.fetchImpl), null);
  assert.equal(await lookupHostUrl(info, 'laptopHost', gh.fetchImpl), null);

  // Rate-limited API falls back to the raw CDN URL of the PC's own file.
  const limited = async (url, init) => (url.startsWith('https://api.github.com/') ? { ok: false, status: 403, json: async () => ({}) } : gh.fetchImpl(url, init));
  assert.equal((await lookupHostUrl(info, 'deskHost', limited)).url, 'https://second-url.trycloudflare.com');

  // Persisted state survives a restart; resetting a PC removes only its own file.
  const again = new GistRendezvous({ getToken: async () => 'gho_test', stateFile: desk.o.stateFile, hostId: 'deskHost', key: desk.o.key, fetchImpl: gh.fetchImpl });
  assert.equal(again.info().gistId, info.gistId);
  await again.remove();
  assert.deepEqual(Object.keys([...gh.gists.values()][0].files), ['pc-laptopHost.json']);
  assert.equal(again.info(), null);
});

test('a PC moves from its old gist without stranding devices that have not connected since', async () => {
  const gh = fakeGitHub();
  // How 0.4.0 and earlier left it: a gist of its own for this PC.
  const legacyId = 'legacy1';
  gh.gists.set(legacyId, { description: 'Pocket Pilot rendezvous (end-to-end encrypted; lets your paired devices find this PC)', files: { 'pocket-pilot.json': { content: '{}' } } });
  const stateFile = tmpState();
  fs.writeFileSync(stateFile, JSON.stringify({ gistId: legacyId, owner: 'mithawala', updatedAt: 1 }));
  let waiting = true;
  const key = crypto.randomBytes(32);
  const r = new GistRendezvous({ getToken: async () => 'gho_test', stateFile, hostId: 'oldHost', key, fetchImpl: gh.fetchImpl, legacyInUse: () => waiting });
  assert.deepEqual(r.info(), { gistId: legacyId, owner: 'mithawala', file: 'pocket-pilot.json', key: key.toString('base64url') }, 'devices keep being told the old location until the move');
  assert.equal(r.shared, false);

  await r.publish('https://new-url.trycloudflare.com');
  assert.equal(r.shared, true);
  assert.equal(r.info().file, 'pc-oldHost.json');
  // A device paired before the move still finds the new address in the old gist.
  const oldInfo = { gistId: legacyId, owner: 'mithawala', file: 'pocket-pilot.json', key: key.toString('base64url') };
  assert.equal((await lookupHostUrl(oldInfo, 'oldHost', gh.fetchImpl)).url, 'https://new-url.trycloudflare.com');
  assert.equal(await r.retireLegacy(), false, 'kept while a device may still need it');

  // Every device learned the shared gist: the old one is deleted.
  waiting = false;
  assert.equal(await r.retireLegacy(), true);
  assert.equal(gh.gists.has(legacyId), false);
  assert.equal(gh.gists.size, 1);

  // A gist that isn't Pocket Pilot's is never deleted.
  gh.gists.set('mine', { description: 'my notes', files: { 'notes.md': { content: 'x' } } });
  const s2 = tmpState();
  fs.writeFileSync(s2, JSON.stringify({ gistId: 'mine', owner: 'mithawala' }));
  const other = new GistRendezvous({ getToken: async () => 'gho_test', stateFile: s2, hostId: 'h2', key: crypto.randomBytes(32), fetchImpl: gh.fetchImpl });
  await other.publish('https://x.trycloudflare.com');
  assert.equal(gh.gists.has('mine'), true);
});

test('publish reports sign-in required without a token and surfaces API errors', async () => {
  const stateFile = tmpState();
  const r = new GistRendezvous({ getToken: async () => null, stateFile, hostId: 'h', key: crypto.randomBytes(32), fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(await r.publish('https://x.trycloudflare.com'), false);
  assert.equal(r.status, 'signin-required');
  const denied = new GistRendezvous({
    getToken: async () => 't', stateFile, hostId: 'h', key: crypto.randomBytes(32),
    fetchImpl: async (url, init = {}) => ((init.method || 'GET') === 'GET' ? { ok: true, status: 200, json: async () => [] } : { ok: false, status: 403, json: async () => ({ message: 'Resource not accessible' }) }),
  });
  assert.equal(await denied.publish('https://x.trycloudflare.com'), false);
  assert.match(denied.lastError, /personal GitHub account/);
});
