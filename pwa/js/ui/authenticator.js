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
 * Adds Pocket Pilot to an authenticator app: the key goes in by link, QR code or by hand, and a code
 * the app shows proves it went in. Calls onReady({ secret }) once it has.
 */
export function AuthenticatorSetup({ storageKey, hostName, deviceName, onReady, onPasskey, onCancel, note }) {
  const [setup] = useState(() => {
    const saved = loadSetup(storageKey);
    if (saved) return saved;
    const s = { secret: newSecret(), account: `${hostName} · ${deviceName}`, verified: false, at: Date.now() };
    saveSetup(storageKey, s);
    return s;
  });
  const [error, setError] = useState('');
  const [showQr, setShowQr] = useState(() => !onPhone());
  const uri = otpauthUri({ secret: setup.secret, account: setup.account });
  const grouped = setup.secret.match(/.{1,4}/g).join(' ');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setup.secret);
      toast('Setup key copied');
    } catch {
      toast('Copy failed: select the key and copy it', 'err');
    }
  };
  const check = async (code, reset) => {
    if ((await verifyCode(setup.secret, code, { window: 2 })) === null) {
      setError("That code doesn't match. Check that you added the key above (Pocket Pilot · " + setup.account + '), then enter the code it shows now.');
      reset();
      return;
    }
    const done = { ...setup, verified: true, at: Date.now() };
    saveSetup(storageKey, done);
    onReady(done);
  };
  return html`<div class="card stack authn">
    <div class="authn-head"><${Icon} name="key" /><b>Use an authenticator app</b></div>
    ${note && html`<p class="muted small">${note}</p>`}
    <ol class="authn-steps">
      <li>
        <div>Add Pocket Pilot to your authenticator app (Google Authenticator, Microsoft Authenticator, the Passwords app, 1Password…).</div>
        <div class="authn-actions">
          ${onPhone() && html`<a class="btn primary sm" href=${uri}><${Icon} name="plus-square" /> Add to authenticator app</a>`}
          <button class="btn sm" onClick=${copy}><${Icon} name="copy" /> Copy setup key</button>
          ${!showQr && html`<button class="btn sm ghost" onClick=${() => setShowQr(true)}>Show QR code</button>`}
        </div>
        ${showQr && html`<div class="authn-qr"><${OtpQr} uri=${uri} /><span class="muted small">Scan with the authenticator app on your phone.</span></div>`}
        <div class="muted small">Setup key: <code class="authn-key">${grouped}</code></div>
      </li>
      <li>
        <div>Enter the 6-digit code it shows for <b>Pocket Pilot · ${setup.account}</b>:</div>
        <${CodeInput} onSubmit=${check} autoFocus=${false} />
        ${error && html`<div class="errpart">${error}</div>`}
      </li>
    </ol>
    <div class="authn-foot">
      ${onPasskey && html`<button class="btn sm ghost" onClick=${onPasskey}>Use Face ID or a passkey instead</button>`}
      ${onCancel && html`<button class="btn sm ghost" onClick=${onCancel}>Cancel</button>`}
    </div>
  </div>`;
}

/** Why a passkey couldn't be made (or used, when `use`), in words people can act on. */
export function passkeyTrouble(err, use = false) {
  const name = err?.name || '';
  const iphone = isIos();
  const android = /android/i.test(navigator.userAgent);
  const where = iphone
    ? 'To change where passkeys go by default: Settings → General → AutoFill & Passwords.'
    : android
      ? 'To change where passkeys go by default: Settings → Passwords & accounts (or Google → Autofill).'
      : '';
  if (use) {
    return {
      title: "Face ID or your passkey didn't go through",
      text: "If you cancelled, tap Try again. If this device can't find the passkey anymore (it was saved in an app you've since turned off or removed, such as Microsoft Authenticator or 1Password), tap Set up this device again: your PC asks you to allow it, then you save a new passkey or use an authenticator app.",
    };
  }
  if (name === 'NotAllowedError' || /not allowed|denied|cancel/i.test(err?.message || '')) {
    return {
      title: "The passkey wasn't saved",
      text: `It was cancelled, or the app that was asked to keep it said no. Microsoft Authenticator only keeps passkeys for Microsoft work and school accounts, and Google Authenticator keeps none at all. Tap Try again and pick another place (under Other options, or Save another way): the Passwords app, Google Password Manager, 1Password or Bitwarden. ${where}`.trim(),
    };
  }
  if (name === 'InvalidStateError') return { title: 'This device already has a passkey for your PC', text: 'Tap Try again to make a new one, or use an authenticator app.' };
  if (/No Face ID|no passkey|not supported/i.test(err?.message || '') || name === 'NotSupportedError') {
    return { title: "This device can't save passkeys", text: 'It has no Face ID, fingerprint or screen lock set up, or the browser has no passkey support. Use an authenticator app instead, or set up a screen lock and try again.' };
  }
  return { title: "The passkey couldn't be created", text: String(err?.message || err || 'Something went wrong.') };
}

