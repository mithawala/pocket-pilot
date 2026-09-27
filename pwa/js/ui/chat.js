import { html, useState, useEffect, useRef, useLayoutEffect, useChange } from '../lib/ui.js';
import { Icon, Sheet, StatusPill, Spinner, toast } from './common.js';
import { Turn, PendingTurn } from './parts.js';
import { Composer } from './composer.js';
import { ConnectionBanner } from './sessions.js';
import { statusOf, folderName, providerLabel, filePath, S, has } from '../lib/format.js';

const PAGE = 25;

function FileViewer({ store, uri, onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!uri) return;
    setState({ loading: true });
    store.readFile(uri).then((r) => {
      let text = r.data;
      if (r.encoding === 'base64') {
        try {
          text = new TextDecoder().decode(Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
        } catch {
          text = '(binary file)';
        }
      }
      setState({ text: text.length > 200000 ? text.slice(0, 200000) + '\n… (truncated)' : text });
    }).catch((err) => setState({ error: err.message }));
  }, [uri]);
  return html`<${Sheet} open=${!!uri} onClose=${onClose} title=${uri ? filePath(uri).split(/[\\/]/).pop() : ''}>
    <div class="kv" style="margin-bottom:8px">${uri ? filePath(uri) : ''}</div>
    ${state.loading ? html`<${Spinner} />` : state.error ? html`<div class="errpart">${state.error}</div>` : html`<div class="md"><pre><code>${state.text}</code></pre></div>`}
  </${Sheet}>`;
}

function SessionMenu({ open, onClose, store, uri, session, onDeleted }) {
  const [name, setName] = useState('');
  useEffect(() => setName(session?.title || ''), [open]);
  return html`<${Sheet} open=${open} onClose=${onClose} title="Session">
    <div class="stack">
      <div class="field"><label>Title</label>
        <div class="row"><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} />
        <button class="btn sm" onClick=${() => { store.rename(uri, name.trim()); onClose(); }} disabled=${!name.trim()}>Rename</button></div>
      </div>
      <div class="kv">${(session?.workingDirectories || []).map(filePath).join('\n')}</div>
      <button class="btn block" onClick=${() => { store.archive(uri, true); onClose(); onDeleted(); }}><${Icon} name="folder" /> Archive</button>
      <button class="btn block danger" onClick=${async () => {
        if (!confirm('Delete this session on your PC? This cannot be undone.')) return;
        try {
          await store.disposeSession(uri);
          onClose();
          onDeleted();
        } catch (err) {
          toast(err.message, 'err');
        }
      }}><${Icon} name="trash" /> Delete session</button>
    </div>
  </${Sheet}>`;
}

