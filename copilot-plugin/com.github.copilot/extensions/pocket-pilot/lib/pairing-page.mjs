// The local pairing page the /pocket-pilot command opens: QR code, link, approval prompts and paired
// devices. Served by the hub on 127.0.0.1 only, behind a random key (never through the tunnel).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function pairingPage({ key, hostName, embed = false, appUrl = 'https://mithawala.github.io/pocket-pilot/app/' }) {
  const appHost = String(appUrl).replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pocket Pilot · Pair a device</title>
<style>
:root{--bg:#282c34;--bg2:#21252b;--line:#3a3f4b;--text:#abb2bf;--strong:#d7dae0;--muted:#7f848e;--accent:#61afef;--btn:#4d78cc;--ok:#98c379;--warn:#e5c07b;--err:#e06c75;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:grid;place-items:center;padding:24px}
.card{width:min(880px,100%);display:grid;grid-template-columns:320px 1fr;gap:28px;background:var(--bg2);border:1px solid #181a1f;border-radius:12px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
@media(max-width:720px){.card{grid-template-columns:1fr}}
h1{margin:0 0 4px;font-size:20px;color:var(--strong)}h2{margin:18px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.qr{background:#fff;border-radius:10px;padding:10px;aspect-ratio:1;display:grid;place-items:center}.qr svg{width:100%;height:100%}
.qr.wait{background:#1d2025;border:1px dashed var(--line);color:var(--muted);text-align:center;padding:24px}
.muted{color:var(--muted)}.small{font-size:12.5px}ol{margin:6px 0 0;padding-left:20px}li{margin:4px 0}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.brand{display:flex;gap:12px;align-items:center;margin-bottom:10px}.brand img{width:40px;height:40px;border-radius:9px}
button{font:inherit;border:1px solid var(--line);background:#2c313a;color:var(--strong);border-radius:6px;padding:7px 12px;cursor:pointer}button.primary{background:var(--btn);border-color:transparent;color:#fff}button:hover{filter:brightness(1.1)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:99px;background:#2c313a;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.ok .dot{background:var(--ok)}.busy .dot{background:var(--warn)}.err .dot{background:var(--err)}
.approve{border:1px solid var(--warn);background:rgba(229,192,123,.08);border-radius:8px;padding:12px 14px;margin:12px 0}.approve b{color:var(--strong)}
.dev{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #2c313a}.dev:first-child{border-top:none}
code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px;color:var(--strong)}.link{word-break:break-all;font-size:11.5px;color:var(--muted);max-height:3.2em;overflow:hidden}
.warn{color:var(--warn)}.err{color:var(--err)}.app-url{display:inline-block;max-width:100%;overflow-wrap:anywhere;color:var(--accent);user-select:all}
.embed{padding:8px;place-items:start stretch}.embed .card{width:100%;background:transparent;border:none;box-shadow:none;padding:8px;grid-template-columns:1fr}.embed .qr{max-width:320px}
.foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:18px}
.top{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.top .brand{margin:0}
.state{display:inline-flex;align-items:center;gap:8px;padding:5px 13px;border-radius:99px;font-size:13px;font-weight:600;border:1px solid var(--line);background:#2c313a;color:var(--muted);white-space:nowrap}
.state .dot{width:9px;height:9px}.state.on{color:var(--ok);border-color:rgba(152,195,121,.45);background:rgba(152,195,121,.1)}.state.on .dot{background:var(--ok);box-shadow:0 0 0 3px rgba(152,195,121,.2)}
.state.off .dot{background:transparent;border:2px solid var(--muted)}.state.busy{color:var(--warn);border-color:rgba(229,192,123,.45)}.state.busy .dot{background:var(--warn)}
.offcard{display:grid;gap:10px;padding:18px;border:1px solid var(--line);border-radius:10px;background:#1d2025}.offcard b{font-size:16px;color:var(--strong)}.offcard p{margin:0}
.offcard button{justify-self:start;padding:9px 16px;font-size:14px}
.update{grid-column:1/-1;display:grid;gap:4px;padding:12px 14px;border:1px solid rgba(97,175,239,.45);border-radius:8px;background:rgba(97,175,239,.08)}.update b{color:var(--strong)}
button:disabled{opacity:.55;cursor:default;filter:none}.hide{display:none!important}
</style></head>
<body class="${embed ? 'embed' : ''}"><main class="card">
  <header class="top">
    <div class="brand"><img src="https://mithawala.github.io/pocket-pilot/app/icons/icon-192.png" alt=""><div><h1>Pocket Pilot</h1><div class="muted small">${esc(hostName)} · GitHub Copilot app &amp; CLI</div></div></div>
    <span id="state" class="state busy"><span class="dot"></span><span id="stateText">Checking…</span></span>
  </header>
  <div id="update" class="update hide"></div>
  <section>
    <div id="offcard" class="offcard hide">
      <b>Remote access is off</b>
      <p class="muted small">Your paired devices can't connect to this PC until you turn it on again. They stay paired.</p>
      <button id="on" class="primary">Turn on remote access</button>
      <p class="muted small" id="offNote"></p>
    </div>
    <div id="pairsec">
      <div id="qr" class="qr wait">Starting the secure tunnel…</div>
      <p class="small muted" id="exp"></p>
      <div class="row"><button id="copy" disabled>Copy link</button><button id="renew" disabled>New code</button></div>
    </div>
  </section>
  <section>
    <div id="approvals"></div>
    <div id="howto">
      <h2>Pair a device</h2>
      <ol>
        <li>On your device, open <b class="app-url">${esc(appHost)}</b><span class="muted"> — on a phone or tablet, add it to your Home Screen first and pair from there.</span></li>
        <li>Tap <b>Scan the QR code</b> in the app, or point your camera at the code. On another computer, open the copied link.</li>
        <li>Allow the device here, then confirm with Face ID, your fingerprint or Windows Hello.</li>
      </ol>
      <p class="small muted">The code works once and expires after 10 minutes. Everything between your device and this PC is end-to-end encrypted; Cloudflare only relays ciphertext.</p>
      <h2>Status</h2>
      <div class="row" id="status"></div>
    </div>
    <h2>Paired devices</h2>
    <div id="devices" class="small muted">None yet.</div>
    <div class="foot" id="foot"><button id="toggle" disabled>Turn off remote access</button><span class="small muted" id="toggleNote"></span></div>
  </section>
</main>
<script>
const K = ${JSON.stringify(key)};
const EMBED = ${embed ? 'true' : 'false'};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let link = null;
let on = null;
let busy = '';
async function api(path, body) {
  const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(K), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.json();
}
function pill(cls, text) { return '<span class="pill ' + cls + '"><span class="dot"></span>' + esc(text) + '</span>'; }
function setState(cls, text) { $('state').className = 'state ' + cls; $('stateText').textContent = text; }
function renderDevices(s) {
  $('devices').innerHTML = s.devices.length ? s.devices.map((d) => '<div class="dev"><span><b style="color:var(--strong)">' + esc(d.name) + '</b> <span class="muted">' + esc(d.platform || '') + '</span></span><span>' + (d.online ? pill('ok', 'connected') : pill('', 'offline')) + (d.passkey ? ' ' + pill('ok', 'passkey') : d.totp ? ' ' + pill('ok', 'authenticator') : '') + ' <button data-remove="' + esc(d.id) + '" data-name="' + esc(d.name) + '">Remove</button></span></div>').join('') : 'None yet.';
}
function render(s) {
  if (s.moved) { location.replace(s.moved + (EMBED ? '&embed=1' : '')); return; }
  const u = s.update;
  $('update').classList.toggle('hide', !u);
  if (u) $('update').innerHTML = '<b>Pocket Pilot ' + esc(u.latest) + ' is available</b><span class="small">You have ' + esc(u.current) + '. Update it on the <b>Plugins</b> page of the GitHub Copilot app, or run <code>copilot plugin update pocket-pilot@pocket-pilot</code>. The new version takes over remote access by itself; paired devices reconnect within seconds.</span>';
  on = !!s.on;
  if (busy === 'off' && !on) busy = '';
  if (busy === 'on' && on) busy = '';
  const turningOn = busy === 'on' || !!s.turningOn;
  $('offcard').classList.toggle('hide', on);
  $('pairsec').classList.toggle('hide', !on);
  $('howto').classList.toggle('hide', !on);
  // Off: the big button at the top turns it on (like VS Code's Start remote access); on: this one turns it off.
  $('foot').classList.toggle('hide', !on);
  $('toggle').className = on ? '' : 'primary';
  $('toggle').disabled = !!busy || turningOn;
  $('on').disabled = turningOn;
  if (!on) {
    setState(turningOn ? 'busy' : 'off', turningOn ? 'Turning on…' : 'Remote access off');
    $('toggle').textContent = turningOn ? 'Turning on…' : 'Turn on remote access';
    $('on').textContent = turningOn ? 'Turning on…' : 'Turn on remote access';
    $('offNote').textContent = s.error ? 'Could not turn it on: ' + s.error : 'You can also turn it on with /pocket-pilot in any chat.';
    $('approvals').innerHTML = '';
    renderDevices(s);
    link = null;
    return;
  }
  const local = s.tunnel.mode === 'none';
  const online = local || (s.tunnel.url && s.tunnel.reachable);
  // The tunnel lost its connection (the PC was offline or asleep): it reconnects, or a new one opens.
  const reconnecting = !online && !!(s.tunnel.url && s.tunnel.error);
  setState(busy === 'off' ? 'busy' : online ? 'on' : 'busy', busy === 'off' ? 'Turning off…' : online ? 'Remote access on' : reconnecting ? 'Reconnecting…' : s.tunnel.error ? 'Tunnel error' : 'Remote access starting…');
  $('toggle').textContent = busy === 'off' ? 'Turning off…' : 'Turn off remote access';
  $('toggleNote').textContent = 'Keeps running when you close or delete the chat it was started from. With no chat open for 30 minutes it pauses, and comes back with your next chat.';
  const qr = $('qr');
  if (s.pairing) { qr.className = 'qr'; qr.innerHTML = s.pairing.svg; link = s.pairing.link; }
  else { qr.className = 'qr wait'; qr.textContent = reconnecting ? s.tunnel.error : s.tunnel.error ? 'Tunnel error: ' + s.tunnel.error : s.tunnel.url ? 'Waiting for Cloudflare to publish the tunnel…' : 'Starting the secure tunnel…'; link = null; }
  $('copy').disabled = !link; $('renew').disabled = !s.tunnel.url;
  const left = s.pairing ? Math.max(0, Math.round((s.pairing.expiresAt - Date.now()) / 60000)) : 0;
  $('exp').textContent = s.pairing ? 'Expires in about ' + left + ' min · single use' : '';
  $('status').innerHTML = [
    pill(online ? 'ok' : s.tunnel.error && !reconnecting ? 'err' : 'busy', local ? 'Local network only' : online ? 'Tunnel online' : reconnecting ? 'Tunnel reconnecting' : s.tunnel.error ? 'Tunnel error' : s.tunnel.url ? 'Tunnel connecting' : 'Tunnel starting'),
    pill(s.sessions ? 'ok' : '', s.sessions + ' open session' + (s.sessions === 1 ? '' : 's')),
    pill(s.rendezvous ? 'ok' : '', s.rendezvous ? 'Auto-reconnect on' : 'Auto-reconnect off'),
  ].join(' ');
  $('approvals').innerHTML = s.approvals.map((a) => '<div class="approve"><div>' + (a.reset ? '<b>Let “' + esc(a.name) + '”</b> set up Face ID or an authenticator app again?' : '<b>Allow “' + esc(a.name) + '”</b> to control your Copilot sessions?') + '</div><div class="small muted">' + esc([a.platform, a.ip && 'from ' + a.ip].filter(Boolean).join(' · ')) + (a.reset ? ' — only allow this if you asked for it on the device yourself.' : ' — only allow a device you just paired yourself.') + '</div><div class="row" style="margin-top:8px"><button class="primary" data-a="' + esc(a.id) + '" data-v="1">Allow</button><button data-a="' + esc(a.id) + '" data-v="0">Deny</button></div></div>').join('');
  renderDevices(s);
}
document.addEventListener('click', async (e) => {
  const r = e.target.closest('button[data-remove]');
  if (r) {
    if (confirm('Remove “' + r.dataset.name + '”? It is disconnected immediately and must be paired again.')) { r.disabled = true; await api('/pair/remove', { id: r.dataset.remove }).catch(() => {}); tick(); }
    return;
  }
  const b = e.target.closest('button[data-a]');
  if (b) { b.disabled = true; await api('/pair/answer', { id: b.dataset.a, allow: b.dataset.v === '1' }).catch(() => {}); tick(); }
});
$('copy').onclick = async () => { if (link) { await navigator.clipboard.writeText(link); $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy link'), 1500); } };
$('renew').onclick = async () => { await api('/pair/renew', {}).catch(() => {}); tick(); };
async function turnOn() {
  busy = 'on';
  setState('busy', 'Turning on…');
  $('toggle').disabled = true; $('on').disabled = true;
  $('toggle').textContent = 'Turning on…'; $('on').textContent = 'Turning on…';
  await api('/pair/on', {}).catch(() => {});
  tick();
}
async function turnOff() {
  if (!confirm('Turn off Pocket Pilot remote access? Your paired devices stay paired and can connect again once you turn it back on.')) return;
  busy = 'off';
  setState('busy', 'Turning off…');
  $('toggle').disabled = true; $('toggle').textContent = 'Turning off…';
  await api('/pair/off', {}).catch(() => {});
  tick();
}
$('on').onclick = turnOn;
$('toggle').onclick = () => (on ? turnOff() : turnOn());
let failures = 0;
async function tick() {
  try { render(await api('/pair/state')); failures = 0; }
  catch { if (++failures > 3) { setState('off', 'Not connected'); $('offcard').classList.add('hide'); $('pairsec').classList.remove('hide'); $('qr').className = 'qr wait'; $('qr').textContent = 'This page lost Pocket Pilot (for example, its chat was closed). Your devices stay connected: run /pocket-pilot to open the page again.'; $('toggle').disabled = true; } }
}
tick(); setInterval(tick, 1500);
</script></body></html>`;
}
