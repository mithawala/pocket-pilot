// Pocket Pilot sidebar (VS Code webview). Renders the state object posted by the extension.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const logo = root.dataset.logo;
  let state = null;
  let skew = 0;
  let showQr = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() + skew - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  function countdown(expiresAt) {
    const s = Math.max(0, Math.round((expiresAt - Date.now() - skew) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function pill(state) {
    const map = {
      running: ['on', 'Remote access on'],
      starting: ['busy', 'Starting…'],
      standby: ['idle', 'Standby'],
      error: ['err', 'Needs attention'],
      stopped: ['idle', 'Off'],
    };
    const [cls, label] = map[state] || map.stopped;
    return `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
  }

  function row(icon, title, value, cls = '') {
    return `<div class="row ${cls}"><span class="ri">${icon}</span><span class="rt">${title}</span><span class="rv">${value}</span></div>`;
  }

  function render() {
    if (!state) {
      root.innerHTML = '<div class="empty">Loading…</div>';
      return;
    }
    const st = state;
    let body = '';
    const header = `<header><img class="logo" src="${esc(logo)}" alt=""><div><h1>Pocket Pilot</h1><div class="sub">Your agents, in your pocket</div></div>${pill(st.state)}</header>`;

    if (st.state === 'stopped' || (st.state === 'error' && !st.tunnel?.url)) {
      body += `<section class="card hero">
        <p class="lead">Chat with your Copilot and Claude sessions, approve tool calls and get notified — from your phone, anywhere.</p>
        <ul class="bullets">
          <li><span>🔒</span>End-to-end encrypted — the tunnel only sees ciphertext</li>
          <li><span>🪪</span>Paired devices only, protected by Face ID / fingerprint</li>
          <li><span>💸</span>Free: Cloudflare quick tunnel + GitHub Pages, no servers</li>
        </ul>
        ${st.error ? `<div class="error">${esc(st.error)}</div>` : ''}
        <button class="primary big" data-a="start">${st.state === 'error' ? 'Try again' : 'Start remote access'}</button>
      </section>`;
    } else if (st.state === 'starting') {
      body += `<section class="card center"><div class="spinner"></div><p>Opening a secure tunnel…</p></section>`;
    } else if (st.state === 'standby') {
      body += `<section class="card">
        <p class="lead">Pocket Pilot is running in another VS Code window${st.standby?.label ? ` (<b>${esc(st.standby.label)}</b>)` : ''}.</p>
        <p class="muted">Only one window hosts the tunnel. Your devices see the sessions of every window either way.</p>
        <button class="secondary" data-a="takeOver">Move it to this window</button>
      </section>`;
    } else {
      if (st.mirror) {
        body += `<div class="mirror"><span>Hosted by the <b>${esc(st.mirror.label)}</b> window — your devices see every window's sessions.</span><button class="link" data-a="takeOver">Move here</button></div>`;
      }
      const devices = st.devices || [];
      const qrOpen = showQr || devices.length === 0;
      if (qrOpen) {
        if (st.pairing) {
          // The app lives at a fixed address; the QR code opens it with a one-time pairing code.
          const appUrl = st.settings?.pwaUrl && !st.settings?.pwaFallback ? st.settings.pwaUrl : null;
          const appHost = appUrl ? appUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
          body += `<section class="card qr-card">
            <h2>Pair a device</h2>
            ${appUrl ? `<ol class="pair-steps">
              <li>On your device, open <a href="#" data-a="openUrl" data-url="${esc(appUrl)}">${esc(appHost)}</a><span class="muted"> — on a phone or tablet, add it to your Home Screen first and pair from there</span></li>
              <li>Tap <b>Scan the QR code</b> in the app, or point your camera at it:</li>
            </ol>` : '<p class="scan">Scan with your phone or tablet camera</p>'}
            <div class="qr">${st.pairing.svg}</div>
            <p class="muted small">Single use · expires in <b id="cd">${countdown(st.pairing.expiresAt)}</b></p>
            <div class="btns"><button class="secondary" data-a="newCode">New code</button><button class="secondary" data-a="copyLink">Copy link</button></div>
            ${appUrl ? '<ol class="pair-steps" start="3"><li>Click <b>Allow</b> when VS Code asks, then confirm with Face ID, your fingerprint or Windows Hello.</li></ol>' : ''}
            <p class="muted small">Another computer? Open the copied link there.</p>
            <p class="muted small fp">PC fingerprint <code>${esc(st.fingerprint)}</code></p>
            ${st.settings?.pwaFallback ? `<p class="warn small">The Pocket Pilot app isn't published at ${esc(st.settings.pwaUrl)} yet — this code uses the copy served through the tunnel (re-pair after VS Code restarts).</p>` : ''}
            ${devices.length ? '<button class="link" data-a="hideQr">Hide</button>' : ''}
          </section>`;
        } else {
          body += `<section class="card center"><div class="spinner"></div><p>Waiting for the tunnel…</p></section>`;
        }
      } else {
        body += `<button class="primary wide" data-a="showQr">＋ Pair another device</button>`;
      }

      const t = st.tunnel || {};
      const ah = st.agentHost || {};
      const c = ah.counts;
      // The address is only the PC's end of the tunnel (devices open the app and find it themselves): status only.
      const tunnelVal = t.mode === 'none' ? 'Off (this PC only)' : t.url && !(t.state === 'error' && t.error) ? `<span class="${t.reachable ? 'ok' : 'muted'}" title="${esc(t.url)}">${t.reachable ? 'Online ✓' : 'Connecting…'}</span>` : `<span class="muted">${esc(t.error || t.state || 'starting')}</span>`;
      const hostVal = ah.connected && c ? `${c.total} sessions${c.running ? ` · ${c.running} running` : ''}${c.inputNeeded ? ` · <b class="warn">${c.inputNeeded} waiting</b>` : ''}` : ah.found ? '<span class="muted">connecting…</span>' : '<span class="warn">not found — open a chat session</span>';
      const r = st.rendezvous || {};
      const rdvVal = !r.enabled ? '<span class="muted">off</span>' : r.status === 'ready' ? '<span class="ok">on ✓</span>' : `<button class="link" data-a="signInRendezvous">Enable (GitHub sign-in)</button>${r.error ? `<div class="error small">${esc(r.error)}</div>` : ''}`;
      const sec = st.settings || {};
      body += `<section class="card">
        ${row('🌐', 'Tunnel', tunnelVal)}
        ${row('🤖', 'Agent host', hostVal)}
        ${row('🔁', 'Auto-reconnect', rdvVal)}
        ${row('🛡️', 'Security', `${sec.passkey === 'off' ? 'Keys + E2E' : `${sec.allowTotp === false ? 'Passkey' : 'Passkey or code'} ${sec.passkey === 'required' ? 'required' : 'optional'}`}${sec.requireApproval ? ' · approval' : ''}`)}
      </section>`;

      body += `<section class="card"><h2>Paired devices <span class="count">${devices.length}</span></h2>`;
      if (!devices.length) body += '<p class="muted">No devices yet — scan the QR code above.</p>';
      for (const d of devices) {
        const status = d.online ? (d.visible ? '<span class="badge on">● Online</span>' : '<span class="badge away">● Background</span>') : `<span class="muted small">seen ${ago(d.lastSeenAt)}</span>`;
        body += `<div class="device">
          <div class="dicon">${/mac|windows|linux|cros/i.test(d.platform || '') ? '💻' : '📱'}</div>
          <div class="dmain"><div class="dname">${esc(d.name)}</div><div class="dmeta">${esc(d.platform || 'Device')} ${status}</div>
          <div class="dtags">${d.passkey ? '<span title="Passkey (biometric) protected">🔐 passkey</span>' : d.totp ? '<span title="Protected by codes from an authenticator app">🔢 authenticator</span>' : '<span class="muted" title="No passkey or authenticator app">🔓 no passkey</span>'}${d.push ? '<span title="Push notifications enabled">🔔 push</span>' : ''}</div></div>
          <button class="icon" title="Remove this device" data-a="removeDevice" data-id="${esc(d.id)}">✕</button>
        </div>`;
      }
      body += '</section>';

      body += `<div class="footer">
        <button class="secondary" data-a="stop">Stop</button>
        <button class="secondary" data-a="restartTunnel" ${t.mode !== 'quick' ? 'disabled' : ''} title="Get a new tunnel address. Paired devices find it through auto-reconnect.">New tunnel</button>
        <button class="secondary" data-a="openLocal" title="Open Pocket Pilot in this PC's browser, paired with a one-time link">Open in browser</button>
      </div>`;
    }
    body += `<div class="links"><button class="link" data-a="settings">Settings</button> · <button class="link" data-a="logs">Logs</button></div>`;
    const update = st.update ? `<div class="update"><span>Pocket Pilot <b>${esc(st.update.version)}</b> is available.</span><button class="primary" data-a="installUpdate">Update</button><button class="link" data-a="updateNotes">What's new</button></div>` : '';
    root.innerHTML = header + update + body;
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    e.preventDefault();
    const a = el.dataset.a;
    if (a === 'showQr') {
      showQr = true;
      send('newCode');
      return render();
    }
    if (a === 'hideQr') {
      showQr = false;
      return render();
    }
    if (a === 'openUrl') return send('openUrl', { url: el.dataset.url });
    send(a, { id: el.dataset.id });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'state') {
      skew = (m.now || Date.now()) - Date.now();
      state = m.state;
      render();
    }
  });

  setInterval(() => {
    const cd = document.getElementById('cd');
    if (cd && state?.pairing) cd.textContent = countdown(state.pairing.expiresAt);
  }, 1000);

  render();
  send('ready');
})();
