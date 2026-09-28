'use strict';
// Publishes the current tunnel URL to a *secret* GitHub gist, encrypted with a key only paired
// phones know, so phones can find the PC again after VS Code restarts (quick tunnel URLs change).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = 'pocket-pilot.json';
const API = 'https://api.github.com';

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

class GistRendezvous {
  /**
   * @param {object} o
   * @param {(interactive: boolean) => Promise<string|null>} o.getToken  GitHub token with `gist` scope
   * @param {string} o.stateFile
   * @param {string} o.hostId
   * @param {Buffer} o.key
   */
  constructor(o) {
    this.o = o;
    this.log = o.log || (() => {});
    this.fetch = o.fetchImpl || fetch;
    this.state = this._read();
    this.status = this.state.gistId ? 'ready' : 'disabled';
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

  /** What phones need to look the URL up (sent inside the encrypted welcome message). */
  info() {
    if (!this.state.gistId) return null;
    return { gistId: this.state.gistId, owner: this.state.owner, file: FILE, key: this.o.key.toString('base64url') };
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
      /* empty */
    }
    return { status: res.status, ok: res.ok, json };
  }

  /**
   * Creates/updates the gist with the encrypted URL.
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
    const files = { [FILE]: { content } };
    try {
      let r;
      if (this.state.gistId) {
        r = await this._api('PATCH', `${API}/gists/${this.state.gistId}`, token, { files });
        if (r.status === 404) {
          this.state = {};
          r = null;
        }
      }
      if (!r) {
        r = await this._api('POST', `${API}/gists`, token, {
          description: 'Pocket Pilot rendezvous (end-to-end encrypted; lets your paired devices find this PC)',
          public: false,
          files,
        });
      }
      if (!r.ok) {
        const msg = r.json?.message || `HTTP ${r.status}`;
        throw new Error(r.status === 403 || r.status === 422 ? `GitHub refused to create the gist (${msg}). Work accounts (Enterprise Managed Users) cannot own gists — choose a personal GitHub account.` : msg);
      }
      this.state = { gistId: r.json.id, owner: r.json.owner?.login || this.state.owner, updatedAt: Date.now() };
      this._write();
      this.status = 'ready';
      this.lastError = null;
      this.log('info', `Rendezvous gist updated (${this.state.gistId.slice(0, 8)}…)`);
      return true;
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      this.log('warn', `Rendezvous update failed: ${err.message}`);
      return false;
    }
  }

  forget() {
    this.state = {};
    this._write();
    this.status = 'disabled';
  }
}

module.exports = { GistRendezvous, encryptNote, decryptNote, FILE };
