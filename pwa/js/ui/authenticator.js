// Authenticator apps and passkey trouble: setting up six-digit codes (the alternative to a passkey),
// entering one when the PC asks again, and what to do when a passkey couldn't be saved.
import { html, useState, useEffect, useRef } from '../lib/ui.js';
import { Icon, Sheet, toast } from './common.js';
import { newSecret, otpauthUri, verifyCode, normalizeCode, codeAt, stepAt, DIGITS } from '../core/totp.js';
import { isIos } from '../lib/push.js';

const SETUP_TTL_MS = 60 * 60 * 1000;

// The setup key stays on this device only until pairing finishes. It survives a reload or a new QR code,
// so a pairing that broke off while the person was in their authenticator app doesn't need a new key.
export function loadSetup(key) {
  try {
    const s = JSON.parse(sessionStorage.getItem(`pp:totp:${key}`) || 'null');
    return s && Date.now() - s.at < SETUP_TTL_MS ? s : null;
  } catch {
    return null;
  }
}

function saveSetup(key, setup) {
  try {
    sessionStorage.setItem(`pp:totp:${key}`, JSON.stringify(setup));
  } catch {
    /* private mode: kept in memory only */
  }
}

export function clearSetup(key) {
  try {
    sessionStorage.removeItem(`pp:totp:${key}`);
  } catch {
    /* ignore */
  }
}

const onPhone = () => isIos() || /android/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;

/** Six-digit code field: numbers only, one-time-code autofill, submits itself when complete. */
export function CodeInput({ onSubmit, disabled, autoFocus = true }) {
  const [value, setValue] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);
  const change = (e) => {
    const v = normalizeCode(e.target.value).slice(0, DIGITS);
    setValue(v);
    if (v.length === DIGITS) onSubmit(v, () => setValue(''));
  };
  return html`<div class="code-row">
    <input ref=${ref} class="input code-input" value=${value} onInput=${change} disabled=${disabled}
      inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="7" placeholder="123456" aria-label="Six-digit code" />
    <button class="btn primary" disabled=${disabled || value.length !== DIGITS} onClick=${() => onSubmit(value, () => setValue(''))}>Confirm</button>
  </div>`;
}

/** The QR code of the otpauth link, for an authenticator app on another device. */
function OtpQr({ uri }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    import('../../vendor/qrcode/qrcode.mjs').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M');
      qr.addData(uri);
      qr.make();
      if (live) setSvg(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [uri]);
  return html`<div class="otp-qr" dangerouslySetInnerHTML=${{ __html: svg }}></div>`;
}

/**
 * Adds Pocket Pilot to an authenticator app: on a phone the setup key is copied and pasted into the app
 * (a link can't open Microsoft or Google Authenticator on an iPhone: iOS hands it to Apple Passwords), on
 * a computer the phone's app scans a QR code. A code from the app proves it went in; calls onReady({ secret }).
 * `live` marks a pairing that is already waiting on the PC, which switching apps can cut off.
 */
