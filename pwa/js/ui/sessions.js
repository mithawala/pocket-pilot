import { html, useState, useEffect, useChange } from '../lib/ui.js';
import { Icon, Sheet, StatusPill, Spinner, toast } from './common.js';
import { statusOf, ago, folderName, providerLabel, filePath, S, has } from '../lib/format.js';
import { mdPlain } from '../lib/markdown.js';

function SessionRow({ s, onOpen }) {
  const st = statusOf(s.status);
  const unread = !has(s.status, S.IsRead);
  const letter = providerLabel(s.provider)[0];
  return html`<button class=${`session ${st.key}`} onClick=${() => onOpen(s.resource)}>
    <div class=${`avatar ${s.provider === 'claude' ? 'claude' : ''}`}>${letter}</div>
    <div class="grow">
      <div class="title">${s.title || 'Untitled session'}</div>
      <div class="meta">
        ${st.key !== 'idle' && html`<${StatusPill} status=${st} />`}
        <span>${folderName(s.workingDirectories?.[0]) || providerLabel(s.provider)}</span>
        <span>· ${ago(s.modifiedAt)}</span>
      </div>
      ${s.activity && st.key !== 'idle' && html`<div class="activity">${mdPlain(s.activity, 120)}</div>`}
    </div>
    ${unread && st.key === 'idle' && html`<span class="unread" aria-label="Unread"></span>`}
  </button>`;
}

function FolderBrowser({ store, start, onPick, onClose }) {
  const [path, setPath] = useState(start);
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!path) return;
    setEntries(null);
    setError(null);
    store.listDirectory(path).then(setEntries).catch((e) => setError(e.message));
  }, [path]);
  const up = () => {
    const u = new URL(path);
    const parts = u.pathname.replace(/\/+$/, '').split('/');
    if (parts.length <= 2) return;
    parts.pop();
    u.pathname = parts.join('/') || '/';
    setPath(u.href);
  };
  const join = (name) => `${path.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
  return html`<${Sheet} open=${true} onClose=${onClose} title="Choose a folder">
    <div class="kv" style="margin-bottom:8px">${filePath(path)}</div>
    <div class="row" style="margin-bottom:8px">
      <button class="btn sm" onClick=${up}><${Icon} name="back" size="16" /> Up</button>
      <button class="btn sm primary" onClick=${() => { onPick(path); onClose(); }}>Use this folder</button>
    </div>
    ${error && html`<div class="errpart">${error}</div>`}
    ${!entries && !error && html`<${Spinner} />`}
    ${entries && entries.map((n) => html`<button class="list-item" key=${n} onClick=${() => setPath(join(n))}><${Icon} name="folder" /> <span class="grow">${n}</span><${Icon} name="right" /></button>`)}
    ${entries && !entries.length && html`<div class="muted small">No subfolders.</div>`}
  </${Sheet}>`;
}

function NewSession({ store, open, onClose, onCreated }) {
  const agents = store.agents();
  const [provider, setProvider] = useState(agents[0]?.provider || 'copilotcli');
  const folders = store.recentFolders();
  const [folder, setFolder] = useState(folders[0] || store.defaultDirectory || '');
  const [browse, setBrowse] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('interactive');
  const [approve, setApprove] = useState('default');
  const [isolation, setIsolation] = useState('folder');
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const models = store.models(provider).filter((m) => m.policyState !== 'disabled');
  useEffect(() => {
    if (open) setFolder((f) => f || folders[0] || store.defaultDirectory || '');
  }, [open]);
  const allFolders = folder && !folders.includes(folder) ? [folder, ...folders] : folders;
  async function create() {
    setBusy(true);
    try {
      const uri = await store.createSession({
        provider,
        folder,
        text: text.trim(),
        model: modelId ? { id: modelId } : undefined,
        config: { mode, autoApprove: approve, isolation },
      });
      setText('');
      onClose();
      onCreated(uri);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  return html`<${Sheet} open=${open} onClose=${onClose} title="New session">
    <div class="stack">
      ${agents.length > 1 && html`<div class="seg">${agents.map((a) => html`<button class=${provider === a.provider ? 'on' : ''} onClick=${() => { setProvider(a.provider); setModelId(''); }}>${a.displayName}</button>`)}</div>`}
      <div class="field"><label>Folder on your PC</label>
        ${allFolders.slice(0, 5).map((f) => html`<button class=${`list-item ${f === folder ? 'on' : ''}`} key=${f} onClick=${() => setFolder(f)}>
          <${Icon} name="folder" /><div class="grow"><div>${folderName(f)}</div><div class="muted tiny">${filePath(f)}</div></div>${f === folder && html`<span class="check"><${Icon} name="check" /></span>`}
        </button>`)}
        <button class="btn sm" onClick=${() => setBrowse(true)}><${Icon} name="search" size="16" /> Browse…</button>
      </div>
      <div class="field"><label>What should the agent do?</label>
        <textarea class="input" rows="4" placeholder="e.g. Fix the failing tests and explain what was wrong" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      </div>
      ${models.length > 0 && html`<div class="field"><label>Model</label>
        <select class="input" value=${modelId} onChange=${(e) => setModelId(e.target.value)}>
          <option value="">Default</option>
          ${models.map((m) => html`<option value=${m.id}>${m.name || m.id}</option>`)}
        </select></div>`}
      <div class="field"><label>Mode</label>
        <div class="seg">${[['interactive', 'Interactive'], ['plan', 'Plan'], ['autopilot', 'Autopilot']].map(([v, l]) => html`<button class=${mode === v ? 'on' : ''} onClick=${() => setMode(v)}>${l}</button>`)}</div>
      </div>
      <div class="field"><label>Tool approvals</label>
        <div class="seg">${[['default', 'Ask me'], ['assisted', 'Assisted'], ['autoApprove', 'Allow all']].map(([v, l]) => html`<button class=${approve === v ? 'on' : ''} onClick=${() => setApprove(v)}>${l}</button>`)}</div>
      </div>
      <div class="field"><label>Where changes go</label>
        <div class="seg">${[['folder', 'This folder'], ['worktree', 'New worktree']].map(([v, l]) => html`<button class=${isolation === v ? 'on' : ''} onClick=${() => setIsolation(v)}>${l}</button>`)}</div>
      </div>
      <button class="btn primary block" disabled=${busy || !folder} onClick=${create}>${busy ? html`<${Spinner} /> Starting…` : 'Start session'}</button>
    </div>
    ${browse && html`<${FolderBrowser} store=${store} start=${folder || store.defaultDirectory} onPick=${setFolder} onClose=${() => setBrowse(false)} />`}
  </${Sheet}>`;
}

export function ConnectionBanner({ conn, store, onRepair }) {
  const st = conn.state;
  if (st === 'online' && store.ahpConnected) return null;
  if (st === 'online' && !store.ahpConnected) return html`<div class="banner warn"><${Icon} name="alert" size="18" />${store.ahpReason || 'VS Code agent host is not available on your PC.'}</div>`;
  if (st === 'connecting' || st === 'authenticating' || st === 'idle') return html`<div class="banner"><${Spinner} />Connecting securely to your PC…</div>`;
  if (st === 'passkey') return html`<div class="banner"><${Icon} name="lock" size="18" />Confirm it's you (Face ID / fingerprint)…</div>`;
  if (st === 'unpaired') return html`<div class="banner err"><${Icon} name="alert" size="18" /><span>${conn.detail || 'This phone is no longer paired.'}</span><button onClick=${onRepair}>Fix</button></div>`;
  if (st === 'locked') return html`<div class="banner err"><${Icon} name="lock" size="18" /><span>${conn.detail || 'Verification failed.'}</span><button onClick=${() => { conn.stopped = false; conn.poke(); }}>Retry</button></div>`;
  return html`<div class="banner warn"><${Spinner} /><span>PC offline — retrying. ${conn.detail ? `(${conn.detail})` : ''}</span><button onClick=${() => conn.poke()}>Retry</button></div>`;
}

