import { html, useState, useEffect, useMemo, useChange } from '../lib/ui.js';
import { db, persistStorage } from '../lib/db.js';
import { HostConnection } from '../net/host-connection.js';
import { HostStore } from '../model/host-store.js';
import { webauthn, passkeysAvailable } from '../lib/webauthn.js';
import { subscribe as pushSubscribe, currentSubscription } from '../lib/push.js';
import { Toasts, Sheet, Icon, toast } from './common.js';
import { PictureViewer } from './viewer.js';
import { SessionsScreen, DesktopHome } from './sessions.js';
import { ChatScreen } from './chat.js';
import { Welcome, PairScreen } from './pair.js';
import { SettingsScreen, NotificationSetup, RenameHost, pushPromptWanted } from './settings.js';
import { QrScanner } from './scanner.js';
import { CodeSheet, PasskeySheet, FactorSheet, clearSetup } from './authenticator.js';
import { isPairingFragment } from '../core/secure-channel.js';
import { hostLabel, defaultHostLabel, cleanHostLabel } from '../lib/format.js';

function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('/s/')) return { name: 'chat', uri: decodeURIComponent(h.slice(3)) };
  if (h.startsWith('/open/')) {
    const [hostId, ...rest] = h.slice(6).split('/');
    return { name: 'open', hostId: decodeURIComponent(hostId), uri: decodeURIComponent(rest.join('/')) };
  }
  if (h === '/settings') return { name: 'settings' };
  if (h === '/pair') return { name: 'pair' };
  return { name: 'home' };
}

const THEME_COLORS = { dark: '#21252b', light: '#f0f0f1' };
const PUSH_PROMPT_KEY = 'pp:hidePushPrompt';