export function AuthenticatorSetup({ storageKey, hostName, deviceName, onReady, onPasskey, onCancel, note, live }) {
  const [setup] = useState(() => {
    const saved = loadSetup(storageKey);
    if (saved) return saved;
    const s = { secret: newSecret(), account: `${hostName} · ${deviceName}`, verified: false, at: Date.now() };
    saveSetup(storageKey, s);
    return s;
  });
  const phone = onPhone();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(() => !phone);
  const uri = otpauthUri({ secret: setup.secret, account: setup.account });
  const grouped = setup.secret.match(/.{1,4}/g).join(' ');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      toast('Setup key copied');
    } catch {
      toast('Copy failed: select the key and copy it', 'err');
    }
  };
  const check = async (code, reset) => {
    if ((await verifyCode(setup.secret, code, { window: 2 })) === null) {
      setError("That code doesn't match. Check that the whole setup key went into your authenticator app, then enter the code it shows now.");
      reset();
      return;
    }
    const done = { ...setup, verified: true, at: Date.now() };
    saveSetup(storageKey, done);
    onReady(done);
  };
  return html`<div class="card stack authn">
    <div class="authn-head"><${Icon} name="key" /><b>Set up your authenticator app</b></div>
    <p class="muted small">${note || 'Your PC will ask for a 6-digit code from it now and then (every 12 hours by default), instead of Face ID.'}</p>
    ${live && html`<div class="authn-warn">Your PC is waiting. If switching apps disconnects the pairing, click <b>New code</b> on your PC and scan it again: this setup is kept.</div>`}
    <ol class="authn-steps">
      ${phone ? html`<li>
        <div><b>Copy the setup key</b></div>
        <button class=${`btn block ${copied ? '' : 'primary'}`} onClick=${copy}><${Icon} name=${copied ? 'check' : 'copy'} /> ${copied ? 'Copied' : 'Copy setup key'}</button>
        <div class="muted small">Setup key: <code class="authn-key">${grouped}</code></div>
      </li>
      <li>
        <div><b>Add it to your authenticator app</b></div>
        <ul class="authn-apps">
          <li><b>Microsoft Authenticator:</b> tap <b>+</b> → <b>Other (Google, Facebook, etc.)</b> → <b>Or enter code manually</b>. Name the account <b>Pocket Pilot</b>, paste the key as the secret key and tap <b>Finish</b>.</li>
          <li><b>Google Authenticator:</b> tap <b>+</b> → <b>Enter a setup key</b>. Name it <b>Pocket Pilot</b>, paste the key and tap <b>Add</b>.</li>
        </ul>
        <div class="authn-actions">
          <a class="btn sm ghost" href=${uri}>${isIos() ? 'Or use Apple Passwords' : 'Or open it in my authenticator app'}</a>
          ${!showQr && html`<button class="btn sm ghost" onClick=${() => setShowQr(true)}>Authenticator on another device?</button>`}
        </div>
        ${showQr && html`<div class="authn-qr"><${OtpQr} uri=${uri} /><span class="muted small">Scan this with the authenticator app on your other device.</span></div>`}
      </li>` : html`<li>
        <div><b>Scan this with the authenticator app on your phone</b> (Microsoft Authenticator: <b>+</b> → <b>Other (Google, Facebook, etc.)</b>)</div>
        <div class="authn-qr"><${OtpQr} uri=${uri} /></div>
        <div class="muted small">Or enter the setup key by hand: <code class="authn-key">${grouped}</code> <button class="btn sm ghost" onClick=${copy}>Copy</button></div>
      </li>`}
      <li>
        <div><b>Enter the 6-digit code it shows for Pocket Pilot</b></div>
        <${CodeInput} onSubmit=${check} autoFocus=${false} />
        ${error && html`<div class="errpart">${error}</div>`}
      </li>
    </ol>
    ${(onPasskey || onCancel) && html`<div class="authn-foot">
      ${onPasskey && html`<button class="btn sm ghost" onClick=${onPasskey}>Use Face ID or a passkey instead</button>`}
      ${onCancel && html`<button class="btn sm ghost" onClick=${onCancel}>Cancel</button>`}
    </div>`}
  </div>`;
}

/** Where to steer the passkey: iOS offers every app turned on for passwords, Microsoft Authenticator included. */
export function passkeyHint() {
  return isIos()
    ? 'When your iPhone asks where to save the passkey, choose Passwords. Microsoft Authenticator can only keep passkeys for work accounts.'
    : 'Save the passkey in your password manager. Microsoft Authenticator can only keep passkeys for work accounts.';
}

/** Why a passkey couldn't be made (or used, when `use`), in words people can act on. */
export function passkeyTrouble(err, use = false) {
  const name = err?.name || '';
  if (use) {
    return {
      title: "Face ID or your passkey didn't go through",
      text: "If you cancelled, tap Try again. If this device can't find the passkey anymore (it was saved in an app you've since turned off or removed, such as Microsoft Authenticator or 1Password), tap Set up this device again: your PC asks you to allow it, then you save a new passkey or use an authenticator app.",
    };
  }
  if (name === 'NotAllowedError' || /not allowed|denied|cancel/i.test(err?.message || '')) {
    return {
      title: "The passkey wasn't saved",
      text: `Microsoft Authenticator and Google Authenticator can't keep passkeys for Pocket Pilot, only 6-digit codes. To use one of them, choose Use an authenticator app. Or tap Try the passkey again and save it in ${isIos() ? 'Passwords' : 'your password manager (Google Password Manager, 1Password, Bitwarden…)'}.`,
      totpFirst: true,
    };
  }
  if (name === 'InvalidStateError') return { title: 'This device already has a passkey for your PC', text: 'Tap Try again to make a new one, or use an authenticator app.' };
  if (/No Face ID|no passkey|not supported/i.test(err?.message || '') || name === 'NotSupportedError') {
    return { title: "This device can't save passkeys", text: 'It has no Face ID, fingerprint or screen lock set up, or the browser has no passkey support. Use an authenticator app instead, or set up a screen lock and try again.', totpFirst: true };
  }
  return { title: "The passkey couldn't be created", text: String(err?.message || err || 'Something went wrong.') };
}

/**
 * Protects a device with a passkey (Face ID, fingerprint…) or an authenticator app. The passkey is made
 * right from the tap: iPhones before iOS 17.4 only show the passkey sheet then. `live` marks a pairing or
 * reconnect that is waiting on the PC meanwhile.
 */
