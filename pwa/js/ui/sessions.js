import { html, useState, useEffect, useChange } from '../lib/ui.js';
import { Icon, Sheet, StatusPill, Spinner, toast } from './common.js';
import { statusOf, ago, folderName, providerLabel, filePath, hostApp, S, has } from '../lib/format.js';
import { mdPlain } from '../lib/markdown.js';
import { ModelSheet, ModelOptionsSheet, modelChip, optionsChip, hasOptions } from './model-picker.js';

function StatusIcon({ st, unread }) {
  if (st.key === 'running') return html`<span class="spinner" aria-label="Working"></span>`;
  if (st.key === 'input') return html`<${Icon} name="alert-circle" />`;
  if (st.key === 'error') return html`<${Icon} name="circle-x" />`;
  if (unread) return html`<span class="udot" aria-label="Unread"></span>`;
  return html`<${Icon} name="chat" />`;
}

const compact = (n) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

/** VS Code-style `+adds −dels` for a session's file changes. */
export function Changes({ c }) {
  if (!c || (!c.additions && !c.deletions)) return null;
  return html`<span class="chg" title=${`${c.additions || 0} added, ${c.deletions || 0} removed${c.files ? ` in ${c.files} file${c.files === 1 ? '' : 's'}` : ''}`}><span class="add">+${compact(c.additions || 0)}</span> <span class="del">−${compact(c.deletions || 0)}</span></span>`;
}

/** The folder (project) a session belongs to, as VS Code's Agents window groups them. */
export function projectOf(s) {
  const uri = s.project?.uri || s.workingDirectories?.[0] || '';
  return { key: uri || `provider:${s.provider}`, uri, name: s.project?.displayName || folderName(uri) || providerLabel(s.provider) };
}

function SessionRow({ s, onOpen, selected, inFolder }) {
  const st = statusOf(s.status);
  const unread = !has(s.status, S.IsRead);
  const activity = s.activity ? mdPlain(s.activity, 100) : '';
  const detail = st.key === 'input' ? html`<span class="st-input">${activity || 'Needs input'}</span>`
    : st.key === 'running' ? html`<span class="st-running">${activity || 'Working…'}</span>`
    : st.key === 'error' ? html`<span class="st-error">Error</span>`
    : null;
  const changes = s.changes && (s.changes.additions || s.changes.deletions) ? html`<${Changes} c=${s.changes} />` : null;
  const bits = [inFolder ? null : projectOf(s).name, detail || changes].filter(Boolean);
  if (!bits.length) bits.push(providerLabel(s.provider));
  return html`<button class=${`srow is-${st.key} ${unread ? 'unread' : ''} ${selected ? 'on' : ''}`} aria-current=${selected ? 'true' : undefined} onClick=${() => onOpen(s.resource)}>
    <span class="si"><${StatusIcon} st=${st} unread=${unread} /></span>
    <span class="sb">
      <span class="l1"><span class="ttl">${s.title || 'Untitled session'}</span><span class="time">${ago(s.modifiedAt)}</span></span>
      <span class="l2">${bits.map((b, i) => html`${i ? ' · ' : ''}${b}`)}</span>
    </span>
  </button>`;
}

/** Groups sessions by folder: folders that need you or are working first, then the most recently active; rows keep their status order. */
export function folderGroups(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const p = projectOf(s);
    let g = map.get(p.key);
    if (!g) map.set(p.key, (g = { ...p, items: [], latest: '', needs: 0, running: 0 }));
    g.items.push(s);
    if (String(s.modifiedAt || '') > g.latest) g.latest = String(s.modifiedAt || '');
    if (has(s.status, S.Input)) g.needs++;
    else if (has(s.status, S.InProgress)) g.running++;
  }
  const rank = (g) => (g.needs ? 0 : g.running ? 1 : 2);
  return [...map.values()].sort((a, b) => rank(a) - rank(b) || b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name));
}

