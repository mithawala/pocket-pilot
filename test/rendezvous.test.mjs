import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { lookupHostUrl } from '../pwa/js/net/rendezvous.js';

const require = createRequire(import.meta.url);
const { GistRendezvous } = require('../extension/core/rendezvous.js');

function fakeGitHub() {
  const gists = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    const m = /\/gists(?:\/([^/?]+))?/.exec(url);
    if (url.startsWith('https://api.github.com/gists') && init.method === 'POST') {
      const id = crypto.randomBytes(8).toString('hex');
      const body = JSON.parse(init.body);
      gists.set(id, body.files);
      return json(201, { id, owner: { login: 'mithawala' }, public: body.public });
    }
    if (m && m[1] && init.method === 'PATCH') {
      if (!gists.has(m[1])) return json(404, { message: 'Not Found' });
      gists.set(m[1], JSON.parse(init.body).files);
      return json(200, { id: m[1], owner: { login: 'mithawala' } });
    }
    if (m && m[1] && url.startsWith('https://api.github.com/')) {
      const files = gists.get(m[1]);
      if (!files) return json(404, {});
      return json(200, { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v.content, truncated: false }])) });
    }
    if (url.startsWith('https://gist.githubusercontent.com/')) {
      const id = url.split('/')[4];
      const files = gists.get(id);
      return { ok: !!files, status: files ? 200 : 404, text: async () => files['pocket-pilot.json'].content };
    }
    return json(404, {});
  };
  return { gists, calls, fetchImpl };
}

test('extension-encrypted rendezvous note is readable by the PWA (and only with the key)', async () => {
  const gh = fakeGitHub();
  const key = crypto.randomBytes(32);
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rdv-')), 'rdv.json');
  const r = new GistRendezvous({ getToken: async () => 'gho_test', stateFile, hostId: 'host123', key, fetchImpl: gh.fetchImpl });
  assert.equal(await r.publish('https://first-url.trycloudflare.com'), true);
  const info = r.info();
  assert.equal(info.owner, 'mithawala');
  assert.equal(gh.calls[0].method, 'POST');
  const found = await lookupHostUrl(info, 'host123', gh.fetchImpl);
  assert.equal(found.url, 'https://first-url.trycloudflare.com');

  // URL change updates the same gist.
  await r.publish('https://second-url.trycloudflare.com');
  assert.equal(gh.calls.at(-1).method, 'PATCH');
  assert.equal((await lookupHostUrl(info, 'host123', gh.fetchImpl)).url, 'https://second-url.trycloudflare.com');

  // Wrong key or wrong host id yields nothing (no redirection possible).
  assert.equal(await lookupHostUrl({ ...info, key: crypto.randomBytes(32).toString('base64url') }, 'host123', gh.fetchImpl), null);
  assert.equal(await lookupHostUrl(info, 'other-host', gh.fetchImpl), null);

  // Rate-limited API falls back to the raw CDN URL.
  const limited = async (url, init) => (url.startsWith('https://api.github.com/') ? { ok: false, status: 403, json: async () => ({}) } : gh.fetchImpl(url, init));
  assert.equal((await lookupHostUrl(info, 'host123', limited)).url, 'https://second-url.trycloudflare.com');

  // Persisted state survives a restart.
  const r2 = new GistRendezvous({ getToken: async () => 'gho_test', stateFile, hostId: 'host123', key, fetchImpl: gh.fetchImpl });
  assert.equal(r2.info().gistId, info.gistId);
});

test('publish reports sign-in required without a token and surfaces API errors', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rdv-')), 'rdv.json');
  const r = new GistRendezvous({ getToken: async () => null, stateFile, hostId: 'h', key: crypto.randomBytes(32), fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(await r.publish('https://x.trycloudflare.com'), false);
  assert.equal(r.status, 'signin-required');
  const denied = new GistRendezvous({
    getToken: async () => 't', stateFile, hostId: 'h', key: crypto.randomBytes(32),
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'Resource not accessible' }) }),
  });
  assert.equal(await denied.publish('https://x.trycloudflare.com'), false);
  assert.match(denied.lastError, /personal GitHub account/);
});