export function FactorChooser({ error: firstError, register, allowTotp, canPasskey = true, startWithTotp = false, storageKey, hostName, deviceName, intro, onDone, onCancel, live = true }) {
  const [mode, setMode] = useState(startWithTotp && allowTotp ? 'totp' : 'choose');
  const [error, setError] = useState(firstError || null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    register().then((credential) => onDone({ credential }), (err) => {
      setError(err);
      setBusy(false);
    });
  };
  if (mode === 'totp') {
    return html`<${AuthenticatorSetup} storageKey=${storageKey} hostName=${hostName} deviceName=${deviceName} live=${live}
      note=${canPasskey ? null : "This device can't save passkeys, so your PC will ask for a 6-digit code from your authenticator app now and then."}
      onReady=${async (s) => onDone({ totp: { secret: s.secret, code: await codeAt(s.secret, stepAt()) } })}
      onPasskey=${canPasskey ? () => setMode('choose') : null} onCancel=${onCancel} />`;
  }
  const t = error ? passkeyTrouble(error) : null;
  const totpFirst = allowTotp && (!canPasskey || t?.totpFirst);
  const passkeyButton = canPasskey && html`<button class=${`btn block ${totpFirst ? '' : 'primary'}`} disabled=${busy} onClick=${save}><${Icon} name=${t ? 'refresh' : 'lock'} /> ${t ? 'Try the passkey again' : 'Save a passkey (Face ID)'}</button>`;
  const totpButton = allowTotp && html`<button class=${`btn block ${totpFirst ? 'primary' : ''}`} onClick=${() => setMode('totp')}><${Icon} name="key" /> Use an authenticator app</button>`;
  return html`<div class="card stack trouble">
    <div class=${`authn-head ${t ? 'warn' : ''}`}><${Icon} name=${t ? 'alert-circle' : 'lock'} /><b>${t ? t.title : 'Protect this device'}</b></div>
    <p class="small">${t ? t.text : intro || "Save a passkey: from now on Face ID, Touch ID or your fingerprint confirms it's you. Or use 6-digit codes from an authenticator app such as Microsoft Authenticator."}</p>
    ${totpFirst ? html`${totpButton}${passkeyButton}` : html`${passkeyButton}${totpButton}`}
    ${canPasskey && !t && html`<p class="muted small">${passkeyHint()}</p>`}
    <button class="btn block ghost" onClick=${onCancel}>Cancel</button>
  </div>`;
}

function PasskeyBody({ request }) {
  const [error, setError] = useState(request.error || null);
  const [busy, setBusy] = useState(false);
  const use = () => {
    setBusy(true);
    request.assert().then((assertion) => request.resolve(assertion), (err) => {
      setError(err);
      setBusy(false);
    });
  };
  const t = error ? passkeyTrouble(error, true) : null;
  return html`<div class="stack">
    ${t && html`<div class="authn-head warn"><${Icon} name="alert-circle" /><b>${t.title}</b></div>`}
    <p class="muted" style="margin:0">${t ? t.text : `Use Face ID, Touch ID or your fingerprint to reconnect to ${request.hostName || 'your PC'}.`}</p>
    <button class="btn primary block" disabled=${busy} onClick=${use}><${Icon} name=${error ? 'refresh' : 'lock'} /> ${error ? 'Try again' : 'Use Face ID or fingerprint'}</button>
    ${error && html`<button class="btn block" onClick=${() => request.resolve({ reset: true })}><${Icon} name="key" /> Set up this device again</button>`}
  </div>`;
}

/** The PC asks for the passkey again (every 12 hours by default) and the browser needs a tap for it. */
export function PasskeySheet({ request, onCancel }) {
  if (!request) return null;
  return html`<${Sheet} open=${true} onClose=${onCancel} title="Confirm it's you" doneLabel="Cancel"><${PasskeyBody} request=${request} /></${Sheet}>`;
}

/** After a yes on the PC: a new passkey or an authenticator app for this device. */
export function FactorSheet({ request, onCancel }) {
  if (!request) return null;
  return html`<${Sheet} open=${true} onClose=${onCancel} title="Set up this device again" doneLabel="Cancel">
    <${FactorChooser} register=${request.register} allowTotp=${request.allowTotp} canPasskey=${request.canPasskey}
      storageKey=${request.storageKey} hostName=${request.hostName} deviceName=${request.deviceName}
      intro="Your PC allowed it. Save a new passkey, or use codes from an authenticator app from now on."
      onDone=${request.resolve} onCancel=${onCancel} />
  </${Sheet}>`;
}

/** The PC asks for a code again (every 12 hours by default). */
export function CodeSheet({ request, onSubmit, onCancel, onReset }) {
  if (!request) return null;
  return html`<${Sheet} open=${true} onClose=${onCancel} title="Confirm it's you" doneLabel="Cancel">
    <div class="stack">
      <p class="muted" style="margin:0">Open your authenticator app and enter the code for <b>Pocket Pilot</b> · ${request.hostName}${request.deviceName ? ` · ${request.deviceName}` : ''}.</p>
      ${request.wrong && html`<div class="errpart">That code didn't match. Enter the code your authenticator app shows now.</div>`}
      <${CodeInput} onSubmit=${(code) => onSubmit(code)} />
      ${onReset && html`<button class="btn block ghost" onClick=${onReset}>Lost your authenticator app? Set up this device again</button>`}
    </div>
  </${Sheet}>`;
}
