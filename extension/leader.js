'use strict';
// Leader election across VS Code windows (each window has its own extension host process):
// exactly one window runs the relay + tunnel; the others stand by and take over when it exits.
const fs = require('fs');
const path = require('path');

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

class Leader {
  constructor(dir, label) {
    this.file = path.join(dir, 'leader.json');
    this.takeoverFile = path.join(dir, 'takeover.json');
    this.label = label;
    this.held = false;
  }

  holder() {
    try {
      const h = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return h && alive(h.pid) ? h : null;
    } catch {
      return null;
    }
  }

  acquire() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.file, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, since: Date.now(), label: this.label }));
        fs.closeSync(fd);
        this.held = true;
        return { ok: true };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const h = this.holder();
        if (h && h.pid === process.pid) {
          // Handed over to this window by the previous leader (see handOver).
          this.held = true;
          return { ok: true };
        }
        if (h) return { ok: false, holder: h };
        try {
          fs.unlinkSync(this.file);
        } catch {
          /* raced with another window */
        }
      }
    }
    const h = this.holder();
    return h && h.pid === process.pid ? ((this.held = true), { ok: true }) : { ok: false, holder: h };
  }

  release() {
    if (!this.held) return;
    this.held = false;
    try {
      const h = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (h.pid === process.pid) fs.unlinkSync(this.file);
    } catch {
      /* ignore */
    }
  }

  /**
   * Passes the lock straight to the window that asked to take over, so no other window can grab it
   * in the gap between this window letting go and that one starting.
   */
  handOver(to) {
    if (!this.held) return;
    this.held = false;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const h = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (h.pid !== process.pid) return;
      fs.writeFileSync(tmp, JSON.stringify({ pid: to.pid, since: Date.now(), label: to.label || 'another window' }));
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, this.file);
          return;
        } catch (err) {
          // Windows refuses to replace a file another window is reading at that instant.
          if (i >= 20) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      this.held = true;
      this.release();
    }
  }

  requestTakeover() {
    fs.writeFileSync(this.takeoverFile, JSON.stringify({ pid: process.pid, label: this.label, at: Date.now() }));
  }

  /** For the current leader: the window ({pid, label}) that asked to take over, if any. */
  pendingTakeover() {
    try {
      const t = JSON.parse(fs.readFileSync(this.takeoverFile, 'utf8'));
      if (t.pid !== process.pid && alive(t.pid) && Date.now() - t.at < 60000) return { pid: t.pid, label: t.label };
    } catch {
      /* none */
    }
    return null;
  }

  clearTakeover() {
    try {
      fs.unlinkSync(this.takeoverFile);
    } catch {
      /* ignore */
    }
  }
}

module.exports = { Leader, alive };
