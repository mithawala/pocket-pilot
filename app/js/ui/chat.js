import { html, useState, useEffect, useRef, useLayoutEffect, useChange } from '../lib/ui.js';
import { Icon, Sheet, StatusPill, Spinner, toast } from './common.js';
import { Turn, PendingTurn } from './parts.js';
import { Composer } from './composer.js';
import { ConnectionBanner } from './sessions.js';
import { statusOf, folderName, providerLabel, filePath, hostApp, S, has } from '../lib/format.js';
import { waitingOn } from '../lib/asks.js';
import { canonicalLanguage, highlightElement } from '../lib/highlight.js';
import { loadPicture, mimeFromName, pictureError } from '../lib/attachments.js';
import { openPictures } from './viewer.js';

const PAGE = 25;

function FileViewer({ store, uri, onClose }) {
  const [state, setState] = useState({ loading: true });
  const codeRef = useRef(null);
  const name = uri ? filePath(uri).split(/[\\/]/).pop() : '';
  // A picture the agent links to opens as a picture (an SVG file stays code).
  const picture = uri && /^image\/(?!svg)/.test(mimeFromName(uri)) ? { type: 'resource', uri, label: name } : null;
  const read = (u) => store.readImage(u);
  useEffect(() => {
    if (!uri) return;
    setState({ loading: true });
    if (picture) {
      loadPicture(picture, read).then((r) => setState({ url: r.url }), (err) => setState({ error: pictureError(err) }));
      return;
    }
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
  const ext = uri ? (filePath(uri).split(/[\\/]/).pop().match(/\.([\w-]+)$/)?.[1] || '').toLowerCase() : '';
  const lang = canonicalLanguage(ext) ? ext : '';
  useEffect(() => {
    if (state.text && lang && state.text.length < 120000 && codeRef.current) highlightElement(codeRef.current).catch(() => {});
  }, [state.text, lang]);
  return html`<${Sheet} open=${!!uri} onClose=${onClose} wide=${true} doneLabel="Close" title=${name}>
    <div class="kv" style="margin-bottom:8px">${uri ? filePath(uri) : ''}</div>
    ${state.loading ? html`<${Spinner} />` : state.error ? html`<div class="errpart">${state.error}</div>`
      : state.url ? html`<button type="button" class="file-img" onClick=${() => openPictures([{ att: picture, read }], 0)} aria-label=${`View ${name} full screen`}><img src=${state.url} alt=${name} /></button>`
      : html`<div class="md"><pre><code key=${uri} ref=${codeRef} class=${lang ? `language-${lang}` : ''}>${state.text}</code></pre></div>`}
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

export function ChatScreen({ store, conn, uri, onBack, onRepair, embedded = false }) {
  useChange(store, (d) => !d.uri || d.uri === uri || d.kind === 'sessions' || d.kind === 'status' || d.kind === 'root' || store.chatFor(uri) === d.uri);
  const [shown, setShown] = useState(PAGE);
  const [fileUri, setFileUri] = useState(null);
  const [menu, setMenu] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  // Follow new output while the user is at the bottom, like VS Code's chat.
  const stick = useRef(true);
  const first = useRef(true);

  useEffect(() => store.watchSession(uri), [uri, store]);
  const session = store.sessions.get(uri);
  const sessionState = store.sessionState.get(uri);
  const chat = store.chatFor(uri);
  const chatState = chat ? store.chatState.get(chat) : null;
  const provider = session?.provider || sessionState?.provider;
  const models = store.models(provider);
  const lastTurnId = chatState?.turns?.[chatState.turns.length - 1]?.id;
  const ctx = {
    store,
    chat,
    provider,
    host: hostApp(conn?.record),
    readImage: (u) => store.readImage(u),
    modelName: (id) => models.find((m) => m.id === id)?.name || id,
    // A failed last turn can be sent again as it was, with the model now selected.
    retry: (turn) => () => {
      try {
        store.sendMessage(uri, { text: turn.message.text, attachments: turn.message.attachments, model: store.modelFor(chat) || undefined });
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  };

  useEffect(() => {
    if (session && !has(session.status, S.IsRead) && document.visibilityState === 'visible') {
      try {
        store.markRead(uri);
      } catch {
        /* offline */
      }
    }
  }, [session?.status]);

  const pin = (smooth) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    stick.current = bottom;
    setAtBottom(bottom);
  };

  const turns = chatState?.turns || [];
  const active = chatState?.activeTurn;
  const localPending = [...store.localTurns.values()].filter((t) => t.chat === chat && !(active && active.message.text === t.message.text));
  const signature = `${turns.length}:${active ? active.responseParts.length : 0}:${JSON.stringify(active?.responseParts?.[active.responseParts.length - 1] || '').length}:${localPending.length}`;

  useLayoutEffect(() => {
    if (!chatState) return;
    if (first.current) {
      first.current = false;
      pin(false);
      return;
    }
    if (stick.current) pin(false);
  }, [signature, !!chatState]);

  // Stay pinned when the view shrinks (keyboard) or content reflows (highlighting, images).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [!!chatState]);

  useEffect(() => {
    const onClick = async (e) => {
      const copy = e.target.closest('.copy-btn');
      if (copy) {
        const text = copy.closest('.code-block')?.querySelector('pre')?.textContent || '';
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

  const status = statusOf(store.statusFor(session));
  const waiting = waitingOn(sessionState, chat, chatState);
  const visible = turns.slice(Math.max(0, turns.length - shown));
  const hidden = turns.length - visible.length;
  const title = session?.title || chatState?.title || 'Session';
  const folder = folderName(session?.workingDirectories?.[0] || sessionState?.workingDirectories?.[0]);
  const empty = chatState && !turns.length && !active && !localPending.length;

  return html`<div class="screen">
    <div class="topbar">
      ${!embedded && html`<button class="icon-btn" onClick=${onBack} aria-label="Back"><${Icon} name="back" /></button>`}
      <div class="titles">
        <h1>${title}</h1>
        <div class="sub"><span>${providerLabel(provider)}</span>${folder && html`<span class="sep">·</span><span>${folder}</span>`}${status.key !== 'idle' && html`<span class="sep">·</span><${StatusPill} status=${status} />`}</div>
      </div>
      <button class="icon-btn" onClick=${() => setMenu(true)} aria-label="Session options"><${Icon} name="more" /></button>
      ${embedded && html`<button class="icon-btn" onClick=${onBack} aria-label="Close"><${Icon} name="x" /></button>`}
    </div>
    ${waiting > 0 && html`<button class="banner warn" onClick=${() => scrollRef.current?.querySelector('.confirm')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
      <${Icon} name="alert-circle" /><span>${waiting === 1 ? 'The agent is waiting for you' : `${waiting} requests are waiting for you`}</span><span class="go">Review</span>
    </button>`}
    <${ConnectionBanner} conn=${conn} store=${store} onRepair=${onRepair} />
    <div class="scroll-wrap">
      <div class="scroll" ref=${scrollRef} onScroll=${onScroll}>
        <div class="chat" ref=${contentRef}>
          ${!chatState && html`<div class="chat-empty"><${Spinner} lg /><p>Loading conversation…</p></div>`}
          ${chatState?.turnsNextCursor && hidden === 0 && html`<button class="btn sm load-older" onClick=${() => store.loadOlder(chat).catch((e) => toast(e.message, 'err'))}>Load older messages</button>`}
          ${hidden > 0 && html`<button class="btn sm load-older" onClick=${() => setShown(shown + PAGE)}>Show ${Math.min(PAGE, hidden)} earlier turns</button>`}
          ${visible.map((t) => html`<${Turn} key=${t.id} turn=${t} active=${false} isLast=${!active && t.id === lastTurnId} ctx=${ctx} />`)}
          ${active && html`<${Turn} key=${active.id} turn=${active} active=${true} activity=${chatState.activity || session?.activity} ctx=${ctx} />`}
          ${localPending.map((t, i) => html`<${PendingTurn} key=${`p${i}`} message=${t.message} read=${ctx.readImage} />`)}
          ${empty && html`<div class="chat-empty">
            <div class="big"><${Icon} name="sparkle" /></div>
            <h2>${providerLabel(provider)} is ready</h2>
            <p>${folder ? html`Ask anything about <b>${folder}</b>. ` : ''}The agent works on your PC, and you can follow along here or in ${hostApp(conn?.record)}.</p>
          </div>`}
        </div>
      </div>
      ${!atBottom && chatState && html`<button class="jump" onClick=${() => { stick.current = true; pin(true); }} aria-label="Scroll to the latest message"><${Icon} name="arrow-down" /></button>`}
    </div>
    ${chatState && html`<${Composer} store=${store} conn=${conn} sessionUri=${uri} session=${session} chat=${chat} chatState=${chatState} autoFocus=${embedded} />`}
    <${FileViewer} store=${store} uri=${fileUri} onClose=${() => setFileUri(null)} />
    <${SessionMenu} open=${menu} onClose=${() => setMenu(false)} store=${store} uri=${uri} session=${session} onDeleted=${onBack} />
  </div>`;
}
