'use strict';
// Manages a Cloudflare quick tunnel (free, no account) that exposes the local relay over HTTPS.
// cloudflared is taken from settings/PATH or downloaded once from the official GitHub release,
// verified against the SHA-256 digest GitHub publishes for the release asset.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
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
        // Its own folder as working directory: it must never hold another folder (e.g. an install) in use.
        proc = spawn(this.binary, args, { cwd: this.o.storageDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (!this.kept) await new Promise((r) => setTimeout(r, 8000));
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

/**
 * A quick tunnel that outlives the process that started it. cloudflared runs detached and is found
 * again through tunnel.json and its local metrics endpoint, so the public address stays the same when
 * another process takes over the relay on the same local port (the GitHub Copilot app's hub moves
 * between chats as they are closed or deleted, and restarts with the app).
 *
 * It is watched. After the PC was offline or asleep, cloudflared can keep running without a working
 * tunnel: it still reports its address, but has no connection to Cloudflare and may never get one
 * again. A tunnel that ends, or that stays without a connection, is replaced once the PC is online
 * again, and the new address goes out through the auto-reconnect gist. The old tunnel keeps its
 * chance (and its address, which devices without the gist need) until the new one works.
 */
class PersistentTunnel extends TunnelManager {
  constructor(o) {
    super(o);
    this.stateFile = path.join(o.storageDir, 'tunnel.json');
    this.running = null;
    this.opening = null;
    this.now = o.now || Date.now;
    // checkMs: how often the tunnel is checked. lostMs: how long it may be without a connection before
    // a new one is opened next to it. graceMs: how much longer the old one gets once the new one works.
    // openMs: how long cloudflared gets to connect. retryMs: the waits after a tunnel didn't open.
    // trustMs: connected this long, a tunnel counts as reachable even if this PC can't reach it.
    this.timing = { checkMs: 15000, lostMs: 120000, graceMs: 20000, openMs: 60000, retryMs: [15000, 30000, 60000, 120000], trustMs: 30000, ...o.timing };
    this.lostSince = null;
    this.nextTry = 0;
    this.tries = 0;
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  saved() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  _save(s) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(s));
  }

  async _hostname(metricsPort) {
    try {
      const res = await this.fetch(`http://127.0.0.1:${metricsPort}/quicktunnel`, { signal: AbortSignal.timeout(2500) });
      return res.ok ? (await res.json())?.hostname || null : null;
    } catch {
      return null;
    }
  }

  /** cloudflared has a connection to Cloudflare, so the tunnel works (its /ready metrics endpoint). */
  async _ready(s) {
    try {
      const res = await this.fetch(`http://127.0.0.1:${s.metricsPort}/ready`, { signal: AbortSignal.timeout(2500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  _isRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  async _alive(s) {
    if (!s?.pid || !s.metricsPort || !this._isRunning(s.pid)) return false;
    return !!(await this._hostname(s.metricsPort));
  }

  /** The local port a still-running tunnel forwards to (listen there to keep its address), or 0. */
  async adoptablePort() {
    const s = this.saved();
    return s && (await this._alive(s)) ? s.port : 0;
  }

  async start(port, binary) {
    this.port = port;
    this.binary = binary;
    this.stopping = false;
    this.lostSince = null;
    let s = this.saved();
    if (s?.next) {
      // A tunnel that was opening to replace this one when the process watching them ended.
      await this._end(s.next);
      const { next, ...rest } = s;
      s = rest;
      this._save(s);
    }
    if (s && s.port === port && (await this._alive(s))) {
      this.running = s;
      this.kept = true;
      this.url = `https://${await this._hostname(s.metricsPort)}`;
      this.log('info', `Kept the running tunnel ${this.url} (cloudflared pid ${s.pid})`);
      this._setState('online');
      this._watch();
      this.emit('url', this.url);
      return this.url;
    }
    if (s) await this._end(s);
    return this._spawnDetached();
  }

  /** Opens a new tunnel. If it doesn't open (offline?), it is tried again in the background. */
  async _spawnDetached() {
    this.url = null;
    this.kept = false;
    this._setState('starting');
    try {
      this._adopt(await this._open());
      return this.url;
    } catch (err) {
      if (!this.stopping) {
        this._failed(err);
        this._setState('error', err.message);
        this._watch();
      }
      throw err;
    }
  }

  _spawnCloudflared(args, cwd) {
    return spawn(this.binary, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
  }

  /**
   * Starts cloudflared for a new quick tunnel and waits until it's connected to Cloudflare. It's in
   * tunnel.json from the start (as the tunnel, or as `next` while it replaces `replacing`), so a
   * process that ends meanwhile doesn't leave it running unnoticed.
   */
  async _open(replacing = null) {
    const dir = this.o.storageDir;
    fs.mkdirSync(dir, { recursive: true });
    const emptyConfig = path.join(dir, 'cloudflared-empty.yml');
    if (!fs.existsSync(emptyConfig)) fs.writeFileSync(emptyConfig, '# Pocket Pilot: isolates the quick tunnel from ~/.cloudflared/config.yml\n');
    const metricsPort = await freePort();
    // No pipes: a detached cloudflared writing to the pipe of a process that ended would be stopped.
    const args = ['tunnel', '--no-autoupdate', '--config', emptyConfig, '--metrics', `127.0.0.1:${metricsPort}`, '--loglevel', 'warn', '--logfile', path.join(dir, 'cloudflared.log'), '--url', `http://127.0.0.1:${this.port}`];
    const proc = this._spawnCloudflared(args, dir);
    let failed = null;
    proc.on('error', (err) => {
      failed = err;
    });
    proc.on('exit', (code) => {
      failed = failed || new Error(`cloudflared exited (${code})`);
    });
    proc.unref();
    const s = { pid: proc.pid, port: this.port, metricsPort, startedAt: Date.now() };
    this.opening = s;
    if (proc.pid) this._save(replacing ? { ...replacing, next: s } : s);
    try {
      for (const end = this.now() + this.timing.openMs; this.now() < end && !failed && !this.stopping;) {
        await this._sleep(500);
        const host = await this._hostname(metricsPort);
        if (host && (await this._ready(s))) return { s, host };
      }
    } finally {
      this.opening = null;
    }
    await this._end(s);
    if (replacing && this.running === replacing) this._save(replacing);
    throw new Error(failed ? failed.message : this.stopping ? 'stopped' : 'cloudflared did not open the tunnel in time');
  }

  /** Makes a newly opened tunnel the running one and tells everyone its address. */
  _adopt({ s, host }) {
    this.running = s;
    this.kept = false;
    this.url = `https://${host}`;
    this.restarts = 0;
    this.tries = 0;
    this.nextTry = 0;
    this.lostSince = null;
    this._save(s);
    this.log('info', `Tunnel URL: ${this.url} (cloudflared pid ${s.pid})`);
    this._setState('online');
    this._watch();
    this.emit('url', this.url);
  }

  /** A new tunnel didn't open (offline?): try again a little later, then less often. */
  _failed(err) {
    const waits = this.timing.retryMs;
    const wait = waits[Math.min(this.tries, waits.length - 1)];
    this.tries++;
    this.nextTry = this.now() + wait;
    this.log('warn', `Could not open a tunnel (${err.message}); trying again in ${Math.round(wait / 1000)}s`);
  }

  _watch() {
    clearInterval(this._watchTimer);
    this._watchTimer = setInterval(() => this._check().catch((err) => this.log('warn', `Tunnel check failed: ${err.message}`)), this.timing.checkMs);
    this._watchTimer.unref?.();
  }

  /** One look at the tunnel: is cloudflared running, and connected to Cloudflare? */
  async _check() {
    if (this.stopping || this._checking) return;
    this._checking = true;
    try {
      const s = this.running;
      if (!s) {
        // No tunnel since the last one ended or didn't open: keep trying.
        if (this.now() >= this.nextTry) await this._reopen();
        return;
      }
      if (!(await this._alive(s))) {
        this.running = null;
        if (this.saved()?.pid === s.pid) fs.rmSync(this.stateFile, { force: true });
        this.restarts++;
        this.log('warn', 'The tunnel stopped; opening a new one');
        this._setState('error', 'The tunnel stopped. Opening a new one…');
        await this._reopen();
        return;
      }
      if (await this._ready(s)) {
        if (this.lostSince) this.log('info', `The tunnel is connected again (${this.url})`);
        this.lostSince = null;
        this.tries = 0;
        this.nextTry = 0;
        if (this.state !== 'online') this._setState('online');
        return;
      }
      // cloudflared runs, but without a connection to Cloudflare: offline, asleep, or the tunnel is gone.
      if (!this.lostSince) {
        this.lostSince = this.now();
        this.log('warn', `The tunnel lost its connection to Cloudflare (${this.url})`);
        this._setState('error', 'No connection to Cloudflare. Reconnecting…');
      }
      if (this.now() - this.lostSince >= this.timing.lostMs && this.now() >= this.nextTry) await this._replace(s);
    } finally {
      this._checking = false;
    }
  }

  async _reopen() {
    try {
      this._adopt(await this._open());
    } catch (err) {
      if (this.stopping) return;
      this._failed(err);
      this._setState('error', 'No tunnel: Cloudflare is out of reach. Trying again…');
    }
  }

  /**
   * Opens a new tunnel next to one that lost its connection. The PC is online again if it opens: the
   * old tunnel then gets a little longer to come back with its address, or the new one takes over.
   */
  async _replace(old) {
    let next;
    try {
      next = await this._open(old);
    } catch (err) {
      // Still offline: the old tunnel may yet come back.
      if (!this.stopping) this._failed(err);
      return;
    }
    for (const end = this.now() + this.timing.graceMs; ;) {
      if (this.stopping || this.running !== old) {
        await this._end(next.s);
        return;
      }
      if (await this._ready(old)) {
        await this._end(next.s);
        if (this.saved()?.next) this._save(old);
        this.lostSince = null;
        this.tries = 0;
        this.log('info', `The tunnel is connected again (${this.url})`);
        this._setState('online');
        return;
      }
      if (this.now() >= end) break;
      await this._sleep(2000);
    }
    this.log('warn', `The tunnel ${this.url} did not come back; using a new one`);
    await this._end(old);
    this._adopt(next);
  }

  /**
   * Waits until the relay answers through Cloudflare. This PC may be unable to reach its own address
   * while devices can (a DNS answer cached before the address existed, a VPN, a network filter): a
   * tunnel that has been connected to Cloudflare for a while (trustMs) counts as reachable too.
   */
  async waitReachable(timeoutMs = 90000) {
    const url = this.url;
    const deadline = this.now() + timeoutMs;
    // Probing a brand-new hostname too early can get NXDOMAIN negatively cached by the OS resolver.
    if (!this.kept) await this._sleep(8000);
    let lastErr;
    let connectedSince = null;
    for (;;) {
      if (!url || this.url !== url) throw new Error('The tunnel address changed');
      try {
        const res = await this.fetch(`${url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (res.ok) return true;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (this.running && (await this._ready(this.running))) {
        connectedSince ??= this.now();
        if (this.now() - connectedSince >= this.timing.trustMs) {
          this.log('warn', `This PC can't reach ${url} (${lastErr?.cause?.code || lastErr?.message || 'no answer'}), but the tunnel is connected to Cloudflare, so your devices can`);
          return true;
        }
      } else {
        connectedSince = null;
      }
      if (this.now() >= deadline) break;
      await this._sleep(1500);
    }
    throw new Error(`Tunnel not reachable yet: ${lastErr?.cause?.code || lastErr?.message || 'unknown error'}`);
  }

  async _kill(pid) {
    if (pid && /cloudflared/i.test(await processName(pid))) process.kill(pid);
  }

  async _end(s) {
    try {
      await this._kill(s?.pid);
    } catch {
      /* already gone */
    }
    if (s && this.saved()?.pid === s.pid) fs.rmSync(this.stateFile, { force: true });
  }

  /** keep: leave cloudflared running for whichever process runs the relay next (same address). */
  async stop({ keep = false } = {}) {
    this.stopping = true;
    clearInterval(this._watchTimer);
    const s = this.running;
    this.running = null;
    this.url = null;
    if (this.opening) await this._end(this.opening);
    if (!keep && s) await this._end(s);
    const saved = this.saved();
    if (keep && saved?.next) {
      const { next, ...rest } = saved;
      this._save(rest);
    }
    this._setState('stopped');
  }

  /** Ends a tunnel that an earlier process left running (turning remote access off with no hub around). */
  static async end(storageDir) {
    const t = new PersistentTunnel({ storageDir });
    const s = t.saved();
    if (s?.next) await t._end(s.next);
    if (s) await t._end(s);
  }
}

module.exports = { TunnelManager, PersistentTunnel, assetName, extractFromTgz };