function readPref(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function FolderGroup({ g, closed, onToggle, onOpen, selected }) {
  return html`<div class="fgroup">
    <button class=${`fhead ${closed ? 'closed' : ''}`} aria-expanded=${!closed} onClick=${onToggle} title=${g.uri ? filePath(g.uri) : g.name}>
      <span class="chev"><${Icon} name="down" /></span>
      <span class="fic"><${Icon} name="folder" /></span>
      <span class="fname">${g.name}</span>
      ${g.needs > 0 && html`<span class="fbadge is-input" title=${`${g.needs} need${g.needs === 1 ? 's' : ''} input`}><${Icon} name="alert-circle" />${g.needs}</span>`}
      ${g.running > 0 && html`<span class="fbadge is-running" title=${`${g.running} working`}><span class="spinner"></span>${g.running}</span>`}
      <span class="fcount">${g.items.length}</span>
    </button>
    ${!closed && g.items.map((s) => html`<${SessionRow} key=${s.resource} s=${s} onOpen=${onOpen} selected=${s.resource === selected} inFolder=${true} />`)}
  </div>`;
}

/** VS Code-style time buckets for finished sessions. */
function bucketOf(ts) {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (!t || t >= today.getTime()) return 'Today';
  if (t >= today.getTime() - day) return 'Yesterday';
  if (t >= today.getTime() - 6 * day) return 'Previous 7 days';
  return 'Older';
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
  return html`<${Sheet} open=${true} onClose=${onClose} title="Choose a folder" doneLabel="Cancel">
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

function NewSession({ store, open, onClose, onCreated, copilotHost = false }) {
  const agents = store.agents();
  const [provider, setProvider] = useState(agents[0]?.provider || 'copilotcli');
  // The GitHub Copilot app keeps a scratch folder per chat without a project: not a place for new work.
  const folders = store.recentFolders().filter((f) => !copilotHost || !/\/\.copilot\/(chats|session-state)\//i.test(f));
  const [folder, setFolder] = useState(folders[0] || store.defaultDirectory || '');
  const [browse, setBrowse] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('interactive');
  const [approve, setApprove] = useState('default');
  const [isolation, setIsolation] = useState('folder');
  const [modelSel, setModelSel] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('pp:newSessionModel') || 'null');
    } catch {
      return null;
    }
  });
  const [modelOpen, setModelOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const models = store.models(provider).filter((m) => m.policyState !== 'disabled');
  const chosenModel = modelSel && models.some((m) => m.id === modelSel.id) ? modelSel : null;
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
        model: chosenModel || undefined,
        // The Copilot app plugin starts the session with the model right away (no switch in the chat).
        modelAtStart: copilotHost,
        config: copilotHost ? { mode, autoApprove: approve } : { mode, autoApprove: approve, isolation },
      });
      if (chosenModel) localStorage.setItem('pp:newSessionModel', JSON.stringify(chosenModel));
      setText('');
      onClose();
      onCreated(uri);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  return html`<${Sheet} open=${open} onClose=${onClose} title="New session" doneLabel="Cancel">
    <div class="stack">
      ${agents.length > 1 && html`<div class="seg">${agents.map((a) => html`<button class=${provider === a.provider ? 'on' : ''} onClick=${() => { setProvider(a.provider); setModelSel(null); }}>${a.displayName}</button>`)}</div>`}
      <div class="field"><label>What should the agent do?</label>
        <textarea class="input" rows="3" placeholder="e.g. Fix the failing tests and explain what was wrong" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      </div>
      <div class="field"><label>Folder on your PC</label>
        ${allFolders.slice(0, 5).map((f) => html`<button class=${`list-item ${f === folder ? 'on' : ''}`} key=${f} onClick=${() => setFolder(f)}>
          <${Icon} name="folder" /><div class="grow"><div>${folderName(f)}</div><div class="muted tiny">${filePath(f)}</div></div>${f === folder && html`<span class="check"><${Icon} name="check" /></span>`}
        </button>`)}
        <button class="btn sm" onClick=${() => setBrowse(true)}><${Icon} name="search" size="16" /> Browse…</button>
      </div>
      ${models.length > 0 && html`<div class="field"><label>Model</label>
        <button class="list-item on" onClick=${() => setModelOpen('model')}><${Icon} name="cpu" /><span class="grow">${modelChip(models, chosenModel).name}</span><${Icon} name="right" /></button>
        ${hasOptions(models, chosenModel) && html`<button class="list-item" onClick=${() => setModelOpen('options')}><${Icon} name="brain" /><span class="grow">${optionsChip(models, chosenModel)}</span><span class="muted small">Thinking · context</span><${Icon} name="right" /></button>`}
      </div>`}
      <div class="field"><label>Mode</label>
        <div class="seg">${[['interactive', 'Interactive'], ['plan', 'Plan'], ['autopilot', 'Autopilot']].map(([v, l]) => html`<button class=${mode === v ? 'on' : ''} onClick=${() => setMode(v)}>${l}</button>`)}</div>
      </div>
      <div class="field"><label>Tool approvals</label>
        <div class="seg">${[['default', 'Ask me'], ['assisted', 'Assisted'], ['autoApprove', 'Allow all']].map(([v, l]) => html`<button class=${approve === v ? 'on' : ''} onClick=${() => setApprove(v)}>${l}</button>`)}</div>
      </div>
      ${!copilotHost && html`<div class="field"><label>Where changes go</label>
        <div class="seg">${[['folder', 'This folder'], ['worktree', 'New worktree']].map(([v, l]) => html`<button class=${isolation === v ? 'on' : ''} onClick=${() => setIsolation(v)}>${l}</button>`)}</div>
      </div>`}
      <button class="btn primary block" disabled=${busy || !folder} onClick=${create}>${busy ? html`<${Spinner} /> Starting…` : 'Start session'}</button>
      ${copilotHost && html`<p class="muted small new-note"><${Icon} name="info" size="15" /><span>Runs on your PC in the background, with your GitHub Copilot sign-in, models, tools and plugins, like a Copilot CLI session. It doesn't open in the app window: follow and control it here.</span></p>`}
    </div>
    ${browse && html`<${FolderBrowser} store=${store} start=${folder || store.defaultDirectory} onPick=${setFolder} onClose=${() => setBrowse(false)} />`}
    <${ModelSheet} open=${modelOpen === 'model'} onClose=${() => setModelOpen(null)} models=${models} value=${chosenModel} onChange=${setModelSel} />
    <${ModelOptionsSheet} open=${modelOpen === 'options'} onClose=${() => setModelOpen(null)} models=${models} value=${chosenModel} onChange=${setModelSel} />
  </${Sheet}>`;
}

export function ConnectionBanner({ conn, store, onRepair }) {
  const st = conn.state;
  if (st === 'online' && store.ahpConnected) return null;
  if (st === 'online' && !store.ahpConnected) return html`<div class="banner warn"><${Icon} name="alert" size="18" />${store.ahpReason || (conn.record?.hostKind === 'copilot' ? 'The GitHub Copilot app is not available on your PC.' : 'VS Code agent host is not available on your PC.')}</div>`;
  if (st === 'connecting' || st === 'authenticating' || st === 'idle') return html`<div class="banner"><${Spinner} />Connecting securely to your PC…</div>`;
  if (st === 'passkey') return html`<div class="banner"><${Icon} name="lock" size="18" />Confirm it's you (Face ID / fingerprint)…</div>`;
  if (st === 'code') return html`<div class="banner"><${Icon} name="lock" size="18" />Enter the code from your authenticator app…</div>`;
  if (st === 'approval') return html`<div class="banner"><${Spinner} />Click Allow on your PC to set up this device again…</div>`;
  if (st === 'setup') return html`<div class="banner"><${Icon} name="key" size="18" />Setting up this device again…</div>`;
  if (st === 'unpaired') return html`<div class="banner err"><${Icon} name="alert" size="18" /><span>${conn.detail || 'This device is no longer paired.'}</span><button onClick=${onRepair}>Fix</button></div>`;
  if (st === 'locked') return html`<div class="banner err"><${Icon} name="lock" size="18" /><span>${conn.detail || 'Verification failed.'}</span><button onClick=${() => { conn.stopped = false; conn.poke(); }}>Retry</button></div>`;
  return html`<div class="banner warn"><${Spinner} /><span>PC offline — retrying. ${conn.detail ? `(${conn.detail})` : ''}</span><button onClick=${() => conn.poke()}>Retry</button></div>`;
}

export function SessionsScreen({ app, host, store, conn, onOpen, onSettings, onSwitchHost, pushPrompt, selected, newOpen, onNew, onNewClose }) {
  // Session and chat state can correct a session's status (see HostStore.statusFor).
  const correctable = (s) => !!s && ((s.status & 31) === S.Error || has(s.status, S.Input));
  useChange(store, (d) => d.kind === 'sessions' || d.kind === 'status' || d.kind === 'root'
    || (d.kind === 'session' && correctable(store.sessions.get(d.uri)))
    || (d.kind === 'chat' && [...store.sessions.values()].some((s) => has(s.status, S.Input) && store.chatFor(s.resource) === d.uri)));
  const [q, setQ] = useState('');
  const [groupBy, setGroupByState] = useState(() => (readPref('pp:groupBy', 'recent') === 'folder' ? 'folder' : 'recent'));
  const [collapsed, setCollapsed] = useState(() => new Set(readPref('pp:collapsedFolders', [])));
  const setGroupBy = (v) => {
    setGroupByState(v);
    localStorage.setItem('pp:groupBy', JSON.stringify(v));
  };
  const toggleFolder = (key) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    localStorage.setItem('pp:collapsedFolders', JSON.stringify([...next].slice(-200)));
  };
  const list = store.sortedSessions();
  const filtered = q ? list.filter((s) => `${s.title} ${projectOf(s).name} ${folderName(s.workingDirectories?.[0])}`.toLowerCase().includes(q.toLowerCase())) : list;
  const groups = [];
  if (groupBy === 'recent') {
    const needs = filtered.filter((s) => has(s.status, S.Input));
    const working = filtered.filter((s) => !has(s.status, S.Input) && has(s.status, S.InProgress));
    const rest = filtered.filter((s) => !has(s.status, S.Input) && !has(s.status, S.InProgress));
    groups.push(['Needs input', needs], ['In progress', working]);
    for (const name of ['Today', 'Yesterday', 'Previous 7 days', 'Older']) groups.push([name, rest.filter((s) => bucketOf(s.modifiedAt) === name)]);
  }
  const folders = groupBy === 'folder' ? folderGroups(filtered) : [];
  const online = conn.state === 'online';
  const copilotHost = host?.hostKind === 'copilot';
  // Copilot app plugins before 0.7.2 can't start sessions: chats are started in the app there.
  const canCreate = !copilotHost || !!host?.canCreateSessions;
  return html`<div class="screen">
    <div class="topbar">
      <img class="brand" src="./icons/icon.svg" alt="" />
      <button class="titles" onClick=${onSwitchHost} aria-label="Switch PC">
        <h1 class="host"><span>${host.hostName}</span><${Icon} name="down" /></h1>
        <div class="sub"><span class=${`dot ${online ? 'ok' : conn.state === 'offline' ? 'err' : 'busy'}`}></span>${online ? `${list.length} session${list.length === 1 ? '' : 's'}` : { passkey: 'confirm it’s you', code: 'waiting for your code', approval: 'waiting for your PC', setup: 'setting up', authenticating: 'connecting', unpaired: 'not paired', locked: 'locked' }[conn.state] || conn.state}</div>
      </button>
      <button class="icon-btn" onClick=${onSettings} aria-label="Settings"><${Icon} name="gear" /></button>
    </div>
    <${ConnectionBanner} conn=${conn} store=${store} onRepair=${() => app.repair(host)} />
    <div class="scroll-wrap">
      <div class="scroll">
        <div class="list">
          ${pushPrompt && html`<div class="page" style="padding-bottom:0">${pushPrompt}</div>`}
          <div class="filter"><${Icon} name="search" /><input type="search" placeholder="Filter sessions" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Filter sessions" /></div>
          <div class="gtabs" role="tablist" aria-label="Group sessions">
            <button role="tab" aria-selected=${groupBy === 'recent'} class=${groupBy === 'recent' ? 'on' : ''} onClick=${() => setGroupBy('recent')}><${Icon} name="clock" />Recent</button>
            <button role="tab" aria-selected=${groupBy === 'folder'} class=${groupBy === 'folder' ? 'on' : ''} onClick=${() => setGroupBy('folder')}><${Icon} name="folder" />Folders</button>
          </div>
          ${!store.sessionsLoaded && online && html`<div class="empty"><${Spinner} lg /></div>`}
          ${groups.map(([title, items]) => items.length > 0 && html`<div key=${title}>
            <div class="group-title">${title}</div>
            ${items.map((s) => html`<${SessionRow} key=${s.resource} s=${s} onOpen=${onOpen} selected=${s.resource === selected} />`)}
          </div>`)}
          ${folders.map((g) => html`<${FolderGroup} key=${g.key} g=${g} closed=${!q && collapsed.has(g.key)} onToggle=${() => toggleFolder(g.key)} onOpen=${onOpen} selected=${selected} />`)}
          ${store.sessionsLoaded && !filtered.length && html`<div class="empty">${q ? 'No matching sessions.' : copilotHost ? `No open chats yet. Chats you use in the GitHub Copilot app or CLI on this PC show up here${canCreate ? ', or start one below.' : '.'}` : 'No sessions yet. Start one below.'}</div>`}
        </div>
      </div>
    </div>
    ${store.online && (!canCreate
      ? html`<div class="bottom-bar"><div class="newhint"><${Icon} name="info" /><span>Start new chats in the GitHub Copilot app or CLI on your PC — they appear here after the first message. Update Pocket Pilot on your PC to start them from here.</span></div></div>`
      : html`<div class="bottom-bar">
      <button class="newbar" onClick=${onNew}><${Icon} name="plus" /><span>New session — describe a task…</span><span class="go"><${Icon} name="send" /></span></button>
    </div>`)}
    ${store.online && canCreate && html`<${NewSession} store=${store} open=${newOpen} onClose=${onNewClose} onCreated=${onOpen} copilotHost=${copilotHost} />`}
  </div>`;
}

