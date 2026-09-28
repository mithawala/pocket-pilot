'use strict';
// State shared by the VS Code windows of one profile (global storage is common to all of them).
// The window that runs Pocket Pilot publishes its panel state; the others mirror it, forward
// button presses as requests, and any focused window can answer a phone's pairing request.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SharedState {
  constructor(dir) {
    this.dir = dir;
    this.mirrorFile = path.join(dir, 'mirror.json');
    this.controlFile = path.join(dir, 'control.json');
    this.requestsDir = path.join(dir, 'requests');
    this.approvalsDir = path.join(dir, 'approvals');
  }

  _write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  _read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- mirror + control

  writeMirror(value) {
    try {
      this._write(this.mirrorFile, value);
    } catch {
      /* best effort */
    }
  }

  readMirror() {
    return this._read(this.mirrorFile);
  }

  clearMirror(pid = process.pid) {
    if (this.readMirror()?.pid === pid) fs.rmSync(this.mirrorFile, { force: true });
  }

  /** Whether the user wants remote access on (survives the hosting window closing). */
  enabled() {
    return this._read(this.controlFile)?.enabled === true;
  }

  setEnabled(enabled) {
    try {
      this._write(this.controlFile, { enabled, at: Date.now() });
    } catch {
      /* best effort */
    }
  }

  // ---------------------------------------------------------------- requests (mirror -> host)

  request(action, args = {}) {
    const file = path.join(this.requestsDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
    this._write(file, { action, args, from: process.pid, at: Date.now() });
  }

  /** For the hosting window: takes (and removes) the pending requests, oldest first. */
  takeRequests() {
    let names;
    try {
      names = fs.readdirSync(this.requestsDir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      const file = path.join(this.requestsDir, n);
      const r = this._read(file);
      fs.rmSync(file, { force: true });
      if (r && typeof r.action === 'string' && Date.now() - (r.at || 0) < 60000) out.push(r);
    }
    return out;
  }

  // ---------------------------------------------------------------- pairing approvals (any window)

  postApproval(info) {
    const id = crypto.randomBytes(8).toString('hex');
    this._write(path.join(this.approvalsDir, `${id}.json`), { id, info, at: Date.now() });
    return id;
  }

  pendingApprovals() {
    let names;
    try {
      names = fs.readdirSync(this.approvalsDir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f));
    } catch {
      return [];
    }
    return names.map((n) => this._read(path.join(this.approvalsDir, n))).filter((a) => a && Date.now() - a.at < 200000);
  }

  /** Exactly one window wins the right to ask the user. */
  claim(id) {
    try {
      fs.writeFileSync(path.join(this.approvalsDir, `${id}.claim`), String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }

  answer(id, allow) {
    this._write(path.join(this.approvalsDir, `${id}.answer.json`), { allow: !!allow, by: process.pid, at: Date.now() });
  }

  readAnswer(id) {
    return this._read(path.join(this.approvalsDir, `${id}.answer.json`));
  }

  clearApproval(id) {
    for (const suffix of ['.json', '.claim', '.answer.json']) fs.rmSync(path.join(this.approvalsDir, `${id}${suffix}`), { force: true });
  }
}

module.exports = { SharedState };