export function SessionsScreen({ app, host, store, conn, onOpen, onSettings, onSwitchHost, pushPrompt }) {
  useChange(store, (d) => d.kind === 'sessions' || d.kind === 'status' || d.kind === 'root');
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const list = store.sortedSessions();
  const filtered = q ? list.filter((s) => `${s.title} ${folderName(s.workingDirectories?.[0])}`.toLowerCase().includes(q.toLowerCase())) : list;
  const needs = filtered.filter((s) => has(s.status, S.Input));
  const working = filtered.filter((s) => !has(s.status, S.Input) && has(s.status, S.InProgress));
  const rest = filtered.filter((s) => !has(s.status, S.Input) && !has(s.status, S.InProgress));
  const section = (title, items) => items.length > 0 && html`<div><div class="section-title">${title}</div>${items.map((s) => html`<${SessionRow} key=${s.resource} s=${s} onOpen=${onOpen} />`)}</div>`;
  return html`<div class="screen">
    <div class="topbar">
      <img class="brand" src="./icons/icon.svg" alt="" />
      <button class="grow" style="text-align:left" onClick=${onSwitchHost} aria-label="Switch PC">
        <h1>${host.hostName}</h1>
        <div class="sub"><span class=${`dot ${conn.state === 'online' ? 'ok' : conn.state === 'offline' ? 'err' : 'busy'}`} style="display:inline-block;margin-right:6px"></span>${conn.state === 'online' ? `${list.length} sessions` : conn.state}</div>
      </button>
      <button class="icon-btn" onClick=${onSettings} aria-label="Settings"><${Icon} name="gear" /></button>
    </div>
    <${ConnectionBanner} conn=${conn} store=${store} onRepair=${() => app.repair(host)} />
    <div class="page">
      ${pushPrompt}
      <div class="search"><${Icon} name="search" /><input class="input" type="search" placeholder="Search sessions" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
      ${!store.sessionsLoaded && conn.state === 'online' && html`<div class="empty"><${Spinner} lg /></div>`}
      ${section('Needs you', needs)}
      ${section('Working', working)}
      ${section(needs.length || working.length ? 'Recent' : 'Sessions', rest)}
      ${store.sessionsLoaded && !filtered.length && html`<div class="empty">${q ? 'No matching sessions.' : 'No sessions yet. Start one with the button below.'}</div>`}
    </div>
    ${store.online && html`<button class="fab" onClick=${() => setNewOpen(true)}><${Icon} name="plus" /> New</button>`}
    ${store.online && html`<${NewSession} store=${store} open=${newOpen} onClose=${() => setNewOpen(false)} onCreated=${onOpen} />`}
  </div>`;
}
