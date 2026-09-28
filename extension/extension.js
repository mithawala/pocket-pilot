'use strict';
const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { RelayServer } = require('./core/relay');
const { DeviceStore } = require('./core/store');
const identityLib = require('./core/identity');
const agentHost = require('./core/agentHost');
const { cmpVersion } = agentHost;
const { SessionMonitor } = require('./core/monitor');
const { TunnelManager } = require('./core/tunnel');
const { GistRendezvous } = require('./core/rendezvous');
const { SharedState } = require('./shared');
const push = require('./core/push');
const { Leader } = require('./leader');
const { SidebarProvider, renderQrSvg } = require('./sidebar');

const STATE_ENABLED = 'pocketPilot.enabled';
const STATE_CLOUDFLARED_OK = 'pocketPilot.cloudflaredConsent';
const STATE_RDV_ASKED = 'pocketPilot.rendezvousAsked';
const STATE_UPDATE_NOTIFIED = 'pocketPilot.updateNotified';
const PUSH_SUBJECT = 'mailto:pocket-pilot@users.noreply.github.com';
const EXTENSION_ID = 'mithawala.pocket-pilot';
const REPO = 'mithawala/pocket-pilot';

function settings() {
  const c = vscode.workspace.getConfiguration('pocketPilot');
  return {
    autoStart: c.get('autoStart', true),
    pwaUrl: String(c.get('pwaUrl', '') || '').trim(),
    extraAllowedOrigins: c.get('extraAllowedOrigins', []) || [],
    tunnelMode: c.get('tunnel.mode', 'quick'),
    customUrl: String(c.get('tunnel.customUrl', '') || '').trim().replace(/\/+$/, ''),
    cloudflaredPath: String(c.get('tunnel.cloudflaredPath', '') || '').trim(),
    port: Number(c.get('port', 0)) || 0,
    requireApproval: c.get('security.requireApproval', true),
    passkey: c.get('security.passkey', 'required'),
    passkeyGraceHours: Number(c.get('security.passkeyGraceHours', 12)),
    pairingCodeMinutes: Math.min(60, Math.max(1, Number(c.get('security.pairingCodeMinutes', 10)) || 10)),
    rendezvous: c.get('rendezvous.enabled', true),
    notifyInput: c.get('notifications.inputNeeded', true),
    notifyDone: c.get('notifications.finished', true),
    notifyErrors: c.get('notifications.errors', true),
    skipWhileActive: c.get('notifications.skipWhileActive', true),
    uploadsFolder: String(c.get('uploads.folder', '.pocket-pilot/uploads') || '.pocket-pilot/uploads'),
  };
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

class PocketPilotService {
  constructor(context) {
    this.ctx = context;
    this.log = vscode.window.createOutputChannel('Pocket Pilot', { log: true });
    this.storageDir = context.globalStorageUri.fsPath;
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.userData = agentHost.userDataFromGlobalStorage(this.storageDir);
    this.state = 'stopped';
    this.error = null;
    this.relay = null;
    this.publicUrl = null;
    this.tunnelReachable = false;
    this.pairing = null;
    this.standby = null;
    this.lastNotified = new Map();
    this.store = new DeviceStore(path.join(this.storageDir, 'devices.json'), { watch: true });
    this.leader = new Leader(this.storageDir, vscode.workspace.name || 'VS Code');
    this.shared = new SharedState(this.storageDir);
    this.mirror = null;
    this._mirrorAt = 0;
    this._published = 0;
    this._asking = new Set();
    this._changed = new vscode.EventEmitter();
    this.onDidChange = this._changed.event;
    this._changeTimer = null;
    this._disposables = [];
  }

  logLine(level, msg) {
    const fn = { info: 'info', warn: 'warn', error: 'error', debug: 'debug' }[level] || 'info';
    this.log[fn](msg);
  }

  changed() {
    clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => {
      this._changed.fire();
      this._updateStatusBar();
      if (this.state === 'running') this._publishMirror();
    }, 60);
  }

  async init() {
    const ctx = this.ctx;
    this.sidebar = new SidebarProvider(this, ctx.extensionUri);
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('pocketPilot.panel', this.sidebar, { webviewOptions: { retainContextWhenHidden: true } }));
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBar.command = 'pocketPilot.focus';
    ctx.subscriptions.push(this.statusBar, this.log, this._changed);

    const cmd = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, (...a) => Promise.resolve(fn(...a)).catch((err) => this._showError(err))));
    cmd('pocketPilot.start', () => this.start({ interactive: true }));
    cmd('pocketPilot.stop', () => this.stop());
    cmd('pocketPilot.pair', () => this.showPairing());
    cmd('pocketPilot.focus', () => vscode.commands.executeCommand('pocketPilot.panel.focus'));
    cmd('pocketPilot.copyPairingLink', () => this.copyPairingLink());
    cmd('pocketPilot.restartTunnel', () => this.restartTunnel());
    cmd('pocketPilot.removeDevice', (id) => this.removeDevice(id));
    cmd('pocketPilot.removeAllDevices', () => this.removeAllDevices());
    cmd('pocketPilot.resetIdentity', () => this.resetIdentity());
    cmd('pocketPilot.signInRendezvous', () => this.enableRendezvous());
    cmd('pocketPilot.takeOver', () => this.takeOver());
    cmd('pocketPilot.openLocalPwa', () => this.openLocalPwa());
    cmd('pocketPilot.showLogs', () => this.log.show());
    cmd('pocketPilot.checkForUpdates', () => this.checkForUpdate({ quiet: false }));
    cmd('pocketPilot.installUpdate', () => this.installUpdate());
    const updateCheck = () => this.checkForUpdate().catch((err) => this.logLine('warn', `Update check failed: ${err.message}`));
    this._updateTimers = [setTimeout(updateCheck, 20000), setInterval(updateCheck, 12 * 3600 * 1000)];
    for (const t of this._updateTimers) t.unref?.();
    cmd('pocketPilot.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mithawala.pocket-pilot'));

    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pocketPilot')) this._onConfigChanged(e);
    }));
    // vscode://mithawala.pocket-pilot/start | /pair | /stop
    ctx.subscriptions.push(vscode.window.registerUriHandler({
      handleUri: (uri) => {
        const action = uri.path.replace(/^\/+/, '');
        const run = { start: () => this.start({ interactive: true }), pair: () => this.showPairing(), stop: () => this.stop() }[action];
        Promise.resolve(run ? run() : vscode.commands.executeCommand('pocketPilot.panel.focus')).catch((err) => this._showError(err));
      },
    }));
    this.store.on('change', () => this.changed());
    // Devices removed here or in another VS Code window lose their live connections at once.
    this.store.on('removed', (ids) => {
      for (const id of ids) this.relay?.revokeDevice(id);
    });

    // Host keys are loaded (or created) only by the window that wins leadership, in start():
    // several windows activating at once must never race to create different identities.
    this.identity = null;
    this.rendezvous = null;
    this.monitor = new SessionMonitor({ getEndpoint: () => this.endpoint(), log: (l, m) => this.logLine(l, m) });
    this.monitor.on('sessions', () => this.changed());
    this.monitor.on('status', () => this.changed());
    this.monitor.on('effective', ({ uri, status }) => this.relay?.pushSummaryChange(uri, { status }));
    this.monitor.on('transition', (t) => this._notify(t).catch((err) => this.logLine('warn', `Notification failed: ${err.message}`)));
    this.tunnel = new TunnelManager({ storageDir: this.storageDir, log: (l, m) => this.logLine(l, m), configuredPath: () => settings().cloudflaredPath });
    this.tunnel.on('state', () => this.changed());
    this.tunnel.on('url', (url) => this._onPublicUrl(url));

    this.logLine('info', `Pocket Pilot ready; agent host: ${agentHost.describeEndpoint(this.endpoint())}`);
    this._updateStatusBar();
    // Every window follows the one that runs Pocket Pilot (and takes over when it closes).
    this._sharedTimer = setInterval(() => this._pollShared(), 1500);
    this._sharedTimer.unref?.();
    ctx.subscriptions.push(vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) this._checkApprovals();
    }));
    const holder = this.leader.holder();
    if (holder && holder.pid !== process.pid) this._pollShared();
    else if ((ctx.globalState.get(STATE_ENABLED, false) || this.shared.enabled()) && settings().autoStart) {
      this.start({ interactive: false }).catch((err) => this.logLine('warn', `Auto-start failed: ${err.message}`));
    }
  }

  /** Loads the persistent host secrets. Only called while holding the leader lock. */
  async _loadSecrets() {
    const secrets = this.ctx.secrets;
    this.identity = await identityLib.loadHostIdentity(secrets, os.hostname());
    this.vapid = await identityLib.loadVapid(secrets);
    const rdvKey = await identityLib.loadRendezvousKey(secrets);
    this.rendezvous = new GistRendezvous({
      getToken: (interactive) => this._githubToken(['gist'], interactive),
      stateFile: path.join(this.storageDir, 'rendezvous.json'),
      hostId: this.identity.hostId,
      key: rdvKey,
      log: (l, m) => this.logLine(l, m),
    });
    this.logLine('info', `Host "${this.identity.name}" fingerprint ${identityLib.fingerprintText(this.identity.fingerprint)}`);
  }

  endpoint() {
    return agentHost.selectEndpoint(this.userData);
  }

  // ------------------------------------------------------------------ lifecycle

  async start({ interactive = true } = {}) {
    if (this.state === 'running' || this.state === 'starting') {
      if (interactive) this.showPairing();
      return;
    }
    const lead = this.leader.acquire();
    if (!lead.ok) {
      // Another window runs Pocket Pilot: this one mirrors it (same QR code, phones and buttons).
      this.state = 'standby';
      this.standby = lead.holder;
      this._pollShared();
      this.changed();
      if (interactive) await this.showPairing();
      return;
    }
    this.state = 'starting';
    this.error = null;
    this.standby = null;
    this.changed();
    try {
      if (!this.endpoint()) this.logLine('warn', 'The VS Code agent host endpoint was not found yet; phones will see sessions once it starts.');
      await this._loadSecrets();
      await this._startRelay();
      this.monitor.start();
      await this._startTunnel(interactive);
      await this._checkPwaUrl();
      this._pwaTimer = setInterval(() => {
        if (this.pwaFallback) this._checkPwaUrl();
      }, 10 * 60 * 1000);
      this.state = 'running';
      await this.ctx.globalState.update(STATE_ENABLED, true);
      this.shared.setEnabled(true);
      vscode.commands.executeCommand('setContext', 'pocketPilot.running', true);
      this._leaderTimer = setInterval(() => this._checkTakeover(), 3000);
      if (interactive && settings().rendezvous) this._maybeAskRendezvous();
      await this.newPairingCode();
      this.logLine('info', `Remote access is on (${this.publicUrl || `local port ${this.relay.port}`})`);
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      this.logLine('error', `Start failed: ${err.message}`);
      await this._teardown();
      this.leader.release();
      if (interactive) this._showError(err);
    }
    this.changed();
  }

  async stop({ remember = true, handOverTo = null } = {}) {
    if (this.state === 'standby') {
      // Stopping from any window stops Pocket Pilot everywhere.
      this.shared.setEnabled(false);
      this.shared.request('stop');
      return;
    }
    // Before letting go of the lock: otherwise another window could see "enabled" with no leader and restart it.
    if (remember) this.shared.setEnabled(false);
    await this._teardown();
    this.state = 'stopped';
    if (handOverTo) this.leader.handOver(handOverTo);
    else this.leader.release();
    if (remember) await this.ctx.globalState.update(STATE_ENABLED, false);
    vscode.commands.executeCommand('setContext', 'pocketPilot.running', false);
    this.logLine('info', 'Remote access stopped');
    this.changed();
  }

  async _teardown() {
    clearInterval(this._leaderTimer);
    clearInterval(this._pwaTimer);
    clearTimeout(this._pairingTimer);
    this.shared.clearMirror();
    this.pairing = null;
    const relay = this.relay;
    this.relay = null;
    this.publicUrl = null;
    this.tunnelReachable = false;
    await Promise.allSettled([relay?.close(), this.tunnel?.stop()]);
    this.monitor?.stop();
  }

  async dispose() {
    clearInterval(this._sharedTimer);
    for (const t of this._updateTimers || []) clearTimeout(t);
    this.store.unwatch();
    await this._teardown();
    this.leader.release();
  }

  /** Keeps this window in step with the one that runs Pocket Pilot (runs every 1.5 s in every window). */
  _pollShared() {
    this._checkApprovals();
    if (this.state === 'running') {
      this._processRequests();
      if (Date.now() - this._published > 5000) this._publishMirror();
      return;
    }
    if (this.state === 'starting' || this._takingOver) return;
    const holder = this.leader.holder();
    if (holder && holder.pid !== process.pid) {
      if (this.state !== 'standby' || this.standby?.pid !== holder.pid) {
        this.state = 'standby';
        this.standby = holder;
        vscode.commands.executeCommand('setContext', 'pocketPilot.running', true);
        this.changed();
      }
      const m = this.shared.readMirror();
      const at = m?.pid === holder.pid ? m.at : 0;
      if (at !== this._mirrorAt) {
        this._mirrorAt = at;
        this.mirror = at ? m : null;
        this.changed();
      }
      return;
    }
    if (this.state === 'standby') {
      // The window that ran Pocket Pilot is gone (closed) or stopped it for everyone.
      this.state = 'stopped';
      this.standby = null;
      this.mirror = null;
      this._mirrorAt = 0;
      vscode.commands.executeCommand('setContext', 'pocketPilot.running', false);
      this.changed();
      if (this.shared.enabled() && settings().autoStart) {
        this.logLine('info', 'The Pocket Pilot window closed; taking over here');
        this.start({ interactive: false }).catch((err) => this.logLine('warn', `Take over failed: ${err.message}`));
      }
    }
  }

  _publishMirror() {
    this._published = Date.now();
    this.shared.writeMirror({ pid: process.pid, label: this.leader.label, at: this._published, view: this._ownViewState() });
  }

  /** Buttons pressed in other windows' panels. */
  _processRequests() {
    for (const r of this.shared.takeRequests()) {
      const run = {
        newCode: () => this.newPairingCode(),
        restartTunnel: () => this.restartTunnel(),
        stop: () => this.stop(),
        enableRendezvous: () => this.enableRendezvous({ silent: true }),
      }[r.action];
      if (run) Promise.resolve(run()).catch((err) => this.logLine('warn', `${r.action} from another window failed: ${err.message}`));
    }
  }

  _checkTakeover() {
    const to = this.leader.pendingTakeover();
    if (to) {
      this.leader.clearTakeover();
      this.logLine('info', `Another window (${to.label || `pid ${to.pid}`}) took over Pocket Pilot`);
      this.stop({ remember: false, handOverTo: to }).then(() => {
        this.state = 'standby';
        this.standby = { pid: to.pid, label: to.label || 'another window' };
        this.changed();
      });
    }
  }

  async takeOver() {
    if (this.state !== 'standby') return this.start({ interactive: true });
    this._takingOver = true;
    try {
      this.leader.requestTakeover();
      // The running window stops and hands its lock to this one.
      for (let i = 0; i < 20; i++) {
        const h = this.leader.holder();
        if (!h || h.pid === process.pid) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      this.state = 'stopped';
      this.mirror = null;
      await this.start({ interactive: true });
    } finally {
      this._takingOver = false;
    }
  }

  async _startRelay() {
    const pwaDir = path.join(this.ctx.extensionUri.fsPath, 'pwa');
    this.relay = new RelayServer({
      identity: this.identity,
      store: this.store,
      getAgentEndpoint: () => this.endpoint(),
      approveDevice: (info) => this._approve(info),
      allowedOrigins: () => this.allowedOrigins(),
      policy: () => {
        const s = settings();
        return { requireApproval: s.requireApproval, passkey: s.passkey, passkeyGraceHours: s.passkeyGraceHours };
      },
      welcomeExtras: () => ({ vapidPublicKey: this.vapid.publicKey, rendezvous: settings().rendezvous ? this.rendezvous.info() : null, pwaUrl: settings().pwaUrl || null }),
      isReadAllowed: (uri) => this._isReadAllowed(uri),
      adjustSummary: (s) => this.monitor.adjustSummary(s),
      saveUpload: (req) => this._saveUpload(req),
      pwaDir: fs.existsSync(pwaDir) ? pwaDir : undefined,
      tunnelRedirect: () => (settings().pwaUrl && !this.pwaFallback ? settings().pwaUrl : null),
      log: (l, m) => this.logLine(l, m),
    });
    this.relay.on('connections', () => this.changed());
    this.relay.on('paired', (d) => {
      vscode.window.showInformationMessage(`Pocket Pilot: "${d.name}" is paired${d.passkey ? ' and protected by a passkey' : ''}.`);
      this.changed();
    });
    this.relay.on('pairing-token-used', () => setTimeout(() => this.newPairingCode(), 1500));
    this.relay.on('push-test', (id) => this._sendTestPush(id));
    this.relay.on('device-removed', () => this.changed());
    await this.relay.listen(settings().port || 0, '127.0.0.1');
  }

  async _startTunnel(interactive) {
    const s = settings();
    if (s.tunnelMode === 'none') {
      this.publicUrl = null;
      return;
    }
    if (s.tunnelMode === 'custom') {
      if (!/^https:\/\/[^\s/]+/.test(s.customUrl)) throw new Error('Set "pocketPilot.tunnel.customUrl" to your public https:// URL, or switch the tunnel mode back to "quick".');
      this._onPublicUrl(s.customUrl);
      return;
    }
    let bin = this.tunnel.findBinary();
    if (!bin) {
      if (!this.ctx.globalState.get(STATE_CLOUDFLARED_OK, false)) {
        if (!interactive) throw new Error('cloudflared is not installed yet — start Pocket Pilot from the sidebar once.');
        const ok = await vscode.window.showInformationMessage(
          'Pocket Pilot uses the free Cloudflare quick tunnel so your phone, tablet or other computer can reach this PC from anywhere. Download the official cloudflared binary (about 55 MB) from github.com/cloudflare/cloudflared?',
          { modal: true, detail: 'The download is verified against the SHA-256 digest GitHub publishes. All traffic through the tunnel is end-to-end encrypted: Cloudflare cannot read it.' },
          'Download',
        );
        if (ok !== 'Download') throw new Error('cloudflared is needed for remote access (download declined).');
        await this.ctx.globalState.update(STATE_CLOUDFLARED_OK, true);
      }
      bin = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Pocket Pilot' }, (p) => this.tunnel.download((m) => p.report({ message: m })));
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Pocket Pilot: opening tunnel…' }, () => this.tunnel.start(this.relay.port, bin));
    this.tunnel.waitReachable().then(() => {
      this.tunnelReachable = true;
      this.changed();
    }).catch((err) => this.logLine('warn', err.message));
  }

  async restartTunnel() {
    if (this.state === 'standby') return this.shared.request('restartTunnel');
    if (this.state !== 'running') return this.start({ interactive: true });
    if (settings().tunnelMode !== 'quick') return;
    this.tunnelReachable = false;
    this.publicUrl = null;
    this.pairing = null;
    this.changed();
    await this.tunnel.restart();
  }

  _onPublicUrl(url) {
    this.publicUrl = url;
    this.tunnelReachable = false;
    if (settings().rendezvous) this.rendezvous.publish(url).then(() => this.changed());
    if (this.state === 'running') this.newPairingCode();
    this.changed();
  }

  async _onConfigChanged(e) {
    this.changed();
    if (this.state !== 'running') return;
    const restartKeys = ['pocketPilot.tunnel', 'pocketPilot.port'];
    if (restartKeys.some((k) => e.affectsConfiguration(k))) {
      const pick = await vscode.window.showInformationMessage('Pocket Pilot: restart remote access to apply the new tunnel settings?', 'Restart');
      if (pick) {
        await this.stop({ remember: false });
        await this.start({ interactive: true });
      }
    } else if (e.affectsConfiguration('pocketPilot.pwaUrl') || e.affectsConfiguration('pocketPilot.security.pairingCodeMinutes')) {
      await this._checkPwaUrl();
      await this.newPairingCode();
    } else if (e.affectsConfiguration('pocketPilot.rendezvous.enabled') && settings().rendezvous && this.publicUrl) {
      this.rendezvous.publish(this.publicUrl, { interactive: true }).then(() => this.changed());
    }
  }

  // ------------------------------------------------------------------ pairing

  allowedOrigins() {
    const s = settings();
    const out = new Set();
    const add = (u) => {
      try {
        out.add(new URL(u).origin);
      } catch {
        /* ignore invalid */
      }
    };
    if (s.pwaUrl) add(s.pwaUrl);
    for (const o of s.extraAllowedOrigins) add(o);
    if (this.relay) {
      out.add(`http://127.0.0.1:${this.relay.port}`);
      out.add(`http://localhost:${this.relay.port}`);
    }
    if (this.publicUrl && (!s.pwaUrl || this.pwaFallback)) add(this.publicUrl);
    return [...out];
  }

  /** True when the configured app URL is not reachable (e.g. not published yet). */
  async _checkPwaUrl() {
    const url = settings().pwaUrl;
    if (!url) {
      this.pwaFallback = false;
      return;
    }
    let ok = false;
    try {
      const res = await fetch(new URL('manifest.webmanifest', url.endsWith('/') ? url : `${url}/`), { cache: 'no-store', redirect: 'follow' });
      ok = res.ok;
    } catch {
      ok = false;
    }
    const was = this.pwaFallback;
    this.pwaFallback = !ok;
    if (this.pwaFallback && !was) this.logLine('warn', `The Pocket Pilot app is not reachable at ${url} yet; pairing links use the copy served through the tunnel until it is published.`);
    if (was && !this.pwaFallback) {
      this.logLine('info', `The Pocket Pilot app is live at ${url}`);
      await this.newPairingCode();
    }
    this.changed();
  }

  async newPairingCode() {
    if (this.state === 'standby') return this.shared.request('newCode');
    clearTimeout(this._pairingTimer);
    if (!this.relay || this.state === 'stopped') return;
    const s = settings();
    const connectUrl = this.publicUrl || (s.tunnelMode === 'none' ? `http://127.0.0.1:${this.relay.port}` : null);
    if (!connectUrl) {
      this.pairing = null;
      this.changed();
      return;
    }
    const sc = await identityLib.loadSecureChannel();
    const ttl = s.pairingCodeMinutes * 60 * 1000;
    const t = await this.relay.createPairingToken(ttl);
    const fragment = sc.encodePairingFragment({ url: connectUrl, token: t.token, hostFingerprint: this.identity.fingerprint, name: this.identity.name });
    const page = (s.pwaUrl && s.tunnelMode !== 'none' && !this.pwaFallback ? s.pwaUrl : `${connectUrl}/`).replace(/#.*$/, '');
    const link = `${page}#${fragment}`;
    this.pairing = { link, expiresAt: t.expiresAt, svg: renderQrSvg(link) };
    this._pairingTimer = setTimeout(() => this.newPairingCode(), ttl);
    this.changed();
  }

  async showPairing() {
    if (this.state === 'standby') {
      this.shared.request('newCode');
      await vscode.commands.executeCommand('pocketPilot.panel.focus');
      return;
    }
    if (this.state !== 'running') return this.start({ interactive: true });
    await this.newPairingCode();
    await vscode.commands.executeCommand('pocketPilot.panel.focus');
  }

  async copyPairingLink() {
    const pairing = this.state === 'standby' ? this.mirror?.view?.pairing : (this.pairing || (await this.newPairingCode(), this.pairing));
    if (!pairing?.link) throw new Error('Remote access is not running.');
    await vscode.env.clipboard.writeText(pairing.link);
    vscode.window.showInformationMessage('Pairing link copied. It works once and expires soon — open it only on your own device.');
  }

  /**
   * A phone asks to pair. The question appears in whichever VS Code window you are using (the first
   * focused window claims it); if no window is focused, this window asks.
   */
  async _approve(info) {
    const id = this.shared.postApproval(info);
    const claimBy = Date.now() + 4000;
    const until = Date.now() + 175000;
    this._checkApprovals();
    try {
      while (Date.now() < until) {
        const a = this.shared.readAnswer(id);
        if (a) return !!a.allow;
        if (Date.now() > claimBy && this.shared.claim(id)) {
          const allow = await this._askApproval(info);
          this.shared.answer(id, allow);
          return allow;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return false;
    } finally {
      this.shared.clearApproval(id);
    }
  }

  _checkApprovals() {
    if (!vscode.window.state.focused) return;
    for (const p of this.shared.pendingApprovals()) {
      if (this._asking.has(p.id) || !this.shared.claim(p.id)) continue;
      this._asking.add(p.id);
      this._askApproval(p.info)
        .then((allow) => this.shared.answer(p.id, allow))
        .catch(() => this.shared.answer(p.id, false))
        .finally(() => this._asking.delete(p.id));
    }
  }

  async _askApproval(info) {
    const where = [info.platform, info.ip && `from ${info.ip}`].filter(Boolean).join(' · ');
    const choice = await vscode.window.showWarningMessage(
      `Allow "${info.name}" to control your agent sessions?`,
      { modal: true, detail: `${where}\n\nThe device will be able to read your sessions, chat with the agents and approve their tool calls. Only allow this if you just scanned the QR code (or opened the pairing link) yourself.` },
      'Allow',
    );
    this.logLine('info', `Pairing request from "${info.name}" (${where}): ${choice === 'Allow' ? 'allowed' : 'declined'}`);
    return choice === 'Allow';
  }

  // ------------------------------------------------------------------ devices

  async removeDevice(id) {
    if (!id) {
      const devices = this.store.list();
      if (!devices.length) return vscode.window.showInformationMessage('No devices are paired.');
      const pick = await vscode.window.showQuickPick(devices.map((d) => ({ label: d.name, description: d.platform, detail: `Paired ${new Date(d.createdAt).toLocaleString()}`, id: d.id })), { placeHolder: 'Remove which device?' });
      if (!pick) return;
      id = pick.id;
    }
    const d = this.store.get(id);
    if (!d) return;
    const ok = await vscode.window.showWarningMessage(`Remove "${d.name}"? It will be disconnected immediately and must be paired again.`, { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
    this.store.remove(id);
    this.relay?.revokeDevice(id);
    this.logLine('info', `Removed device "${d.name}"`);
  }

  async removeAllDevices() {
    const n = this.store.list().length;
    if (!n) return;
    const ok = await vscode.window.showWarningMessage(`Remove all ${n} paired device(s)?`, { modal: true }, 'Remove all');
    if (ok !== 'Remove all') return;
    for (const d of this.store.list()) this.relay?.revokeDevice(d.id);
    this.store.clear();
  }

  async resetIdentity() {
    if (this.state === 'standby') throw new Error('Pocket Pilot runs in another VS Code window — reset it there (or move it to this window first).');
    const ok = await vscode.window.showWarningMessage('Reset the Pocket Pilot identity of this PC?', { modal: true, detail: 'All paired devices are removed and must scan a new QR code. Use this if you think a device or pairing code was compromised.' }, 'Reset');
    if (ok !== 'Reset') return;
    const wasRunning = this.state === 'running';
    await this.stop({ remember: false });
    this.store.clear();
    this.rendezvous?.forget();
    try {
      fs.rmSync(path.join(this.storageDir, 'rendezvous.json'), { force: true });
    } catch {
      /* ignore */
    }
    await identityLib.resetIdentity(this.ctx.secrets);
    this.identity = null;
    this.rendezvous = null;
    if (wasRunning) await this.start({ interactive: true });
    vscode.window.showInformationMessage('Pocket Pilot identity reset. Pair your devices again.');
  }

  // ------------------------------------------------------------------ GitHub auth (auto-reconnect gist only)

  async _githubToken(scopes, interactive, { pickAccount = false } = {}) {
    try {
      const opts = interactive ? { createIfNone: true, ...(pickAccount ? { clearSessionPreference: true } : {}) } : { silent: true };
      const s = await vscode.authentication.getSession('github', scopes, opts);
      return s ? s.accessToken : null;
    } catch (err) {
      if (interactive) this.logLine('warn', `GitHub sign-in (${scopes.join(' ')}) failed: ${err.message}`);
      return null;
    }
  }

  async enableRendezvous({ silent = false } = {}) {
    if (this.state === 'standby') {
      // Sign in here (VS Code shares the account with every window), then let the running window publish.
      const token = await this._githubToken(['gist'], true, { pickAccount: true });
      if (token) this.shared.request('enableRendezvous');
      return;
    }
    if (!this.rendezvous || this.state !== 'running') throw new Error('Start remote access first.');
    // Let the user pick (or add) the account: work accounts (Enterprise Managed Users) cannot create gists.
    const token = await this._githubToken(['gist'], !silent, { pickAccount: !silent });
    const ok = token && this.publicUrl ? await this.rendezvous.publish(this.publicUrl).catch(() => false) : !!token;
    if (!ok) vscode.window.showWarningMessage(`Auto-reconnect is not active: ${this.rendezvous.lastError || 'GitHub sign-in was cancelled.'}`, 'Try another account').then((p) => p && this.enableRendezvous());
    else vscode.window.showInformationMessage('Auto-reconnect is on. Paired devices get the gist details the next time they connect.');
    this.changed();
  }

  async _maybeAskRendezvous() {
    if (this.rendezvous.info() || this.ctx.globalState.get(STATE_RDV_ASKED, false)) return;
    await this.ctx.globalState.update(STATE_RDV_ASKED, true);
    const token = await this._githubToken(['gist'], false);
    if (token) return;
    const pick = await vscode.window.showInformationMessage(
      'Let your devices reconnect automatically after VS Code restarts? Pocket Pilot keeps the (changing) tunnel address in a secret GitHub gist, end-to-end encrypted so only your paired devices can read it.',
      'Enable (sign in to GitHub)',
      'Not now',
    );
    if (pick && pick.startsWith('Enable')) await this.enableRendezvous();
  }

  // ------------------------------------------------------------------ files

  _sessionDir(sessionUri) {
    const s = this.monitor.sessions.get(sessionUri);
    const dir = s?.workingDirectories?.[0];
    if (!dir) return null;
    try {
      return vscode.Uri.parse(dir).fsPath;
    } catch {
      return null;
    }
  }

  _isReadAllowed(uri) {
    let p;
    try {
      const u = vscode.Uri.parse(String(uri));
      if (u.scheme !== 'file') return false;
      p = u.fsPath;
    } catch {
      return false;
    }
    return this.monitor.workingDirectories().some((d) => {
      try {
        return isInside(p, vscode.Uri.parse(d).fsPath);
      } catch {
        return false;
      }
    });
  }

  async _saveUpload({ session, name, data }) {
    const base = this._sessionDir(session) || path.join(os.homedir(), 'Pocket Pilot');
    const rel = settings().uploadsFolder.replace(/^[\\/]+/, '');
    const folder = path.resolve(base, rel);
    if (!isInside(folder, base)) throw new Error('Invalid uploads folder setting');
    fs.mkdirSync(folder, { recursive: true });
    const top = path.join(base, rel.split(/[\\/]/)[0]);
    if (top.endsWith('.pocket-pilot') && !fs.existsSync(path.join(top, '.gitignore'))) fs.writeFileSync(path.join(top, '.gitignore'), '*\n');
    const safe = (name || 'upload').replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'upload';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(folder, `${stamp}-${safe}`);
    fs.writeFileSync(file, data, { flag: 'wx' });
    this.logLine('info', `Saved upload from device: ${file} (${data.length} bytes)`);
    return { path: file, uri: pathToFileURL(file).href };
  }

  openLocalPwa() {
    const url = this.state === 'standby' ? this.mirror?.view?.localUrl : this.relay && `http://127.0.0.1:${this.relay.port}/`;
    if (!url) throw new Error('Start remote access first.');
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // ------------------------------------------------------------------ notifications

  async _notify({ kind, session }) {
    const s = settings();
    if ((kind === 'input' && !s.notifyInput) || (kind === 'done' && !s.notifyDone) || (kind === 'error' && !s.notifyErrors)) return;
    const winState = vscode.window.state;
    if (s.skipWhileActive && (winState.active ?? winState.focused)) return;
    const key = `${kind}:${session.resource}`;
    if (Date.now() - (this.lastNotified.get(key) || 0) < 15000) return;
    this.lastNotified.set(key, Date.now());
    const devices = this.store.list().filter((d) => d.push && !(this.relay && this.relay.isDeviceVisible(d.id)));
    if (!devices.length) return;
    const detail = kind === 'input' ? await this.monitor.describeInput(session.resource) : kind === 'done' ? await this.monitor.describeDone(session.resource) : { text: 'The session stopped with an error.' };
    const icon = { input: '🔔', done: '✅', error: '⚠️' }[kind];
    const payload = {
      v: 1,
      kind,
      title: `${icon} ${session.title || 'Agent session'}`,
      body: detail.text,
      session: session.resource,
      hostId: this.identity.hostId,
      tag: `${this.identity.hostId}:${session.resource}`,
      ts: Date.now(),
    };
    await this._pushTo(devices, payload, kind === 'input' ? { urgency: 'high', ttl: 3600 } : { urgency: 'normal', ttl: 900 });
  }

  async _pushTo(devices, payload, opts) {
    for (const d of devices) {
      const r = await push.sendPush(d.push, payload, { privateJwk: this.vapid.privateJwk, subject: PUSH_SUBJECT, topic: payload.kind, ...opts });
      if (r.ok) this.logLine('info', `Push "${payload.title}" -> ${d.name}`);
      else {
        this.logLine('warn', `Push to ${d.name} failed (${r.status}): ${r.error || ''}`);
        if (r.gone) this.store.update(d.id, { push: null });
      }
    }
  }

  async _sendTestPush(deviceId) {
    const d = this.store.get(deviceId);
    if (!d?.push) return;
    await this._pushTo([d], { v: 1, kind: 'test', title: '🚀 Pocket Pilot', body: `Notifications from ${this.identity.name} work.`, hostId: this.identity.hostId, tag: `${this.identity.hostId}:test`, ts: Date.now() }, { urgency: 'high', ttl: 300 });
  }

  // ------------------------------------------------------------------ view state

  /** What the panel shows: this window's own state, or the running window's (mirrored). */
  viewState() {
    if (this.state === 'standby' && this.mirror?.view) {
      return { ...this.mirror.view, state: 'running', mirror: { label: this.standby?.label || this.mirror.label || 'another window' }, update: this.update || null };
    }
    return { ...this._ownViewState(), update: this.update || null };
  }

  _ownViewState() {
    const s = settings();
    const online = new Map((this.relay ? this.relay.activeConnections() : []).map((c) => [c.deviceId, c]));
    return {
      state: this.state,
      error: this.error,
      standby: this.standby ? { label: this.standby.label } : null,
      hostName: this.identity?.name,
      fingerprint: this.identity ? identityLib.fingerprintText(this.identity.fingerprint) : '',
      localUrl: this.relay ? `http://127.0.0.1:${this.relay.port}/` : null,
      tunnel: { mode: s.tunnelMode, state: this.tunnel?.state, url: this.publicUrl, reachable: this.tunnelReachable, error: this.tunnel?.error },
      agentHost: { connected: !!this.monitor?.connected, found: !!this.endpoint(), counts: this.monitor ? this.monitor.counts() : null },
      rendezvous: { enabled: s.rendezvous, status: this.rendezvous?.status, error: this.rendezvous?.lastError },
      pairing: this.pairing ? { link: this.pairing.link, svg: this.pairing.svg, expiresAt: this.pairing.expiresAt } : null,
      devices: this.store.list().map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        online: online.has(d.id),
        visible: !!online.get(d.id)?.visible,
        passkey: !!d.passkey,
        push: !!d.push,
      })),
      settings: { passkey: s.passkey, requireApproval: s.requireApproval, pwaUrl: s.pwaUrl, pwaFallback: !!this.pwaFallback },
    };
  }

  _updateStatusBar() {
    const sb = this.statusBar;
    if (!sb) return;
    const mirrored = this.state === 'standby' && this.mirror?.view;
    if (this.state === 'running' || mirrored) {
      const n = mirrored ? (this.mirror.view.devices || []).filter((d) => d.online).length : this.relay ? this.relay.activeConnections().length : 0;
      sb.text = `$(device-mobile) ${n || ''}`.trim();
      sb.tooltip = `Pocket Pilot: remote access on${mirrored ? ` (hosted by ${this.standby?.label || 'another window'})` : ''}${n ? ` · ${n} device(s) connected` : ''}`;
      sb.backgroundColor = undefined;
      sb.show();
    } else if (this.state === 'error') {
      sb.text = '$(device-mobile) $(warning)';
      sb.tooltip = `Pocket Pilot: ${this.error}`;
      sb.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      sb.show();
    } else {
      sb.hide();
    }
  }

  _showError(err) {
    this.logLine('error', err?.stack || String(err));
    vscode.window.showErrorMessage(`Pocket Pilot: ${err?.message || err}`, 'Show logs').then((p) => p && this.log.show());
  }

  // ------------------------------------------------------------------ updates

  /** How VS Code installed this extension: 'gallery' (Marketplace: VS Code updates it) or 'vsix'. */
  _installSource() {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(path.dirname(this.ctx.extensionPath), 'extensions.json'), 'utf8'));
      return list.find((e) => e.identifier?.id?.toLowerCase() === EXTENSION_ID)?.metadata?.source || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** VS Code pins VSIX installs and never updates them: look for new releases on GitHub instead. */
  async checkForUpdate({ quiet = true } = {}) {
    if (this._installSource() === 'gallery') return;
    const current = this.ctx.extension.packageJSON.version;
    let rel;
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pocket-pilot' } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      rel = await res.json();
    } catch (err) {
      if (!quiet) vscode.window.showWarningMessage(`Pocket Pilot: could not check for updates (${err.message}).`);
      return;
    }
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => a.name === 'pocket-pilot.vsix');
    if (!latest || !asset || cmpVersion(latest, current) <= 0) {
      this.update = null;
      if (!quiet) vscode.window.showInformationMessage(`Pocket Pilot ${current} is the latest version.`);
      this.changed();
      return;
    }
    this.update = { version: latest, notes: rel.html_url, vsix: asset.browser_download_url };
    this.changed();
    if (this.ctx.globalState.get(STATE_UPDATE_NOTIFIED) === latest && quiet) return;
    await this.ctx.globalState.update(STATE_UPDATE_NOTIFIED, latest);
    const pick = await vscode.window.showInformationMessage(`Pocket Pilot ${latest} is available (you have ${current}).`, 'Update', 'What\'s new');
    if (pick === 'Update') await this.installUpdate();
    else if (pick) vscode.env.openExternal(vscode.Uri.parse(this.update.notes));
  }

  async installUpdate() {
    if (!this.update) return this.checkForUpdate({ quiet: false });
    const { version, vsix } = this.update;
    if (!/^https:\/\/github\.com\//.test(vsix)) throw new Error('Unexpected download location');
    const dir = path.join(this.storageDir, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `pocket-pilot-${version}.vsix`);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating Pocket Pilot to ${version}…` }, async () => {
      const res = await fetch(vsix, { headers: { 'User-Agent': 'pocket-pilot' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000 || buf.length > 100 * 1024 * 1024 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('The download is not a VSIX package');
      fs.writeFileSync(file, buf);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    });
    const pick = await vscode.window.showInformationMessage(`Pocket Pilot ${version} is installed. Reload the window to use it.`, 'Reload');
    if (pick) vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

let service;

async function activate(context) {
  service = new PocketPilotService(context);
  await service.init();
  return { service };
}

async function deactivate() {
  if (service) await service.dispose();
}

module.exports = { activate, deactivate, PocketPilotService };
