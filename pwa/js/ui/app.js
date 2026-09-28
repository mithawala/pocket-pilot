import { html, useState, useEffect, useMemo, useChange } from '../lib/ui.js';
import { db, persistStorage } from '../lib/db.js';
import { HostConnection } from '../net/host-connection.js';
import { HostStore } from '../model/host-store.js';
import { webauthn } from '../lib/webauthn.js';
import { subscribe as pushSubscribe, currentSubscription } from '../lib/push.js';
import { Toasts, Sheet, Icon, toast } from './common.js';
import { SessionsScreen, DesktopHome } from './sessions.js';
import { ChatScreen } from './chat.js';
import { Welcome, PairScreen } from './pair.js';
import { SettingsScreen, NotificationSetup } from './settings.js';
import { QrScanner } from './scanner.js';

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
    if (this.active) {
      this.active.conn.stop();
      this.active.store.dispose();
      this.active = null;
    }
    const host = this.current;
    if (!host) return;
    const conn = new HostConnection(host, { webauthn, isVisible: () => document.visibilityState === 'visible' });
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
    this.hosts = [...this.hosts.filter((h) => h.hostId !== record.hostId), record];
    await db.putHost(record);
    await this.selectHost(record.hostId);
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
    if (!confirm(`${host.hostName} no longer recognises this device. Forget it and pair again?`)) return;
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
    if (this.demo) throw new Error('Notifications work once you pair your own PC');
    if (!this.active || this.active.host.hostId !== host.hostId || this.active.conn.state !== 'online') throw new Error('Connect to the PC first');
    if (!host.vapidPublicKey) throw new Error('This PC did not provide a push key');
    const sub = await pushSubscribe(host.vapidPublicKey);
    const r = await this.active.conn.subscribePush(sub);
    if (!r.ok) throw new Error(r.error || 'The PC rejected the subscription');
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

function HostSwitcher({ app, open, onClose }) {
  return html`<${Sheet} open=${open} onClose=${onClose} title="Your PCs">
    ${app.hosts.map((h) => html`<button class=${`list-item ${h.hostId === app.currentId ? 'on' : ''}`} onClick=${() => { app.selectHost(h.hostId); onClose(); }}>
      <${Icon} name="monitor" /><span class="grow">${h.hostName}</span>${h.hostId === app.currentId && html`<span class="check"><${Icon} name="check" /></span>`}
    </button>`)}
    <button class="list-item" onClick=${() => { onClose(); location.hash = '#/settings'; }}><${Icon} name="gear" /><span class="grow">Manage PCs</span></button>
  </${Sheet}>`;
}

export function App({ app }) {
  useChange(app);
  const [route, setRoute] = useState(parseRoute());
  const [switcher, setSwitcher] = useState(false);
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
      if (/(?:^|[#&])pair=1\./.test(location.hash)) {
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
    screen = scrollable(html`<${PairScreen} fragment=${app.pendingFragment}
      onPaired=${async (record) => {
        app.pendingFragment = null;
        await app.addHost(record);
        toast(`Paired with ${record.hostName} 🎉`);
      }}
      onCancel=${() => { app.pendingFragment = null; location.hash = '#/'; }} />`);
  } else if (!app.current) {
    screen = scrollable(html`<${Welcome} installPrompt=${installHint} onScan=${() => setScanning(true)} onLink=${startPairing} />`);
  } else if (wide && app.active && ['home', 'chat', 'settings', 'open'].includes(route.name)) {
    // Desktop: the sessions list is a sidebar and the chat (or settings) fills the rest, like VS Code.
    const list = html`<${SessionsScreen} app=${app} host=${app.current} store=${app.active.store} conn=${app.active.conn}
      pushPrompt=${app.active.conn.state === 'online' && !app.demo ? html`<${NotificationSetup} app=${app} host=${app.current} compact=${true} />` : null}
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
    const pushPrompt = html`<${NotificationSetup} app=${app} host=${app.current} compact=${true} />`;
    screen = html`<${SessionsScreen} app=${app} host=${app.current} store=${app.active.store} conn=${app.active.conn}
      pushPrompt=${app.active.conn.state === 'online' && !app.demo ? pushPrompt : null}
      newOpen=${newOpen} onNew=${() => setNewOpen(true)} onNewClose=${() => setNewOpen(false)}
      onOpen=${(uri) => { location.hash = `#/s/${encodeURIComponent(uri)}`; }}
      onSettings=${() => { location.hash = '#/settings'; }}
      onSwitchHost=${() => setSwitcher(true)} />`;
  }
  return html`<div class=${`shell ${app.demo ? 'has-banner' : ''}`}>
    ${app.demo && html`<a class="demo-banner" href="./" target="_top">Demo with sample data · <b>Use it with my PC →</b></a>`}
    ${screen}
    <${Toasts} />
    <${HostSwitcher} app=${app} open=${switcher} onClose=${() => setSwitcher(false)} />
    ${scanning && html`<${QrScanner} onResult=${startPairing} onClose=${() => setScanning(false)} />`}
  </div>`;
}