/**
 * Protects a device with a passkey (Face ID, fingerprint…) or an authenticator app. The passkey is made
 * right from the tap: iPhones before iOS 17.4 only show the passkey sheet then.
 */
export function FactorChooser({ error: firstError, register, allowTotp, canPasskey = true, startWithTotp = false, storageKey, hostName, deviceName, intro, onDone, onCancel }) {
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
    return html`<${AuthenticatorSetup} storageKey=${storageKey} hostName=${hostName} deviceName=${deviceName}
      note=${canPasskey ? 'Your PC will ask for a code from your authenticator app now and then, instead of Face ID.' : "This device can't save passkeys, so your PC will ask for a code from your authenticator app now and then."}
      onReady=${async (s) => onDone({ totp: { secret: s.secret, code: await codeAt(s.secret, stepAt()) } })}
      onPasskey=${canPasskey ? () => setMode('choose') : null} onCancel=${onCancel} />`;
  }
  const t = error ? passkeyTrouble(error) : null;
  return html`<div class="card stack trouble">
    <div class=${`authn-head ${t ? 'warn' : ''}`}><${Icon} name=${t ? 'alert-circle' : 'lock'} /><b>${t ? t.title : 'Protect this device'}</b></div>
    <p class="small">${t ? t.text : intro || "Save a passkey: from now on Face ID, Touch ID or your fingerprint confirms it's you. Or use codes from an authenticator app."}</p>
    ${canPasskey && html`<button class="btn primary block" disabled=${busy} onClick=${save}><${Icon} name=${t ? 'refresh' : 'lock'} /> ${t ? 'Try again' : 'Save a passkey'}</button>`}
    ${allowTotp && html`<button class=${`btn block ${canPasskey ? '' : 'primary'}`} onClick=${() => setMode('totp')}><${Icon} name="key" /> Use an authenticator app${canPasskey ? ' instead' : ''}</button>`}
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
  return html`<${Sheet} open=${true} onClose=${onCancel} title="Confirm it's you"><${PasskeyBody} request=${request} /></${Sheet}>`;
}

/** After a yes on the PC: a new passkey or an authenticator app for this device. */
export function FactorSheet({ request, onCancel }) {
  if (!request) return null;
  return html`<${Sheet} open=${true} onClose=${onCancel} title="Set up this device again">
    <${FactorChooser} register=${request.register} allowTotp=${request.allowTotp} canPasskey=${request.canPasskey}
      storageKey=${request.storageKey} hostName=${request.hostName} deviceName=${request.deviceName}
      intro="Your PC allowed it. Save a new passkey, or use codes from an authenticator app from now on."
      onDone=${request.resolve} onCancel=${onCancel} />
  </${Sheet}>`;
}

/** The PC asks for a code again (every 12 hours by default). */
export function CodeSheet({ request, onSubmit, onCancel, onReset }) {
  if (!request) return null;
  return html`<${Sheet} open=${true} onClose=${onCancel} title="Confirm it's you">
    <div class="stack">
      <p class="muted" style="margin:0">Open your authenticator app and enter the code for <b>Pocket Pilot</b> · ${request.hostName}${request.deviceName ? ` · ${request.deviceName}` : ''}.</p>
      ${request.wrong && html`<div class="errpart">That code didn't match. Enter the code your authenticator app shows now.</div>`}
      <${CodeInput} onSubmit=${(code) => onSubmit(code)} />
      ${onReset && html`<button class="btn block ghost" onClick=${onReset}>Lost your authenticator app? Set up this device again</button>`}
    </div>
  </${Sheet}>`;
}
