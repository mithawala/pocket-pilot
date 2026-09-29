import { html, useState, useEffect } from '../lib/ui.js';
import { Icon, toast } from './common.js';
import { pushBlockedReason, appleDevice } from '../lib/push.js';
import { unb64u } from '../core/bytes.js';
import { fingerprint } from '../core/secure-channel.js';
import { fingerprintText } from './pair.js';
import { APP_VERSION } from '../net/host-connection.js';

function HostFingerprint({ host }) {
  const [fp, setFp] = useState('');
  useEffect(() => {
    fingerprint(unb64u(host.hostPublicKey)).then((f) => setFp(fingerprintText(f)));
  }, [host.hostPublicKey]);
  return html`<span class="mono">${fp}</span>`;
}

/** Whether the "Get notified" card has something to offer for this host on this device. */
export function pushPromptWanted(host) {
  const reason = pushBlockedReason();
  if (reason === 'ios-install') return true;
  if (reason) return false;
  return !(host?.pushEnabled && Notification.permission === 'granted');
}

export function NotificationSetup({ app, host, compact, onDismiss }) {
  const reason = pushBlockedReason();
  const [busy, setBusy] = useState(false);
  const enabled = !!host?.pushEnabled && Notification.permission === 'granted';
  // The card at the top of the sessions list can be closed; Settings always offers notifications.
  const close = onDismiss ? html`<button class="icon-btn card-x" onClick=${onDismiss} aria-label="Hide" title="Hide"><${Icon} name="x" /></button>` : null;
  if (reason === 'ios-install') {
    return html`<div class=${`card ${close ? 'closable' : ''}`} style="margin-bottom:12px">
      ${close}
      <div class="row"><${Icon} name="bell" /><b>Get notified when an agent needs you</b></div>
      <p class="muted small" style="margin:8px 0 0">On ${appleDevice()}, only the app on your Home Screen can notify you, and it's kept apart from the browser: tap <b>Share</b> → <b>Add to Home Screen</b>, open Pocket Pilot from there and pair it once more with <b>Scan the QR code</b>.</p>
    </div>`;
  }
  if (reason === 'unsupported') return compact ? null : html`<p class="muted small">This browser does not support push notifications.</p>`;
  if (reason === 'denied') return compact ? null : html`<p class="muted small">Notifications are blocked in your browser settings for this site.</p>`;
  if (enabled && compact) return null;
  const enable = async () => {
    setBusy(true);
    try {
      await app.enablePush(host);
      toast('Notifications enabled 🎉');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  if (enabled) {
    return html`<div class="row"><span class="grow">Notifications are on for ${host.hostName}.</span><button class="btn sm" onClick=${() => app.testPush(host)}>Send test</button></div>`;
  }
  return html`<div class=${`card ${close ? 'closable' : ''}`} style="margin-bottom:12px">
    ${close}
    <div class="row"><${Icon} name="bell" /><b class="grow">Get notified when an agent needs you</b></div>
    <p class="muted small" style="margin:8px 0 10px">Approvals, questions and finished tasks — even when the app is closed.</p>
    <button class="btn primary sm" disabled=${busy} onClick=${enable}>${busy ? 'Enabling…' : 'Enable notifications'}</button>
  </div>`;
}

export function SettingsScreen({ app, hosts, current, onBack, onPairNew }) {
  const [theme, setTheme] = useState(app.theme);
  const setT = (t) => {
    setTheme(t);
    app.setTheme(t);
  };
  const forget = async (h) => {
    if (!confirm(`Forget ${h.hostName}? You will need to scan a new QR code to pair again.`)) return;
    await app.forgetHost(h);
  };
  return html`<div class="screen">
    <div class="topbar">
      <button class="icon-btn" onClick=${onBack} aria-label="Back"><${Icon} name="back" /></button>
      <div class="titles"><h1>Settings</h1></div>
    </div>
    <div class="scroll-wrap"><div class="scroll"><div class="page">
      <div class="section-title">Your PCs</div>
      <div class="set-group">
        ${hosts.map((h) => html`<div class="set-row" key=${h.hostId}>
          <div class="ic"><${Icon} name="monitor" /></div>
          <div class="grow">
            <div><b>${h.hostName}</b>${current?.hostId === h.hostId ? html` <span class="muted small">· current</span>` : ''}</div>
            <div class="kv">Fingerprint <${HostFingerprint} host=${h} /></div>
            <div class="kv">${h.passkey ? 'Passkey protected' : 'No passkey'} · ${h.rendezvous ? 'Auto-reconnect' : 'Manual reconnect'}</div>
          </div>
          <div class="stack" style="gap:6px">
            ${current?.hostId !== h.hostId && html`<button class="btn sm" onClick=${() => app.selectHost(h.hostId)}>Use</button>`}
            <button class="btn sm danger" onClick=${() => forget(h)}>Forget</button>
          </div>
        </div>`)}
        <button class="set-row" onClick=${onPairNew}><div class="ic"><${Icon} name="plus" /></div><div class="grow">Pair another PC</div><${Icon} name="right" /></button>
      </div>

      <div class="section-title">Notifications</div>
      <div class="card">${current ? html`<${NotificationSetup} app=${app} host=${current} />` : html`<span class="muted">Pair a PC first.</span>`}</div>

      <div class="section-title">Theme</div>
      <div class="seg">${[['dark', 'One Dark'], ['light', 'One Light'], ['system', 'System']].map(([v, l]) => html`<button class=${theme === v ? 'on' : ''} onClick=${() => setT(v)}>${l}</button>`)}</div>

      <div class="section-title">Security</div>
      <div class="card stack small sec-list">
        <div class="row"><${Icon} name="lock" /><span>Every message is end-to-end encrypted between this device and your PC (ECDH P-256 + AES-256-GCM). The Cloudflare tunnel only relays ciphertext.</span></div>
        <div class="row"><${Icon} name="key" /><span>This device’s private key never leaves it and cannot be exported. Your GitHub token never leaves your PC.</span></div>
        <div class="row"><${Icon} name="shield" /><span>${current?.hostKind === 'copilot' ? 'Remove this device anytime in the Pocket Pilot panel on your PC (run /pocket-pilot in the GitHub Copilot app)' : 'Remove this device anytime in the Pocket Pilot panel in VS Code'} — it is disconnected immediately.</span></div>
      </div>

      <div class="section-title">About</div>
      <div class="set-group">
        <div class="set-row"><div class="ic"><${Icon} name="info" /></div><div class="grow">Pocket Pilot ${APP_VERSION}</div></div>
        <a class="set-row" href="https://mithawala.github.io/pocket-pilot/" target="_blank" rel="noopener"><div class="ic"><${Icon} name="globe" /></div><div class="grow">Product page & help</div><${Icon} name="right" /></a>
        <a class="set-row" href="https://github.com/mithawala/pocket-pilot" target="_blank" rel="noopener noreferrer"><div class="ic"><${Icon} name="globe" /></div><div class="grow">Source code & docs</div><${Icon} name="right" /></a>
        ${app.installEvent && html`<button class="set-row" onClick=${() => app.install()}><div class="ic"><${Icon} name="phone" /></div><div class="grow">Install app</div><${Icon} name="right" /></button>`}
      </div>
      <p class="made-by">Developed by <a href="https://mithawala.com" target="_blank" rel="noopener">Asif Mithawala</a></p>
    </div></div></div>
  </div>`;
}