/** True on desktop-sized windows, where the app shows sessions and chat side by side like VS Code. */
function useWide() {
  const mq = useMemo(() => matchMedia('(min-width: 900px)'), []);
  const [wide, setWide] = useState(mq.matches);
  useEffect(() => {
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** Applies "dark" (One Dark), "light" (One Light) or "system"; mirrored to localStorage for the first paint. */
export function applyTheme(theme) {
  const t = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  const effective = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[effective]);
  try {
    localStorage.setItem('pp:theme', t);
  } catch {
    /* storage unavailable */
  }
}

export class AppController extends EventTarget {
  constructor({ pendingFragment, demo = false }) {
    super();
    this.hosts = [];
    this.currentId = null;
    this.active = null;
    this.pendingFragment = pendingFragment || null;
    this.theme = 'dark';
    this.installEvent = null;
    this.ready = false;
    this.demo = demo;
  }

  _emit() {
    this._v = (this._v || 0) + 1;
    this.dispatchEvent(new CustomEvent('change', { detail: {} }));
  }

  /**
   * Shows one of the second-factor sheets over whatever is open ('code', 'passkey' or 'factor') and
   * resolves with the answer.
   */
  _ask(kind, props) {
    this.sheet?.reject(new Error('Replaced'));
    return new Promise((resolve, reject) => {
      const request = { kind, ...props };
      const done = (fn) => (v) => {
        if (this.sheet !== request) return;
        this.sheet = null;
        this._emit();
        fn(v);
      };
      request.resolve = done(resolve);
      request.reject = done(reject);
      this.sheet = request;
      this._emit();
    });
  }

  /** The PC asks for a code from the authenticator app. */
  _askCode({ hostName, deviceName, wrong }) {
    return this._ask('code', { hostName, deviceName, wrong });
  }

  /**
   * The PC asks for the passkey again. Straight to Face ID where the browser allows it without a tap
   * (iOS 17.4 and later, other browsers); otherwise, or when it fails, a sheet with a button.
   */
  async _confirmPasskey(req) {
    let error = null;
    if (document.visibilityState === 'visible' && document.hasFocus?.() !== false) {
      try {
        return await webauthn.assert(req);
      } catch (err) {
        error = err;
      }
    }
    return this._ask('passkey', { hostName: this.current ? hostLabel(this.current) : req.hostName, error, assert: () => webauthn.assert(req) });
  }

  /** After a yes on the PC, this device sets up a new passkey or an authenticator app. */
  async _enrollFactor(req) {
    const canPasskey = await passkeysAvailable();
    const allowTotp = req.alternatives.includes('totp');
    if (!canPasskey && !allowTotp) throw new Error('This device has no Face ID, fingerprint or screen lock, and your computer only accepts passkeys.');
    const storageKey = `again-${req.hostId}`;
    const r = await this._ask('factor', { hostName: req.hostName, deviceName: req.deviceName, storageKey, allowTotp, canPasskey, register: () => webauthn.register(req) });
    clearSetup(storageKey);
    return r;
  }

  /** Whether this device closed the "Get notified" card (Settings still offers notifications). */
  get pushPromptHidden() {
    try {
      return localStorage.getItem(PUSH_PROMPT_KEY) === '1';
    } catch {
      return false;
    }
  }

  hidePushPrompt() {
    this._promptHiddenNow = true;
    try {
      localStorage.setItem(PUSH_PROMPT_KEY, '1');
    } catch {
      /* storage unavailable: hidden until the app reloads */
    }
    this._emit();
  }

  /** The "Get notified" card at the top of the sessions list, while it still has something to offer. */
  pushPrompt() {
    if (this.demo || this.active?.conn.state !== 'online' || this.pushPromptHidden || this._promptHiddenNow || !pushPromptWanted(this.current)) return null;
    return html`<${NotificationSetup} app=${this} host=${this.current} compact=${true} onDismiss=${() => {
      this.hidePushPrompt();
      toast('Hidden. You can turn on notifications anytime in Settings.');
    }} />`;
  }

  async init() {
    this.theme = (await db.get('theme').catch(() => null)) || 'dark';
    this._applyTheme();
    if (this.demo) {
      // Sample data only: never touches the real paired PCs stored on this device.
      const { createDemo } = await import('../demo/demo.js');
      const d = createDemo();
      this.hosts = [d.host];
      this.currentId = d.host.hostId;
      this.active = d;
      this.ready = true;
      this._emit();
      return;
    }
    persistStorage();
    this.hosts = await db.hosts().catch(() => []);
    const saved = await db.get('currentHost').catch(() => null);
    this.currentId = this.hosts.find((h) => h.hostId === saved)?.hostId || this.hosts[0]?.hostId || null;
    this._connectCurrent();
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installEvent = e;
      this._emit();
    });
    document.addEventListener('visibilitychange', () => this.active?.conn.setVisible(document.visibilityState === 'visible'));
    window.addEventListener('online', () => this.active?.conn.poke());
    window.addEventListener('focus', () => this.active?.conn.poke());
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data?.type === 'open-session') this.openFromNotification(e.data.hostId, e.data.session);
    });
    this.ready = true;
    this._emit();
  }

  get current() {
    return this.hosts.find((h) => h.hostId === this.currentId) || null;
  }

  _connectCurrent() {
    if (this.demo) return;
    this.sheet?.reject(new Error('Switched computer'));
    if (this.active) {
      this.active.conn.stop();
      this.active.store.dispose();
      this.active = null;
    }
    const host = this.current;
    if (!host) return;
    const conn = new HostConnection(host, {
      webauthn,
      askCode: (req) => this._askCode(req),
      confirmPasskey: (req) => this._confirmPasskey(req),
      enrollFactor: (req) => this._enrollFactor(req),
      isVisible: () => document.visibilityState === 'visible',
    });
    conn.addEventListener('record', (e) => db.putHost(e.detail.record).catch(() => {}));
    conn.addEventListener('ready', () => this._syncPush(host).catch(() => {}));
    const store = new HostStore(conn);
    store.addEventListener('change', (e) => {
      if (e.detail.kind === 'error') {
        const last = store.errors[store.errors.length - 1];
        if (last) toast(last.message, 'err');
      }
    });
    this.active = { host, conn, store };
    conn.start();
  }

  async selectHost(hostId) {
    if (this.demo) return;
    this.currentId = hostId;
    await db.set('currentHost', hostId);
    this._connectCurrent();
    location.hash = '#/';
    this._emit();
  }

  async addHost(record) {
    // Paired again: the name you gave it stays.
    const before = this.hosts.find((h) => h.hostId === record.hostId);
    if (before?.customName && !record.customName) record.customName = before.customName;
    this.hosts = [...this.hosts.filter((h) => h.hostId !== record.hostId), record];
    await db.putHost(record);
    await this.selectHost(record.hostId);
  }

  /**
   * Gives a paired computer a name of your own, on this device ('' or its default name: the default).
   * The record is the one the connection holds, so its own updates keep the name.
   */
  async renameHost(host, name) {
    const h = this.hosts.find((x) => x.hostId === host.hostId);
    if (!h) return;
    const clean = cleanHostLabel(name);
    if (!clean || clean === defaultHostLabel(h)) delete h.customName;
    else h.customName = clean;
    if (!this.demo) await db.putHost(h);
    this._emit();
  }

  async forgetHost(host) {
    if (this.demo) return toast('This is the demo — nothing to forget.');
    if (this.active?.host.hostId === host.hostId) {
      await this.active.conn.forget();
      this.active.conn.stop();
      this.active.store.dispose();
      this.active = null;
    }
    await db.deleteHost(host.hostId);
    this.hosts = this.hosts.filter((h) => h.hostId !== host.hostId);
    if (this.currentId === host.hostId) this.currentId = this.hosts[0]?.hostId || null;
    await db.set('currentHost', this.currentId);
    this._connectCurrent();
    location.hash = '#/';
    this._emit();
  }

  async repair(host) {
    if (!confirm(`${hostLabel(host)} no longer recognises this device. Forget it and pair again?`)) return;
    await db.deleteHost(host.hostId);
    this.hosts = this.hosts.filter((h) => h.hostId !== host.hostId);
    this.currentId = this.hosts[0]?.hostId || null;
    this._connectCurrent();
    location.hash = '#/';
    this._emit();
  }

  async openFromNotification(hostId, session) {
    if (hostId && hostId !== this.currentId && this.hosts.some((h) => h.hostId === hostId)) await this.selectHost(hostId);
    if (session) location.hash = `#/s/${encodeURIComponent(session)}`;
  }

  async enablePush(host) {
    if (this.demo) throw new Error('Notifications work once you pair your own computer');
    if (!this.active || this.active.host.hostId !== host.hostId || this.active.conn.state !== 'online') throw new Error('Connect to the computer first');
    if (!host.vapidPublicKey) throw new Error('This computer did not provide a push key');
    const sub = await pushSubscribe(host.vapidPublicKey);
    const r = await this.active.conn.subscribePush(sub);
    if (!r.ok) throw new Error(r.error || 'The computer rejected the subscription');
    for (const h of this.hosts) {
      if (h.pushEnabled && h.hostId !== host.hostId) {
        h.pushEnabled = false;
        await db.putHost(h);
      }
    }
    host.pushEnabled = true;
    host.pushEndpoint = sub.endpoint;
    await db.putHost(host);
    this._emit();
  }

  /** Re-sends the current subscription after reconnects (endpoints can rotate). */
  async _syncPush(host) {
    if (!host.pushEnabled || Notification.permission !== 'granted') return;
    const sub = await currentSubscription();
    if (!sub) {
      host.pushEnabled = false;
      await db.putHost(host);
      this._emit();
      return;
    }
    const json = sub.toJSON();
    if (json.endpoint !== host.pushEndpoint || !host.pushSynced) {
      await this.active?.conn.subscribePush({ endpoint: json.endpoint, keys: json.keys });
      host.pushEndpoint = json.endpoint;
      host.pushSynced = true;
      await db.putHost(host);
    }
  }

  testPush() {
    this.active?.conn.testPush();
    toast('Test notification sent — lock your screen or switch apps to see it.');
  }

  async setTheme(t) {
    this.theme = t;
    this._applyTheme();
    await db.set('theme', t);
  }

  _applyTheme() {
    applyTheme(this.theme);
  }

  async install() {
    const e = this.installEvent;
    if (!e) return;
    e.prompt();
    await e.userChoice.catch(() => {});
    this.installEvent = null;
    this._emit();
  }
}