/** Desktop main pane when no session is open (like VS Code's empty editor area). */
export function DesktopHome({ store, host, onNew }) {
  useChange(store, (d) => d.kind === 'sessions' || d.kind === 'status' || (d.kind === 'session' && (store.sessions.get(d.uri)?.status & 31) === S.Error));
  const list = store.sortedSessions();
  const waiting = list.filter((s) => has(s.status, S.Input)).length;
  const running = list.filter((s) => !has(s.status, S.Input) && has(s.status, S.InProgress)).length;
  const copilotHost = host?.hostKind === 'copilot';
  const canCreate = !copilotHost || !!host?.canCreateSessions;
  return html`<div class="screen">
    <div class="scroll-wrap"><div class="scroll"><div class="chat"><div class="chat-empty">
      <div class="big"><${Icon} name="sparkle" /></div>
      <h2>${canCreate ? 'Open a session, or start a new one' : 'Open a chat'}</h2>
      <p>${list.length} session${list.length === 1 ? '' : 's'} on <b>${host.hostName}</b>${waiting ? html` · <span class="st-input">${waiting} need${waiting === 1 ? 's' : ''} input</span>` : ''}${running ? html` · <span class="st-running">${running} working</span>` : ''}. Everything you do here happens in ${hostApp(host)} on your PC.</p>
      ${store.online && canCreate && html`<button class="newbar home-new" onClick=${onNew}><${Icon} name="plus" /><span>New session — describe a task…</span><span class="go"><${Icon} name="send" /></span></button>`}
    </div></div></div></div>
  </div>`;
}
