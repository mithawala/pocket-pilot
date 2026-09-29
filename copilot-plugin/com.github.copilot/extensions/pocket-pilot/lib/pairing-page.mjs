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
</style></head>
<body class="${embed ? 'embed' : ''}"><main class="card">
  <section>
    <div id="qr" class="qr wait">Starting the secure tunnel…</div>
    <p class="small muted" id="exp"></p>
    <div class="row"><button id="copy" disabled>Copy link</button><button id="renew" disabled>New code</button></div>
  </section>
  <section>
    <div class="brand"><img src="https://mithawala.github.io/pocket-pilot/app/icons/icon-192.png" alt=""><div><h1>Pair a device</h1><div class="muted small">${esc(hostName)} · GitHub Copilot app &amp; CLI</div></div></div>
    <div id="approvals"></div>
    <ol>
      <li>On your device, open <b class="app-url">${esc(appHost)}</b><span class="muted"> — add it to your Home Screen first to get notifications.</span></li>
      <li>Tap <b>Scan the QR code</b> in the app, or point your camera at the code. On another computer, open the copied link.</li>
      <li>Allow the device here, then confirm with Face ID, your fingerprint or Windows Hello.</li>
    </ol>
    <p class="small muted">The code works once and expires after 10 minutes. Everything between your device and this PC is end-to-end encrypted; Cloudflare only relays ciphertext.</p>
    <h2>Status</h2>
    <div class="row" id="status"></div>
    <h2>Paired devices</h2>
    <div id="devices" class="small muted">None yet.</div>
    <div class="foot"><button id="off">Turn off remote access</button><span class="small muted">Keeps running when you close or delete the chat it was started from. With no chat open for 30 minutes it pauses, and comes back with your next chat.</span></div>
  </section>
</main>
<script>
const K = ${JSON.stringify(key)};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let link = null;
async function api(path, body) {
  const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(K), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.json();
}
function pill(cls, text) { return '<span class="pill ' + cls + '"><span class="dot"></span>' + esc(text) + '</span>'; }
function render(s) {
  const qr = $('qr');
  if (s.pairing) { qr.className = 'qr'; qr.innerHTML = s.pairing.svg; link = s.pairing.link; }
  else { qr.className = 'qr wait'; qr.textContent = s.tunnel.error ? 'Tunnel error: ' + s.tunnel.error : s.tunnel.url ? 'Waiting for Cloudflare to publish the tunnel…' : 'Starting the secure tunnel…'; link = null; }
  $('copy').disabled = !link; $('renew').disabled = !s.tunnel.url;
  const left = s.pairing ? Math.max(0, Math.round((s.pairing.expiresAt - Date.now()) / 60000)) : 0;
  $('exp').textContent = s.pairing ? 'Expires in about ' + left + ' min · single use' : '';
  $('status').innerHTML = [
    pill(s.tunnel.url && s.tunnel.reachable ? 'ok' : s.tunnel.error ? 'err' : 'busy', s.tunnel.url && s.tunnel.reachable ? 'Tunnel online' : s.tunnel.error ? 'Tunnel error' : s.tunnel.url ? 'Tunnel connecting' : 'Tunnel starting'),
    pill(s.sessions ? 'ok' : '', s.sessions + ' open session' + (s.sessions === 1 ? '' : 's')),
    pill(s.rendezvous ? 'ok' : '', s.rendezvous ? 'Auto-reconnect on' : 'Auto-reconnect off'),
  ].join(' ');
  $('approvals').innerHTML = s.approvals.map((a) => '<div class="approve"><div><b>Allow “' + esc(a.name) + '”</b> to control your Copilot sessions?</div><div class="small muted">' + esc([a.platform, a.ip && 'from ' + a.ip].filter(Boolean).join(' · ')) + ' — only allow a device you just paired yourself.</div><div class="row" style="margin-top:8px"><button class="primary" data-a="' + esc(a.id) + '" data-v="1">Allow</button><button data-a="' + esc(a.id) + '" data-v="0">Deny</button></div></div>').join('');
  $('devices').innerHTML = s.devices.length ? s.devices.map((d) => '<div class="dev"><span><b style="color:var(--strong)">' + esc(d.name) + '</b> <span class="muted">' + esc(d.platform || '') + '</span></span><span>' + (d.online ? pill('ok', 'connected') : pill('', 'offline')) + (d.passkey ? ' ' + pill('ok', 'passkey') : '') + ' <button data-remove="' + esc(d.id) + '" data-name="' + esc(d.name) + '">Remove</button></span></div>').join('') : 'None yet.';
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
$('off').onclick = async () => {
  if (!confirm('Turn off Pocket Pilot remote access? Your paired devices stay paired; run /pocket-pilot in a chat to turn it on again.')) return;
  $('off').disabled = true;
  await api('/pair/off', {}).catch(() => {});
  $('qr').className = 'qr wait'; $('qr').textContent = 'Remote access is off. Run /pocket-pilot in a chat to turn it on again.';
  stopped = true;
};
let failures = 0;
let stopped = false;
async function tick() {
  if (stopped) return;
  try { render(await api('/pair/state')); failures = 0; }
  catch { if (++failures > 3) { $('qr').className = 'qr wait'; $('qr').textContent = 'This page lost Pocket Pilot (for example, its chat was closed). Your devices stay connected: run /pocket-pilot to open the page again.'; } }
}
tick(); setInterval(tick, 1500);
</script></body></html>`;
}
