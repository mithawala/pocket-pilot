'use strict';
// Manages a Cloudflare quick tunnel (free, no account) that exposes the local relay over HTTPS.
// cloudflared is taken from settings/PATH or downloaded once from the official GitHub release,
// verified against the SHA-256 digest GitHub publishes for the release asset.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';

function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  const a = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch] || 'amd64';
  return `cloudflared-linux-${a}`;
}

function exeName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function findOnPath() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, exeName());
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** Extracts one file from a .tgz buffer (ustar). */
function extractFromTgz(buf, wanted) {
  const tar = zlib.gunzipSync(buf);
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const start = off + 512;
    if (path.posix.basename(name) === wanted) return tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not found in archive`);
}

function processName(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => resolve(err ? '' : String(out)));
    } else {
      execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, out) => resolve(err ? '' : String(out)));
    }
  });
}

class TunnelManager extends EventEmitter {
  /**
   * @param {{storageDir:string, log?:(l:string,m:string)=>void, fetchImpl?:typeof fetch, configuredPath?:()=>string}} o
   */
  constructor(o) {
    super();
    this.o = o;
    this.log = o.log || (() => {});
    this.fetch = o.fetchImpl || fetch;
    this.binDir = path.join(o.storageDir, 'bin');
    this.pidFile = path.join(o.storageDir, 'cloudflared.pid');
    this.proc = null;
    this.url = null;
    this.state = 'stopped';
    this.error = null;
    this.stopping = false;
    this.restarts = 0;
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state', { state, url: this.url, error });
  }

  downloadedBinary() {
    const p = path.join(this.binDir, exeName());
    return fs.existsSync(p) ? p : null;
  }

  /** Returns a usable cloudflared path, or null if it must be downloaded first. */
  findBinary() {
    const configured = this.o.configuredPath && this.o.configuredPath();
    if (configured) return fs.existsSync(configured) ? configured : null;
    return findOnPath() || this.downloadedBinary();
  }

  async download(onProgress = () => {}) {
    const name = assetName();
    onProgress('Looking up the latest cloudflared release…');
    const relRes = await this.fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pocket-pilot' } });
    if (!relRes.ok) throw new Error(`GitHub release lookup failed (${relRes.status})`);
    const rel = await relRes.json();
    const asset = (rel.assets || []).find((a) => a.name === name);
    if (!asset) throw new Error(`No cloudflared build named ${name} in ${rel.tag_name}`);
    onProgress(`Downloading cloudflared ${rel.tag_name} (${Math.round(asset.size / 1e6)} MB)…`);
    const res = await this.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'pocket-pilot' } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null;
    if (expected && expected !== actual) throw new Error('cloudflared checksum mismatch — download rejected');
    if (!expected) this.log('warn', 'GitHub did not publish a digest for cloudflared; relying on HTTPS integrity');
    const bin = name.endsWith('.tgz') ? extractFromTgz(buf, 'cloudflared') : buf;
    fs.mkdirSync(this.binDir, { recursive: true });
    const dest = path.join(this.binDir, exeName());
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bin, { mode: 0o755 });
    fs.renameSync(tmp, dest);
    fs.writeFileSync(path.join(this.binDir, 'version.json'), JSON.stringify({ version: rel.tag_name, asset: name, sha256: actual, verified: !!expected }));
    this.log('info', `Installed cloudflared ${rel.tag_name} (sha256 ${actual.slice(0, 12)}…, ${expected ? 'verified' : 'unverified'})`);
    return dest;
  }

  async _killStale() {
    let pid;
    try {
      pid = Number(fs.readFileSync(this.pidFile, 'utf8'));
    } catch {
      return;
    }
    if (!pid) return;
    const name = await processName(pid);
    if (/cloudflared/i.test(name)) {
      try {
        process.kill(pid);
        this.log('info', `Stopped a leftover cloudflared process (pid ${pid})`);
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(this.pidFile, { force: true });
  }

  /** Starts (or restarts) the quick tunnel for http://127.0.0.1:<port>. Resolves with the public URL. */
  async start(port, binary) {
    this.port = port;
    this.binary = binary;
    this.stopping = false;
    await this._killStale();
    return this._spawn();
  }

  _spawn() {
    return new Promise((resolve, reject) => {
      this.url = null;
      this._setState('starting');
      const emptyConfig = path.join(this.o.storageDir, 'cloudflared-empty.yml');
      try {
        fs.mkdirSync(this.o.storageDir, { recursive: true });
        if (!fs.existsSync(emptyConfig)) fs.writeFileSync(emptyConfig, '# Pocket Pilot: isolates the quick tunnel from ~/.cloudflared/config.yml\n');
      } catch {
        /* ignore */
      }
      const args = ['tunnel', '--no-autoupdate', '--config', emptyConfig, '--url', `http://127.0.0.1:${this.port}`];
      let proc;
      try {
        proc = spawn(this.binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        this._setState('error', err.message);
        reject(err);
        return;
      }
      this.proc = proc;
      try {
        fs.writeFileSync(this.pidFile, String(proc.pid));
      } catch {
        /* ignore */
      }
      let settled = false;
      const lines = [];
      const onLine = (line) => {
        lines.push(line);
        if (lines.length > 50) lines.shift();
        const m = URL_RE.exec(line);
        if (m && !this.url) {
          this.url = m[0];
          this.log('info', `Tunnel URL: ${this.url}`);
        }
        if (/Registered tunnel connection/i.test(line) && this.url && !settled) {
          settled = true;
          this.restarts = 0;
          this._setState('online');
          this.emit('url', this.url);
          resolve(this.url);
        }
        if (/failed to request quick Tunnel|429 Too Many Requests/i.test(line)) this.log('warn', `cloudflared: ${line}`);
      };
      const split = (stream) => {
        let buf = '';
        stream.on('data', (d) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            onLine(buf.slice(0, i).trim());
            buf = buf.slice(i + 1);
          }
        });
      };
      split(proc.stdout);
      split(proc.stderr);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const msg = this.url ? 'Tunnel did not become ready in time' : 'cloudflared did not report a tunnel URL';
          this._setState('error', msg);
          reject(new Error(`${msg}. Last output: ${lines.slice(-3).join(' | ')}`));
          proc.kill();
        }
      }, 45000);
      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this._setState('error', err.message);
          reject(err);
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc === proc) this.proc = null;
        fs.rmSync(this.pidFile, { force: true });
        if (!settled) {
          settled = true;
          this._setState('error', `cloudflared exited (${code})`);
          reject(new Error(`cloudflared exited with code ${code}: ${lines.slice(-3).join(' | ')}`));
          return;
        }
        if (this.stopping) {
          this._setState('stopped');
          return;
        }
        this.restarts++;
        const delay = Math.min(60000, 2000 * 2 ** Math.min(this.restarts, 5));
        this.log('warn', `cloudflared exited (${code}); restarting in ${Math.round(delay / 1000)}s`);
        this._setState('error', 'Tunnel dropped, reconnecting…');
        this._restartTimer = setTimeout(() => this._spawn().catch((err) => this.log('error', err.message)), delay);
      });
    });
  }

  /** Polls the public URL until the relay answers through Cloudflare. */
  async waitReachable(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    // Probing a brand-new hostname too early can get NXDOMAIN negatively cached by the OS resolver.
    await new Promise((r) => setTimeout(r, 8000));
    while (Date.now() < deadline) {
      if (!this.url) throw new Error('No tunnel URL');
      try {
        const res = await this.fetch(`${this.url}/health`, { cache: 'no-store' });
        if (res.ok) return true;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Tunnel not reachable yet: ${lastErr?.message || 'unknown error'}`);
  }

  async restart() {
    await this.stop();
    return this.start(this.port, this.binary);
  }

  stop() {
    this.stopping = true;
    clearTimeout(this._restartTimer);
    const proc = this.proc;
    this.proc = null;
    this.url = null;
    if (!proc) {
      this._setState('stopped');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        proc.kill();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }
}

module.exports = { TunnelManager, assetName, extractFromTgz };