export function ChatScreen({ store, conn, uri, onBack, onRepair }) {
  useChange(store, (d) => !d.uri || d.uri === uri || d.kind === 'sessions' || d.kind === 'status' || d.kind === 'root' || store.chatFor(uri) === d.uri);
  const [shown, setShown] = useState(PAGE);
  const [fileUri, setFileUri] = useState(null);
  const [menu, setMenu] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const endRef = useRef(null);
  const first = useRef(true);

  useEffect(() => store.watchSession(uri), [uri, store]);
  const session = store.sessions.get(uri);
  const sessionState = store.sessionState.get(uri);
  const chat = store.chatFor(uri);
  const chatState = chat ? store.chatState.get(chat) : null;
  const ctx = { store, chat };

  useEffect(() => {
    if (session && !has(session.status, S.IsRead) && document.visibilityState === 'visible') {
      try {
        store.markRead(uri);
      } catch {
        /* offline */
      }
    }
  }, [session?.status]);

  useEffect(() => {
    const onScroll = () => setAtBottom(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const turns = chatState?.turns || [];
  const active = chatState?.activeTurn;
  const localPending = [...store.localTurns.values()].filter((t) => t.chat === chat && !(active && active.message.text === t.message.text));
  const signature = `${turns.length}:${active ? active.responseParts.length : 0}:${JSON.stringify(active?.responseParts?.[active.responseParts.length - 1] || '').length}:${localPending.length}`;

  useLayoutEffect(() => {
    if (!chatState) return;
    if (first.current) {
      first.current = false;
      endRef.current?.scrollIntoView({ block: 'end' });
      return;
    }
    if (atBottom) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [signature, !!chatState]);

  useEffect(() => {
    const onClick = async (e) => {
      const copy = e.target.closest('.copy-btn');
      if (copy) {
        const pre = copy.parentElement;
        const text = [...pre.childNodes].filter((n) => n !== copy).map((n) => n.textContent).join('');
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
        } catch {
          toast('Copy failed', 'err');
        }
        return;
      }
      const f = e.target.closest('[data-file]');
      if (f) setFileUri(f.getAttribute('data-file'));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const status = statusOf(session?.status);
  const inputNeeded = sessionState?.inputNeeded || [];
  const visible = turns.slice(Math.max(0, turns.length - shown));
  const hidden = turns.length - visible.length;
  const title = session?.title || chatState?.title || 'Session';

  return html`<div class="screen">
    <div class="topbar">
      <button class="icon-btn" onClick=${onBack} aria-label="Back"><${Icon} name="back" /></button>
      <div class="grow">
        <h1>${title}</h1>
        <div class="sub">${providerLabel(session?.provider)} · ${folderName(session?.workingDirectories?.[0])} ${status.key !== 'idle' ? html`· <${StatusPill} status=${status} />` : ''}</div>
      </div>
      <button class="icon-btn" onClick=${() => setMenu(true)} aria-label="Session options"><${Icon} name="more" /></button>
    </div>
    ${inputNeeded.length > 0 && html`<button class="banner warn" onClick=${() => document.querySelector('.confirm')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
      <${Icon} name="alert" size="18" /> ${inputNeeded.length === 1 ? 'The agent is waiting for you' : `${inputNeeded.length} requests are waiting for you`}<span style="margin-left:auto">Review ↓</span>
    </button>`}
    <${ConnectionBanner} conn=${conn} store=${store} onRepair=${onRepair} />
    <div class="chat">
      ${!chatState && html`<div class="empty"><${Spinner} lg /><p>Loading conversation…</p></div>`}
      ${chatState?.turnsNextCursor && hidden === 0 && html`<button class="btn sm load-older" onClick=${() => store.loadOlder(chat).catch((e) => toast(e.message, 'err'))}>Load older messages</button>`}
      ${hidden > 0 && html`<button class="btn sm load-older" onClick=${() => setShown(shown + PAGE)}>Show ${Math.min(PAGE, hidden)} earlier turns</button>`}
      ${visible.map((t) => html`<${Turn} key=${t.id} turn=${t} active=${false} ctx=${ctx} />`)}
      ${active && html`<${Turn} key=${active.id} turn=${active} active=${true} activity=${chatState.activity || session?.activity} ctx=${ctx} />`}
      ${localPending.map((t, i) => html`<${PendingTurn} key=${`p${i}`} message=${t.message} />`)}
      ${chatState && !turns.length && !active && !localPending.length && html`<div class="empty">No messages yet. Say hello 👋</div>`}
      <div ref=${endRef}></div>
    </div>
    ${!atBottom && html`<button class="chip jump" onClick=${() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}><${Icon} name="down" /> Latest</button>`}
    ${chatState && html`<${Composer} store=${store} conn=${conn} sessionUri=${uri} session=${session} chat=${chat} chatState=${chatState} />`}
    <${FileViewer} store=${store} uri=${fileUri} onClose=${() => setFileUri(null)} />
    <${SessionMenu} open=${menu} onClose=${() => setMenu(false)} store=${store} uri=${uri} session=${session} onDeleted=${onBack} />
  </div>`;
}