function HostSwitcher({ app, open, onClose, onRename }) {
  return html`<${Sheet} open=${open} onClose=${onClose} title="Your computers">
    ${app.hosts.map((h) => html`<div class="host-pick" key=${h.hostId}>
      <button class=${`list-item ${h.hostId === app.currentId ? 'on' : ''}`} onClick=${() => { app.selectHost(h.hostId); onClose(); }}>
        <${Icon} name="monitor" /><div class="grow"><div>${hostLabel(h)}</div>${h.customName && html`<div class="muted tiny">${defaultHostLabel(h)}</div>`}</div>${h.hostId === app.currentId && html`<span class="check"><${Icon} name="check" /></span>`}
      </button>
      <button class="icon-btn" onClick=${() => { onClose(); onRename(h); }} aria-label=${`Rename ${hostLabel(h)}`} title="Rename"><${Icon} name="edit" /></button>
    </div>`)}
    <button class="list-item" onClick=${() => { onClose(); location.hash = '#/settings'; }}><${Icon} name="gear" /><span class="grow">Manage computers</span></button>
  </${Sheet}>`;
}

export function App({ app }) {
  useChange(app);
  const [route, setRoute] = useState(parseRoute());
  const [switcher, setSwitcher] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const wide = useWide();
  const startPairing = (frag) => {
    setScanning(false);
    app.pendingFragment = frag;
    location.hash = '#/pair';
    setRoute({ name: 'pair' });
  };
  useEffect(() => {
    const onHash = () => {
      if (isPairingFragment(location.hash)) {
        app.pendingFragment = location.hash;
        history.replaceState(null, '', `${location.pathname}${location.search}#/pair`);
        setRoute({ name: 'pair' });
        return;
      }
      setRoute(parseRoute());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (route.name === 'open') {
      app.openFromNotification(route.hostId, route.uri);
    }
  }, [route.name, route.uri]);

  if (!app.ready) return html`<div class="shell"><div class="boot"><span class="spinner lg"></span></div></div>`;
  const installHint = app.installEvent ? html`<button class="btn block" style="margin-top:12px" onClick=${() => app.install()}><${Icon} name="phone" /> Install Pocket Pilot</button>` : null;

  let screen;
  const scrollable = (inner) => html`<div class="screen"><div class="scroll-wrap"><div class="scroll">${inner}</div></div></div>`;
  if (route.name === 'pair' && app.pendingFragment) {
    screen = scrollable(html`<${PairScreen} key=${app.pendingFragment} fragment=${app.pendingFragment}
      onPaired=${async (record) => {
        app.pendingFragment = null;
        await app.addHost(record);
        toast(`Paired with ${hostLabel(app.hosts.find((h) => h.hostId === record.hostId) || record)} 🎉`);
      }}
      onRescan=${() => setScanning(true)}
      onCancel=${() => { app.pendingFragment = null; location.hash = '#/'; }} />`);
  } else if (!app.current) {
    screen = scrollable(html`<${Welcome} installPrompt=${installHint} onScan=${() => setScanning(true)} onLink=${startPairing} />`);
  } else if (wide && app.active && ['home', 'chat', 'settings', 'open'].includes(route.name)) {
    // Desktop: the sessions list is a sidebar and the chat (or settings) fills the rest, like VS Code.
    const list = html`<${SessionsScreen} app=${app} host=${app.current} store=${app.active.store} conn=${app.active.conn}
      pushPrompt=${app.pushPrompt()}
      selected=${route.name === 'chat' ? route.uri : null} newOpen=${newOpen} onNew=${() => setNewOpen(true)} onNewClose=${() => setNewOpen(false)}
      onOpen=${(uri) => { location.hash = `#/s/${encodeURIComponent(uri)}`; }}
      onSettings=${() => { location.hash = '#/settings'; }}
      onSwitchHost=${() => setSwitcher(true)} />`;
    let main;
    if (route.name === 'chat') {
      main = html`<${ChatScreen} key=${route.uri} store=${app.active.store} conn=${app.active.conn} uri=${route.uri} embedded=${true} onRepair=${() => app.repair(app.current)} onBack=${() => { location.hash = '#/'; }} />`;
    } else if (route.name === 'settings') {
      main = html`<${SettingsScreen} app=${app} hosts=${app.hosts} current=${app.current} onBack=${() => { location.hash = '#/'; }} onPairNew=${() => setScanning(true)} />`;
    } else {
      main = html`<${DesktopHome} store=${app.active.store} host=${app.current} onNew=${() => setNewOpen(true)} />`;
    }
    screen = html`<div class="split"><aside class="pane-list" aria-label="Sessions">${list}</aside><main class="pane-main">${main}</main></div>`;
  } else if (route.name === 'settings') {
    screen = html`<${SettingsScreen} app=${app} hosts=${app.hosts} current=${app.current} onBack=${() => history.length > 1 ? history.back() : (location.hash = '#/')} onPairNew=${() => setScanning(true)} />`;
  } else if (route.name === 'chat' && app.active) {
    screen = html`<${ChatScreen} key=${route.uri} store=${app.active.store} conn=${app.active.conn} uri=${route.uri} onRepair=${() => app.repair(app.current)} onBack=${() => (history.length > 1 ? history.back() : (location.hash = '#/'))} />`;
  } else if (app.active) {
    screen = html`<${SessionsScreen} app=${app} host=${app.current} store=${app.active.store} conn=${app.active.conn}
      pushPrompt=${app.pushPrompt()}
      newOpen=${newOpen} onNew=${() => setNewOpen(true)} onNewClose=${() => setNewOpen(false)}
      onOpen=${(uri) => { location.hash = `#/s/${encodeURIComponent(uri)}`; }}
      onSettings=${() => { location.hash = '#/settings'; }}
      onSwitchHost=${() => setSwitcher(true)} />`;
  }
  return html`<div class=${`shell ${app.demo ? 'has-banner' : ''}`}>
    ${app.demo && html`<a class="demo-banner" href="./" target="_top">Demo with sample data · <b>Use it with my computer →</b></a>`}
    ${screen}
    <${Toasts} />
    <${PictureViewer} />
    <${HostSwitcher} app=${app} open=${switcher} onClose=${() => setSwitcher(false)} onRename=${setRenaming} />
    ${renaming && html`<${RenameHost} app=${app} host=${renaming} onClose=${() => setRenaming(null)} />`}
    <${CodeSheet} request=${app.sheet?.kind === 'code' ? app.sheet : null} onSubmit=${(code) => app.sheet?.resolve(code)} onReset=${() => app.sheet?.resolve({ reset: true })} onCancel=${() => app.sheet?.reject(new Error('cancelled'))} />
    <${PasskeySheet} request=${app.sheet?.kind === 'passkey' ? app.sheet : null} onCancel=${() => app.sheet?.reject(new Error('cancelled'))} />
    <${FactorSheet} request=${app.sheet?.kind === 'factor' ? app.sheet : null} onCancel=${() => app.sheet?.reject(new Error('cancelled'))} />
    ${scanning && html`<${QrScanner} onResult=${startPairing} onClose=${() => setScanning(false)} />`}
  </div>`;
}
