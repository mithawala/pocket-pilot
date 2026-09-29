import { html, useState, useEffect, useRef } from '../lib/ui.js';
import { Icon, Spinner } from './common.js';
import { decodePairingFragment } from '../core/secure-channel.js';
import { codeAt, stepAt } from '../core/totp.js';
import { pairWithHost, APP_VERSION } from '../net/host-connection.js';
import { webauthn, passkeysAvailable } from '../lib/webauthn.js';
import { deviceDescription } from '../lib/format.js';
import { isIos, isStandalone, appleDevice, pairInHomeScreenApp } from '../lib/push.js';
import { AuthenticatorSetup, FactorChooser, loadSetup, clearSetup, passkeyHint } from './authenticator.js';

// The product page sits one level above the app on GitHub Pages (…/pocket-pilot/app/ → …/pocket-pilot/).
const PRODUCT_URL = /\/app\/$/.test(location.pathname) ? new URL('../', location.href).href : 'https://mithawala.github.io/pocket-pilot/';

export function fingerprintText(fp) {
  return [...fp].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g).join('-');
}

/**
 * iPhone and iPad keep the Home Screen app's storage apart from the browser's, so a device paired in
 * Safari is a different device from the app added to the Home Screen afterwards. Point people to the
 * Home Screen before they pair.
 */
function HomeScreenFirst({ pairing }) {
  const device = appleDevice();
  return html`<div class="home-first">
    <div class="hf-head"><${Icon} name="plus-square" /><b>Add Pocket Pilot to your Home Screen first</b></div>
    <p>On ${device}, the app on your Home Screen is kept apart from the browser: a pairing made here doesn't carry over, and only the Home Screen app can notify you.</p>
    <ol>
      <li>Tap <b>Share</b> <span class="hf-ic"><${Icon} name="share" /></span> in the toolbar (under <b>⋯</b> if you don't see it).</li>
      <li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      <li>Open Pocket Pilot from your Home Screen and tap <b>Scan the QR code</b>.${pairing ? ' Scan the same code on your PC again: it works for 10 minutes, and New code on your PC makes a fresh one.' : ''}</li>
    </ol>
  </div>`;
}

