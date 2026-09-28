'use strict';
// Auto-reconnect: keeps the current tunnel address of each of your PCs in ONE secret GitHub gist on
// your account, one small file per PC, each encrypted with a key only that PC's paired devices have.
// A PC only ever writes its own file (so two PCs never overwrite each other), and devices read the
// gist anonymously to find the PC again after its address changed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API = 'https://api.github.com';
const DESCRIPTION = 'Pocket Pilot · encrypted addresses of your PCs, so your paired devices can find them';
// Before 0.4.1 every PC had a gist of its own holding this one file.
const LEGACY_FILE = 'pocket-pilot.json';
const LEGACY_DESCRIPTION = /^Pocket Pilot rendezvous/;
const fileFor = (hostId) => `pc-${hostId}.json`;

function encryptNote(key, hostId, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`pp-rdv1|${hostId}`));
  const ct = Buffer.concat([c.update(JSON.stringify(data)), c.final(), c.getAuthTag()]);
  return { v: 1, hid: hostId, iv: iv.toString('base64url'), ct: ct.toString('base64url') };
}

function decryptNote(key, hostId, note) {
  const buf = Buffer.from(note.ct, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(note.iv, 'base64url'));
  d.setAAD(Buffer.from(`pp-rdv1|${hostId}`));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString());
}

function apiError(r) {
  const msg = r.json?.message || `HTTP ${r.status}`;
  return new Error(r.status === 403 || r.status === 422 ? `GitHub refused to create the gist (${msg}). Work accounts (Enterprise Managed Users) cannot own gists — choose a personal GitHub account.` : msg);
}

class GistRendezvous {
  /**
   * @param {object} o
   * @param {(interactive: boolean) => Promise<string|null>} o.getToken  GitHub token with `gist` scope
   * @param {string} o.stateFile
   * @param {string} o.hostId
   * @param {Buffer} o.key
   * @param {() => boolean} [o.legacyInUse]  true while a paired device may still look for this PC in its old gist
   */
  constructor(o) {
    this.o = o;
    this.log = o.log || (() => {});
    this.fetch = o.fetchImpl || fetch;
    this.file = fileFor(o.hostId);
    this.state = this._read();
    // Earlier state ({gistId, owner}) described this PC's own gist: it's now the old one to retire.
    if (this.state.gistId && this.state.v !== 2) this.state = { legacyGistId: this.state.gistId, owner: this.state.owner };
    this.status = this.state.gistId || this.state.legacyGistId ? 'ready' : 'disabled';
    this.lastError = null;
    this.lastUrl = null;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.o.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  _write() {
    fs.mkdirSync(path.dirname(this.o.stateFile), { recursive: true });
    fs.writeFileSync(this.o.stateFile, JSON.stringify(this.state, null, 2));
  }

  /** True once devices are told about the shared gist rather than this PC's old one. */
  get shared() {
    return !!this.state.gistId;
  }

  /** What devices need to look the address up (sent inside the encrypted welcome message). */
  info() {
    const key = this.o.key.toString('base64url');
    if (this.state.gistId) return { gistId: this.state.gistId, owner: this.state.owner, file: this.file, key };
    if (this.state.legacyGistId) return { gistId: this.state.legacyGistId, owner: this.state.owner, file: LEGACY_FILE, key };
    return null;
  }

  async _api(method, url, token, body) {
    const res = await this.fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pocket-pilot',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty (204) */
    }
    return { status: res.status, ok: res.ok, json };
  }

  /**
   * Writes the encrypted address to this PC's file in the shared gist (creating the gist if needed).
   * @param {string} url
   * @param {{interactive?: boolean}} [opts]
   */
  async publish(url, { interactive = false } = {}) {
    this.lastUrl = url;
    const token = await this.o.getToken(interactive);
    if (!token) {
      this.status = 'signin-required';
      return false;
    }
    const content = JSON.stringify(encryptNote(this.o.key, this.o.hostId, { url, ts: Date.now() }));
    try {
      const gist = await this._writeShared(token, content);
      this.state = { ...this.state, v: 2, gistId: gist.id, owner: gist.owner || this.state.owner, updatedAt: Date.now() };
      if (this.state.legacyGistId) {
        // Devices that haven't connected since the move still read the old gist: keep it current for them.
        if (this.o.legacyInUse?.()) await this._writeLegacy(token, content);
        else await this._retireLegacy(token);
      }
      this._write();
      this.status = 'ready';
      this.lastError = null;
      this.log('info', `Auto-reconnect address updated (gist ${this.state.gistId.slice(0, 8)}…, ${this.file})`);
      return true;
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      this.log('warn', `Auto-reconnect update failed: ${err.message}`);
      return false;
    }
  }

  async _writeShared(token, content) {
    const body = { files: { [this.file]: { content } } };
    const done = (r) => ({ id: r.json.id, owner: r.json.owner?.login });
    if (this.state.gistId) {
      const r = await this._api('PATCH', `${API}/gists/${this.state.gistId}`, token, body);
      if (r.ok) return done(r);
      if (r.status !== 404) throw apiError(r);
    }
    // Another PC (or Pocket Pilot for the Copilot app on this PC) may have created it already.
    for (let page = 1; page <= 5; page++) {
      const r = await this._api('GET', `${API}/gists?per_page=100&page=${page}`, token);
      if (!r.ok || !Array.isArray(r.json)) break;
      const found = r.json.find((g) => g.description === DESCRIPTION);
      if (found) {
        const p = await this._api('PATCH', `${API}/gists/${found.id}`, token, body);
        if (p.ok) return done(p);
      }
      if (r.json.length < 100) break;
    }
    const c = await this._api('POST', `${API}/gists`, token, { description: DESCRIPTION, public: false, ...body });
    if (!c.ok) throw apiError(c);
    return done(c);
  }

  async _writeLegacy(token, content) {
    const r = await this._api('PATCH', `${API}/gists/${this.state.legacyGistId}`, token, { files: { [LEGACY_FILE]: { content } } });
    if (r.status === 404) delete this.state.legacyGistId;
  }

  async _retireLegacy(token) {
    const id = this.state.legacyGistId;
    const g = await this._api('GET', `${API}/gists/${id}`, token);
    // Only ever delete a gist that is this PC's old Pocket Pilot one.
    if (g.ok && LEGACY_DESCRIPTION.test(g.json?.description || '')) {
      const d = await this._api('DELETE', `${API}/gists/${id}`, token);
      if (!d.ok && d.status !== 404) return;
      this.log('info', 'Removed the old auto-reconnect gist');
    }
    delete this.state.legacyGistId;
  }

  /** Deletes this PC's old gist once no paired device still depends on it. */
  async retireLegacy() {
    if (!this.state.legacyGistId || !this.state.gistId || this.o.legacyInUse?.()) return false;
    const token = await this.o.getToken(false);
    if (!token) return false;
    await this._retireLegacy(token);
    this._write();
    return true;
  }

  /** Removes this PC's file (its identity is reset: no device can use it any more). */
  async remove() {
    const token = await this.o.getToken(false).catch(() => null);
    if (token && this.state.gistId) await this._api('PATCH', `${API}/gists/${this.state.gistId}`, token, { files: { [this.file]: null } }).catch(() => {});
    if (token && this.state.legacyGistId) await this._retireLegacy(token).catch(() => {});
    this.forget();
  }

  forget() {
    this.state = {};
    this._write();
    this.status = 'disabled';
  }
}

module.exports = { GistRendezvous, encryptNote, decryptNote, fileFor, DESCRIPTION, LEGACY_FILE, FILE: LEGACY_FILE };
