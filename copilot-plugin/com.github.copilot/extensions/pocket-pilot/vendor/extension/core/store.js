'use strict';
// Persistent host-side state: paired devices (public data) in a JSON file, secrets (private keys)
// in an injected secret store (VS Code SecretStorage in production).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class DeviceStore extends EventEmitter {
  constructor(file, { watch = false } = {}) {
    super();
    this.file = file;
    this.devices = [];
    this._load();
    if (watch) this.watch();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.devices = Array.isArray(data.devices) ? data.devices : [];
    } catch {
      this.devices = [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices: this.devices }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.emit('change');
  }

  /**
   * Picks up changes made by other VS Code windows (each has its own extension host).
   * Emits 'removed' with the ids of devices that disappeared so live connections can be cut.
   */
  watch(intervalMs = 1500) {
    if (this._watching) return;
    this._watching = true;
    fs.watchFile(this.file, { interval: intervalMs }, () => this.reload());
  }

  unwatch() {
    if (!this._watching) return;
    this._watching = false;
    fs.unwatchFile(this.file);
  }

  reload() {
    const before = new Set(this.devices.map((d) => d.id));
    this._load();
    const after = new Set(this.devices.map((d) => d.id));
    const removed = [...before].filter((id) => !after.has(id));
    if (removed.length) this.emit('removed', removed);
    this.emit('change');
  }

  list() {
    return this.devices.slice();
  }

  get(id) {
    return this.devices.find((d) => d.id === id) || null;
  }

  getByPublicKey(publicKeyB64u) {
    return this.devices.find((d) => d.publicKey === publicKeyB64u) || null;
  }

  add(device) {
    this._load();
    this.devices = this.devices.filter((d) => d.id !== device.id && d.publicKey !== device.publicKey);
    this.devices.push(device);
    this._save();
    return device;
  }

  update(id, patch) {
    this._load();
    const d = this.get(id);
    if (!d) return null;
    Object.assign(d, typeof patch === 'function' ? patch(d) : patch);
    this._save();
    return d;
  }

  remove(id) {
    this._load();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== before) {
      this._save();
      this.emit('removed', [id]);
    }
    return before !== this.devices.length;
  }

  clear() {
    this._load();
    const ids = this.devices.map((d) => d.id);
    this.devices = [];
    this._save();
    if (ids.length) this.emit('removed', ids);
  }
}

function deviceIdFor(publicKeyRaw) {
  return crypto.createHash('sha256').update('pp-dev1').update(Buffer.from(publicKeyRaw)).digest('base64url').slice(0, 16);
}

/** In-memory secret store (tests / standalone). Same shape as vscode.SecretStorage. */
class MemorySecrets {
  constructor() {
    this.map = new Map();
  }
  async get(k) {
    return this.map.get(k);
  }
  async store(k, v) {
    this.map.set(k, v);
  }
  async delete(k) {
    this.map.delete(k);
  }
}

/** File-backed secret store for the standalone dev relay. */
class FileSecrets {
  constructor(file) {
    this.file = file;
  }
  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }
  async get(k) {
    return this._read()[k];
  }
  async store(k, v) {
    const all = this._read();
    all[k] = v;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }
  async delete(k) {
    const all = this._read();
    delete all[k];
    fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }
}

module.exports = { DeviceStore, deviceIdFor, MemorySecrets, FileSecrets };
