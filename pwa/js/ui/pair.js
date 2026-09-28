import { html, useState } from '../lib/ui.js';
import { Icon, Spinner } from './common.js';
import { decodePairingFragment } from '../core/secure-channel.js';
import { pairWithHost } from '../net/host-connection.js';
import { webauthn, passkeysAvailable } from '../lib/webauthn.js';
import { deviceDescription } from '../lib/format.js';
import { isIos, isStandalone } from '../lib/push.js';

// The product page sits one level above the app on GitHub Pages (…/pocket-pilot/app/ → …/pocket-pilot/).
const PRODUCT_URL = /\/app\/$/.test(location.pathname) ? new URL('../', location.href).href : 'https://mithawala.github.io/pocket-pilot/';

export function fingerprintText(fp) {
  return [...fp].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g).join('-');
}

export function Welcome({ onLink, onScan, installPrompt }) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const iosSafari = isIos() && !isStandalone();
  const submit = () => {
    const i = link.indexOf('#');
    const frag = i >= 0 ? link.slice(i) : link;
    if (!decodePairingFragment(frag)) return setError('That does not look like a Pocket Pilot pairing link.');
    onLink(frag);
  };
  return html`<div class="page safe">
    <div class="hero">
      <img class="logo" src="./icons/icon.svg" alt="" />
      <h2>Pocket Pilot</h2>
      <p>Your Copilot agents, in your pocket. Chat, approve tool calls and get notified — wherever you are. Works with VS Code and the GitHub Copilot app.</p>
    </div>
    ${iosSafari && html`<div class="ios-tip"><b>iPhone:</b> first tap <b>Share → Add to Home Screen</b>, then open Pocket Pilot from your Home Screen and scan the code there. The Home Screen app keeps its own storage and is the only place iOS shows notifications.</div>`}
    <button class="btn primary block" style="margin-top:14px" onClick=${onScan}><${Icon} name="phone" /> Scan the QR code</button>
    <ol class="steps">
      <li><div><b>Install Pocket Pilot on your PC</b><div class="muted small">The VS Code extension or the GitHub Copilot app plugin — see <a href=${PRODUCT_URL} target="_blank" rel="noopener">${PRODUCT_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>.</div></div></li>
      <li><div><b>Turn on remote access</b><div class="muted small">VS Code: “Start remote access” in the Pocket Pilot panel. Copilot app or CLI: type <b>/pocket-pilot</b> in a chat.</div></div></li>
      <li><div><b>Scan the QR code</b><div class="muted small">${iosSafari ? 'From the Home Screen app (button above).' : 'With the button above or your phone’s camera.'}</div></div></li>
    </ol>
    <div class="trust">
      <div><${Icon} name="lock" size="18" /> End-to-end encrypted — even the tunnel can’t read it</div>
      <div><${Icon} name="shield" size="18" /> Only phones you approve on your PC, with Face ID / fingerprint</div>
      <div><${Icon} name="bolt" size="18" /> Free: no accounts, no servers, no tracking</div>
    </div>
    ${installPrompt}
    <a class="btn block" style="margin-top:10px" href="./?demo">Try the demo first</a>
    <details class="card" style="margin-top:14px">
      <summary class="muted">I have a pairing link</summary>
      <div class="stack" style="margin-top:12px">
        <input class="input" placeholder="Paste the pairing link from your PC" value=${link} onInput=${(e) => { setLink(e.target.value); setError(''); }} />
        ${error && html`<div class="errpart">${error}</div>`}
        <button class="btn primary" onClick=${submit} disabled=${!link}>Continue</button>
      </div>
    </details>
  </div>`;
}

const STEPS = [
  ['connecting', 'Connecting securely'],
  ['approval', 'Approve on your PC'],
  ['passkey', 'Create your passkey'],
  ['finishing', 'Finishing'],
];

export function PairScreen({ fragment, onPaired, onCancel }) {
  const info = decodePairingFragment(fragment);
  const dev = deviceDescription();
  const [name, setName] = useState(dev.name);
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState(null);
  if (!info) {
    return html`<div class="page safe"><div class="card stack"><b>Invalid pairing link</b><p class="muted">Show a new QR code in VS Code and scan it again.</p><button class="btn" onClick=${onCancel}>Back</button></div></div>`;
  }
  const start = async () => {
    setError(null);
    setPhase('connecting');
    // Can take seconds on some desktops; only needed once the PC asks for the passkey.
    const hasPasskeys = passkeysAvailable();
    try {
      const record = await pairWithHost({
        fragment,
        deviceName: name.trim() || dev.name,
        platform: dev.platform,
        webauthn: {
          register: async (opts) => {
            if (!(await hasPasskeys)) throw new Error('No Face ID / fingerprint / screen lock is set up on this device');
            return webauthn.register(opts);
          },
        },
        onStatus: setPhase,
      });
      setPhase('done');
      onPaired(record);
    } catch (err) {
      setPhase(null);
      setError(err.message || String(err));
    }
  };
  const idx = STEPS.findIndex(([k]) => k === phase);
  return html`<div class="page safe">
    <div class="hero" style="padding-top:12px">
      <img class="logo" src="./icons/icon.svg" alt="" style="width:64px;height:64px" />
      <h2 style="font-size:23px">Pair with ${info.name || 'your PC'}</h2>
      <p>Check that this fingerprint matches the one under the QR code on your PC:</p>
      <p style="margin-top:10px"><span class="fingerprint">${fingerprintText(info.hostFingerprint)}</span></p>
    </div>
    ${!phase && html`<div class="card stack">
      ${isIos() && !isStandalone() && html`<div class="ios-tip">You're pairing in Safari. For notifications, pair from the Home Screen app instead: <b>Share → Add to Home Screen</b>, open it and tap <b>Scan the QR code</b>. You can still pair Safari now.</div>`}
      <div class="field"><label>Name this phone</label><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} maxlength="60" /></div>
      ${error && html`<div class="errpart">${error}</div>`}
      <button class="btn primary block" onClick=${start}><${Icon} name="lock" /> Pair securely</button>
      <button class="btn block" onClick=${onCancel}>Cancel</button>
    </div>`}
    ${phase && html`<div class="progress-steps">
      ${STEPS.map(([k, label], i) => html`<div class=${`ps ${i === idx ? 'active' : i < idx || phase === 'done' ? 'done' : ''}`}>
        ${i === idx && phase !== 'done' ? html`<${Spinner} />` : i < idx || phase === 'done' ? html`<${Icon} name="check" size="18" />` : html`<span class="dot"></span>`}
        <div><div>${label}</div>${i === idx && k === 'approval' && html`<div class="muted small">Click “Allow” on your PC — in VS Code, or on the Pocket Pilot page the Copilot app opened.</div>`}${i === idx && k === 'passkey' && html`<div class="muted small">Confirm with Face ID, Touch ID or your fingerprint.</div>`}</div>
      </div>`)}
    </div>`}
  </div>`;
}