export function Welcome({ onLink, onScan, installPrompt }) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const inBrowser = pairInHomeScreenApp();
  const inApp = isIos() && isStandalone();
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
    ${inBrowser && html`<${HomeScreenFirst} />`}
    <button class=${`btn block ${inBrowser ? '' : 'primary'}`} style="margin-top:14px" onClick=${onScan}><${Icon} name="phone" /> ${inBrowser ? 'Scan the QR code here instead' : 'Scan the QR code'}</button>
    ${inApp && html`<div class="ios-tip">Paired in the browser before (Safari, Chrome or Edge)? This Home Screen app doesn't share the browser's pairing, so pair it once more: tap <b>Scan the QR code</b> and scan a code from your PC. You can remove the browser's entry from <b>Paired devices</b> on your PC.</div>`}
    <ol class="steps">
      <li><div><b>Install Pocket Pilot on your PC</b><div class="muted small">The VS Code extension or the GitHub Copilot app plugin — see <a href=${PRODUCT_URL} target="_blank" rel="noopener">${PRODUCT_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>.</div></div></li>
      <li><div><b>Turn on remote access</b><div class="muted small">VS Code: “Start remote access” in the Pocket Pilot panel. Copilot app or CLI: type <b>/pocket-pilot</b> in a chat.</div></div></li>
      <li><div><b>Scan the QR code</b><div class="muted small">${inBrowser ? 'In the app on your Home Screen (see above).' : inApp ? 'With the button above. The Camera app would open the code in your browser, which pairs separately.' : 'With the button above or your camera — on a computer, paste the pairing link below.'}</div></div></li>
    </ol>
    <div class="trust">
      <div><${Icon} name="lock" size="18" /> End-to-end encrypted — even the tunnel can’t read it</div>
      <div><${Icon} name="shield" size="18" /> Only devices you approve on your PC, with Face ID / fingerprint</div>
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
    <p class="muted small center" style="margin-top:14px">Pocket Pilot ${APP_VERSION}</p>
  </div>`;
}

const STEPS = [
  ['connecting', 'Connecting securely'],
  ['approval', 'Approve on your PC'],
  ['passkey', 'Protect this device'],
  ['finishing', 'Finishing'],
];

export function PairScreen({ fragment, onPaired, onCancel, onRescan }) {
  const info = decodePairingFragment(fragment);
  const dev = deviceDescription();
  const browser = dev.platform.split(' · ')[1] || 'Safari';
  // Name the Safari and Home Screen copies apart, so the PC's list of devices tells them apart too.
  const [name, setName] = useState(pairInHomeScreenApp() ? `${dev.name} (${browser})` : dev.name);
  const platform = isIos() && isStandalone() ? `${dev.platform.split(' · ')[0]} · Home Screen app` : dev.platform;
  const setupKey = info ? fingerprintText(info.hostFingerprint) : '';
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState(null);
  const [spent, setSpent] = useState(false);
  const [here, setHere] = useState(false);
  // The second factor: a passkey, or codes from an authenticator app (set up before or during pairing).
  const [setup, setSetup] = useState(() => (info ? loadSetup(setupKey) : null));
  const [method, setMethod] = useState(() => (setup?.verified ? 'totp' : 'passkey'));
  const [canPasskey, setCanPasskey] = useState(true);
  const [ask, setAsk] = useState(null);
  const live = useRef({});
  live.current = { method, setup, canPasskey, phase };
  const gate = !!info && !phase && !here && pairInHomeScreenApp();
  useEffect(() => {
    // "Add to Home Screen" saves the current address: make it the app's start, not this pairing.
    if (gate) history.replaceState(null, '', `${location.pathname}${location.search}`);
  }, [gate]);
  useEffect(() => {
    passkeysAvailable().then((ok) => {
      setCanPasskey(ok);
      if (!ok) setMethod('totp');
    });
  }, []);
  if (!info) {
    return html`<div class="page safe"><div class="card stack"><b>Invalid pairing link</b><p class="muted">Show a new QR code in VS Code and scan it again.</p><button class="btn" onClick=${onCancel}>Back</button></div></div>`;
  }
  // Waits for the person's choice while the pairing stays open.
  const request = (q) => new Promise((resolve, reject) => {
    setAsk({ ...q, resolve: (v) => { setAsk(null); resolve(v); }, reject: (e) => { setAsk(null); reject(e); } });
  });
  const factor = async (req) => {
    const allowTotp = req.alternatives.includes('totp');
    // PCs before 0.6 don't offer alternatives at all: they only know passkeys.
    const oldPc = !req.hostKnowsTotp;
    const canPasskey = await passkeysAvailable();
    const wantsTotp = live.current.method === 'totp';
    const ready = live.current.setup;
    if (wantsTotp && allowTotp && ready?.verified) return { totp: { secret: ready.secret, code: await codeAt(ready.secret, stepAt()) } };
    const onlyPasskeys = oldPc
      ? 'Pocket Pilot on your PC is older than 0.6 and only accepts passkeys. Update it there to use an authenticator app.'
      : 'Your PC only accepts passkeys.';
    if (!canPasskey && !allowTotp) throw new Error(`${onlyPasskeys} This device has no Face ID, fingerprint or screen lock.`);
    let error = null;
    if (canPasskey && !wantsTotp) {
      // Chosen before pairing: straight to the passkey sheet where the browser allows it (older iPhones
      // need the tap on the card below).
      try {
        return { credential: await webauthn.register(req) };
      } catch (err) {
        error = err;
      }
    }
    return request({ kind: 'factor', req, error, allowTotp, canPasskey, startWithTotp: (wantsTotp || !canPasskey) && allowTotp, intro: wantsTotp && !allowTotp ? `${onlyPasskeys} Save a passkey here to finish.` : '' });
  };
  const start = async () => {
    setError(null);
    setSpent(false);
    setPhase('connecting');
    try {
      const record = await pairWithHost({ fragment, deviceName: name.trim() || dev.name, platform, factor, onStatus: setPhase });
      clearSetup(setupKey);
      setPhase('done');
      onPaired(record);
    } catch (err) {
      // Once the PC has answered, this QR code is used up: pairing again needs a new one.
      setSpent(live.current.phase !== 'connecting' || !!err.untrusted || /expired|already used/i.test(err.message || ''));
      setPhase(null);
      setAsk(null);
      setError(err.message || String(err));
    }
  };
  const idx = STEPS.findIndex(([k]) => k === phase);
  if (gate) {
    return html`<div class="page safe">
      <div class="hero" style="padding-top:12px">
        <img class="logo" src="./icons/icon.svg" alt="" style="width:64px;height:64px" />
        <h2 style="font-size:23px">Pair with ${info.name || 'your PC'}</h2>
        <p>One step first, so this ${appleDevice()} stays paired and can notify you.</p>
      </div>
      <${HomeScreenFirst} pairing=${true} />
      <button class="btn block" style="margin-top:14px" onClick=${() => setHere(true)}>Pair in ${browser} instead</button>
      <p class="muted small center" style="margin-top:8px">${browser} can't show notifications, and the Home Screen app would need its own pairing later.</p>
      <button class="btn block ghost" style="margin-top:6px" onClick=${onCancel}>Cancel</button>
    </div>`;
  }
  const totpSetup = (props) => html`<${AuthenticatorSetup} storageKey=${setupKey} hostName=${info.name || 'PC'} deviceName=${name.trim() || dev.name} ...${props} />`;
  const factorNote = method === 'totp' ? 'Using the code from your authenticator app.' : passkeyHint();
  const needsSetup = method === 'totp' && !setup?.verified;
  const choice = (value, icon, title, sub) => html`<button type="button" role="radio" aria-checked=${method === value} class=${`choice-opt ${method === value ? 'on' : ''}`} onClick=${() => setMethod(value)}>
    <span class="choice-dot"></span><${Icon} name=${icon} /><span><b>${title}</b><small>${sub}</small></span>
  </button>`;
  return html`<div class="page safe">
    <div class="hero" style="padding-top:12px">
      <img class="logo" src="./icons/icon.svg" alt="" style="width:64px;height:64px" />
      <h2 style="font-size:23px">Pair with ${info.name || 'your PC'}</h2>
      <p>Check that this fingerprint matches the one under the QR code on your PC:</p>
      <p style="margin-top:10px"><span class="fingerprint">${fingerprintText(info.hostFingerprint)}</span></p>
    </div>
    ${!phase && html`<div class="card stack">
      <div class="field"><label>Name this device</label><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} maxlength="60" /></div>
      ${canPasskey
        ? html`<div class="field"><label>Confirm it's you with</label>
          <div class="choice" role="radiogroup" aria-label="Confirm it's you with">
            ${choice('passkey', 'lock', 'Face ID or fingerprint', `A passkey, saved in ${isIos() ? 'the Passwords app' : 'your password manager'}`)}
            ${choice('totp', 'key', 'A code from an authenticator app', 'Microsoft Authenticator, Google Authenticator or similar')}
          </div>
          ${method === 'passkey' && html`<p class="muted small choice-note">Want to use Microsoft Authenticator? Choose <b>A code from an authenticator app</b>: it can't keep passkeys for Pocket Pilot.</p>`}
        </div>`
        : html`<p class="muted small">This device can't save passkeys (no Face ID, fingerprint or screen lock), so it uses a code from an authenticator app.</p>`}
      ${method === 'totp' && setup?.verified && html`<div class="authn-ready"><${Icon} name="check" /> Your authenticator app is set up.</div>`}
    </div>`}
    ${!phase && needsSetup && totpSetup({ note: null, onReady: (s) => setSetup(s) })}
    ${!phase && html`<div class="stack pair-actions">
      ${error && html`<div class="errpart">${error}${spent ? ' To pair, click New code on your PC and scan the new QR code.' : ''}</div>`}
      ${spent
        ? html`${onRescan && html`<button class="btn primary block" onClick=${onRescan}><${Icon} name="phone" /> Scan a new QR code</button>`}`
        : html`<button class="btn primary block" disabled=${needsSetup} onClick=${start}><${Icon} name="lock" /> ${needsSetup ? 'Set up the app above to pair' : 'Pair securely'}</button>`}
      <button class="btn block" onClick=${onCancel}>Cancel</button>
      <p class="muted small center">Pocket Pilot ${APP_VERSION}</p>
    </div>`}
    ${phase && html`<div class="progress-steps">
      ${STEPS.map(([k, label], i) => html`<div class=${`ps ${i === idx ? 'active' : i < idx || phase === 'done' ? 'done' : ''}`}>
        ${i === idx && phase !== 'done' ? html`<${Spinner} />` : i < idx || phase === 'done' ? html`<${Icon} name="check" size="18" />` : html`<span class="dot"></span>`}
        <div><div>${label}</div>${i === idx && k === 'approval' && html`<div class="muted small">Click “Allow” on your PC — in VS Code, or on the Pocket Pilot page the Copilot app opened.</div>`}${i === idx && k === 'passkey' && !ask && html`<div class="muted small">${factorNote}</div>`}</div>
      </div>`)}
    </div>`}
    ${ask?.kind === 'factor' && html`<${FactorChooser} error=${ask.error} register=${() => webauthn.register(ask.req)} allowTotp=${ask.allowTotp} canPasskey=${ask.canPasskey} startWithTotp=${ask.startWithTotp}
      storageKey=${setupKey} hostName=${info.name || 'PC'} deviceName=${name.trim() || dev.name} intro=${ask.intro}
      onDone=${(r) => ask.resolve(r)} onCancel=${() => ask.reject(new Error('Pairing cancelled'))} />`}
  </div>`;
}
