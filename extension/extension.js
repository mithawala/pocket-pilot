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
const { SessionMonitor } = require('./core/monitor');
const { TunnelManager } = require('./core/tunnel');
const { GistRendezvous } = require('./core/rendezvous');
const push = require('./core/push');
const { Leader } = require('./leader');
const { SidebarProvider, renderQrSvg } = require('./sidebar');

const STATE_ENABLED = 'pocketPilot.enabled';
const STATE_CLOUDFLARED_OK = 'pocketPilot.cloudflaredConsent';
const STATE_RDV_ASKED = 'pocketPilot.rendezvousAsked';
const PUSH_SUBJECT = 'mailto:pocket-pilot@users.noreply.github.com';

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
    this.monitor.on('transition', (t) => this._notify(t).catch((err) => this.logLine('warn', `Notification failed: ${err.message}`)));
    this.tunnel = new TunnelManager({ storageDir: this.storageDir, log: (l, m) => this.logLine(l, m), configuredPath: () => settings().cloudflaredPath });
    this.tunnel.on('state', () => this.changed());
    this.tunnel.on('url', (url) => this._onPublicUrl(url));

    this.logLine('info', `Pocket Pilot ready; agent host: ${agentHost.describeEndpoint(this.endpoint())}`);
    this._updateStatusBar();
    if (ctx.globalState.get(STATE_ENABLED, false) && settings().autoStart) {
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
      this.state = 'standby';
      this.standby = lead.holder;
      this._watchLeader();
      this.changed();
      if (interactive) {
        const pick = await vscode.window.showInformationMessage(`Pocket Pilot is already running in another VS Code window (${lead.holder?.label || 'unknown'}).`, 'Move it here');
        if (pick) await this.takeOver();
      }
      return;
    }
    this.state = 'starting';
    this.error = null;
    this.standby = null;
    this.changed();
    try {
      if (!this.endpoint()) this.logLine('warn', 'The VS Code agent host endpoint was not found yet; phones will see sessions once it starts.');
      await this._loadSecrets();
      if (interactive) await this._ensureGithubConsent();
      await this._startRelay();
      this.monitor.start();
      await this._startTunnel(interactive);
      await this._checkPwaUrl();
      this._pwaTimer = setInterval(() => {
        if (this.pwaFallback) this._checkPwaUrl();
      }, 10 * 60 * 1000);
      this.state = 'running';
      await this.ctx.globalState.update(STATE_ENABLED, true);
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

  async stop({ remember = true } = {}) {
    await this._teardown();
    this.state = 'stopped';
    this.leader.release();
    if (remember) await this.ctx.globalState.update(STATE_ENABLED, false);
    vscode.commands.executeCommand('setContext', 'pocketPilot.running', false);
    this.logLine('info', 'Remote access stopped');
    this.changed();
  }

  async _teardown() {
    clearInterval(this._leaderTimer);
    clearInterval(this._pwaTimer);
    clearTimeout(this._pairingTimer);
    this.pairing = null;
    const relay = this.relay;
    this.relay = null;
    this.publicUrl = null;
    this.tunnelReachable = false;
    await Promise.allSettled([relay?.close(), this.tunnel?.stop()]);
    this.monitor?.stop();
  }

  async dispose() {
    clearInterval(this._standbyTimer);
    this.store.unwatch();
    await this._teardown();
    this.leader.release();
  }

  _watchLeader() {
    clearInterval(this._standbyTimer);
    this._standbyTimer = setInterval(() => {
      if (this.state !== 'standby') return clearInterval(this._standbyTimer);
      const h = this.leader.holder();
      if (!h) {
        clearInterval(this._standbyTimer);
        this.state = 'stopped';
        this.logLine('info', 'The Pocket Pilot window closed; taking over here');
        this.start({ interactive: false });
      } else if (h.pid !== this.standby?.pid) {
        this.standby = h;
        this.changed();
      }
    }, 4000);
  }

  _checkTakeover() {
    const pid = this.leader.pendingTakeover();
    if (pid) {
      this.leader.clearTakeover();
      this.logLine('info', `Another window (pid ${pid}) took over Pocket Pilot`);
      this.stop({ remember: false }).then(() => {
        this.state = 'standby';
        this.standby = { pid, label: 'another window' };
        this._watchLeader();
        this.changed();
      });
    }
  }

  async takeOver() {
    if (this.state !== 'standby') return this.start({ interactive: true });
    this.leader.requestTakeover();
    for (let i = 0; i < 20 && this.leader.holder(); i++) await new Promise((r) => setTimeout(r, 500));
    this.state = 'stopped';
    await this.start({ interactive: true });
  }

  async _startRelay() {
    const pwaDir = path.join(this.ctx.extensionUri.fsPath, 'pwa');
    this.relay = new RelayServer({
      identity: this.identity,
      store: this.store,
      getAgentEndpoint: () => this.endpoint(),
      getAuthTokens: (resources) => this._authTokens(resources),
      getProtectedResources: () => this.monitor.protectedResources,
      approveDevice: (info) => this._approve(info),
      allowedOrigins: () => this.allowedOrigins(),
      policy: () => {
        const s = settings();
        return { requireApproval: s.requireApproval, passkey: s.passkey, passkeyGraceHours: s.passkeyGraceHours };
      },
      welcomeExtras: () => ({ vapidPublicKey: this.vapid.publicKey, rendezvous: settings().rendezvous ? this.rendezvous.info() : null, pwaUrl: settings().pwaUrl || null }),
      isReadAllowed: (uri) => this._isReadAllowed(uri),
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
          'Pocket Pilot uses the free Cloudflare quick tunnel so your phone can reach this PC from anywhere. Download the official cloudflared binary (about 55 MB) from github.com/cloudflare/cloudflared?',
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

  /** True when the configured phone app URL is not reachable (e.g. not published yet). */
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
    if (this.pwaFallback && !was) this.logLine('warn', `The phone app is not reachable at ${url} yet; pairing links use the copy served through the tunnel until it is published.`);
    if (was && !this.pwaFallback) {
      this.logLine('info', `Phone app is live at ${url}`);
      await this.newPairingCode();
    }
    this.changed();
  }

  async newPairingCode() {
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
    if (this.state !== 'running') return this.start({ interactive: true });
    await this.newPairingCode();
    await vscode.commands.executeCommand('pocketPilot.panel.focus');
  }

  async copyPairingLink() {
    if (!this.pairing) await this.newPairingCode();
    if (!this.pairing) throw new Error('Remote access is not running.');
    await vscode.env.clipboard.writeText(this.pairing.link);
    vscode.window.showInformationMessage('Pairing link copied. It works once and expires soon — open it only on your own phone.');
  }

  async _approve(info) {
    const where = [info.platform, info.ip && `from ${info.ip}`].filter(Boolean).join(' · ');
    const choice = await vscode.window.showWarningMessage(
      `Allow "${info.name}" to control your agent sessions?`,
      { modal: true, detail: `${where}\n\nThe phone will be able to read your sessions, chat with the agents and approve their tool calls. Only allow this if you just scanned the QR code yourself.` },
      'Allow',
    );
    this.logLine('info', `Pairing request from "${info.name}" (${where}): ${choice === 'Allow' ? 'allowed' : 'declined'}`);
    return choice === 'Allow';
  }

  // ------------------------------------------------------------------ devices

  async removeDevice(id) {
    if (!id) {
      const devices = this.store.list();
      if (!devices.length) return vscode.window.showInformationMessage('No phones are paired.');
      const pick = await vscode.window.showQuickPick(devices.map((d) => ({ label: d.name, description: d.platform, detail: `Paired ${new Date(d.createdAt).toLocaleString()}`, id: d.id })), { placeHolder: 'Remove which phone?' });
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
    const ok = await vscode.window.showWarningMessage(`Remove all ${n} paired phone(s)?`, { modal: true }, 'Remove all');
    if (ok !== 'Remove all') return;
    for (const d of this.store.list()) this.relay?.revokeDevice(d.id);
    this.store.clear();
  }

  async resetIdentity() {
    if (this.state === 'standby') throw new Error('Pocket Pilot runs in another VS Code window — reset it there (or move it to this window first).');
    const ok = await vscode.window.showWarningMessage('Reset the Pocket Pilot identity of this PC?', { modal: true, detail: 'All paired phones are removed and must scan a new QR code. Use this if you think a phone or pairing code was compromised.' }, 'Reset');
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
    vscode.window.showInformationMessage('Pocket Pilot identity reset. Pair your phone again.');
  }

  // ------------------------------------------------------------------ GitHub auth

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

  /** One-time consent so the relay can authenticate phone connections to the agent host. */
  async _ensureGithubConsent() {
    const resources = this.monitor.protectedResources?.length ? this.monitor.protectedResources : [{ resource: 'https://api.github.com', scopes_supported: ['read:user', 'user:email'], required: true }];
    for (const r of resources.filter((x) => x.required !== false)) {
      await this._githubToken(r.scopes_supported || [], true);
    }
  }

  async _authTokens(resources) {
    const out = [];
    for (const r of resources || []) {
      const servers = (r.authorization_servers || []).join(' ');
      if (servers && !/github\.com/i.test(servers)) continue;
      const scopes = r.scopes_supported || [];
      const token = await this._githubToken(scopes, false);
      if (token) out.push({ resource: r.resource, token, scopes });
    }
    return out;
  }

  async enableRendezvous() {
    if (!this.rendezvous || this.state !== 'running') throw new Error('Start remote access first.');
    // Let the user pick (or add) the account: work accounts (Enterprise Managed Users) cannot create gists.
    const token = await this._githubToken(['gist'], true, { pickAccount: true });
    const ok = token && this.publicUrl ? await this.rendezvous.publish(this.publicUrl).catch(() => false) : !!token;
    if (!ok) vscode.window.showWarningMessage(`Auto-reconnect is not active: ${this.rendezvous.lastError || 'GitHub sign-in was cancelled.'}`, 'Try another account').then((p) => p && this.enableRendezvous());
    else vscode.window.showInformationMessage('Auto-reconnect is on. Paired phones get the gist details the next time they connect.');
    this.changed();
  }

  async _maybeAskRendezvous() {
    if (this.rendezvous.info() || this.ctx.globalState.get(STATE_RDV_ASKED, false)) return;
    await this.ctx.globalState.update(STATE_RDV_ASKED, true);
    const token = await this._githubToken(['gist'], false);
    if (token) return;
    const pick = await vscode.window.showInformationMessage(
      'Let your phone reconnect automatically after VS Code restarts? Pocket Pilot keeps the (changing) tunnel address in a secret GitHub gist, end-to-end encrypted so only your paired phones can read it.',
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
    this.logLine('info', `Saved upload from phone: ${file} (${data.length} bytes)`);
    return { path: file, uri: pathToFileURL(file).href };
  }

  openLocalPwa() {
    if (!this.relay) throw new Error('Start remote access first.');
    vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${this.relay.port}/`));
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

  viewState() {
    const s = settings();
    const online = new Map((this.relay ? this.relay.activeConnections() : []).map((c) => [c.deviceId, c]));
    return {
      state: this.state,
      error: this.error,
      standby: this.standby ? { label: this.standby.label } : null,
      hostName: this.identity?.name,
      fingerprint: this.identity ? identityLib.fingerprintText(this.identity.fingerprint) : '',
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
    if (this.state === 'running') {
      const n = this.relay ? this.relay.activeConnections().length : 0;
      sb.text = `$(device-mobile) ${n || ''}`.trim();
      sb.tooltip = `Pocket Pilot: remote access on${n ? ` · ${n} phone(s) connected` : ''}`;
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
