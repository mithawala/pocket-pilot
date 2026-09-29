import { html, useState, useRef, useEffect } from '../lib/ui.js';
import { Icon, Sheet, toast } from './common.js';
import { ModelSheet, ModelOptionsSheet, modelSummary, modelChip, optionsChip, hasOptions } from './model-picker.js';
import { b64 } from '../core/bytes.js';
import { haptic, providerLabel } from '../lib/format.js';
import { isImageAttachment, splitAttachments } from '../lib/attachments.js';
import { Thumbs } from './viewer.js';

const MAX_UPLOAD = 20 * 1024 * 1024;
const fine = () => window.matchMedia('(pointer: fine)').matches;

async function downscaleImage(file, maxDim = 1600, quality = 0.85) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return null;
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

function OptionSheet({ open, title, options, value, icons, onPick, onClose }) {
  return html`<${Sheet} open=${open} onClose=${onClose} title=${title}>
    ${options.map((o) => html`<button class=${`list-item ${o.value === value ? 'on' : ''}`} onClick=${() => { onPick(o.value); onClose(); }}>
      ${icons?.[o.value] && html`<${Icon} name=${icons[o.value]} />`}
      <div class="grow"><div>${o.label}</div>${o.description && html`<div class="muted small">${o.description}</div>`}</div>
      ${o.value === value && html`<span class="check"><${Icon} name="check" /></span>`}
    </button>`)}
  </${Sheet}>`;
}

function enumOptions(schema) {
  if (!schema?.enum) return [];
  return schema.enum.map((v, i) => ({ value: v, label: schema.enumLabels?.[i] || v, description: schema.enumDescriptions?.[i] }));
}

const MODE_ICONS = { interactive: 'chat', plan: 'checklist', autopilot: 'rocket' };
const APPROVAL_ICONS = { default: 'shield', assisted: 'shield-check', autoApprove: 'shield-off' };

/**
 * A message waiting for the agent, like VS Code's queue above the chat input: the whole text (clamped,
 * tap to expand), Edit (or tap the text), Send Immediately for queued messages, and Remove.
 */
function PendingItem({ store, sessionUri, chat, kind, item }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const text = item.message?.text || '';
  const { images, others } = splitAttachments(item.message);
  const read = (u) => store.readImage(u);
  const label = kind === 'steering' ? 'Steering' : 'Queued';
  const hint = kind === 'steering' ? 'Sent to the running agent after its next tool call' : 'Sent when the agent finishes its current turn';
  const run = (fn) => {
    try {
      fn();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  const startEdit = () => {
    setDraft(text);
    setEditing(true);
  };
  const save = () => run(() => {
    store.editPending(chat, kind, item.id, draft);
    setEditing(false);
  });
  useEffect(() => {
    const el = box.current;
    if (!editing || !el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }, [editing, draft]);
  useEffect(() => {
    const el = box.current;
    if (editing && el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);
  if (editing) {
    return html`<div class="pending-item editing">
      <${Icon} name=${kind === 'steering' ? 'bolt' : 'list'} />
      <div class="pe">
        <textarea ref=${box} value=${draft} aria-label=${`Edit the ${label.toLowerCase()} message`} onInput=${(e) => setDraft(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Escape') setEditing(false);
            else if (e.key === 'Enter' && !e.shiftKey && fine()) {
              e.preventDefault();
              save();
            }
          }}></textarea>
        <div class="pe-bar">
          <span class="muted small">${fine() ? 'Enter to save · Esc to cancel' : hint}</span>
          <button class="btn sm" onClick=${() => setEditing(false)}>Cancel</button>
          <button class="btn sm primary" onClick=${save}>Save</button>
        </div>
      </div>
    </div>`;
  }
  return html`<div class="pending-item" title=${hint}>
    <${Icon} name=${kind === 'steering' ? 'bolt' : 'list'} />
    <div class="pb">
      <button class=${`pt ${open ? 'open' : ''}`} onClick=${startEdit} aria-label=${`${label}: ${text}. Tap to edit`}>
        <b>${label}</b> ${text}
      </button>
      ${images.length > 0 && html`<${Thumbs} images=${images} read=${read} size="sm" />`}
      ${others.length > 0 && html`<div class="att">${others.map((a, i) => html`<span class="chip" key=${i}><${Icon} name="clip" /><span>${a.label}</span></span>`)}</div>`}
    </div>
    <div class="pa">
      ${text.length > 160 && html`<button onClick=${() => setOpen(!open)} aria-label=${open ? 'Show less' : 'Show the whole message'} title=${open ? 'Show less' : 'Show all'}><${Icon} name=${open ? 'up' : 'down'} size="16" /></button>`}
      <button onClick=${startEdit} aria-label="Edit" title="Edit"><${Icon} name="edit" size="16" /></button>
      ${kind === 'queued' && html`<button onClick=${() => run(() => store.sendPendingNow(sessionUri, chat, item.id))} aria-label="Send immediately" title="Send Immediately"><${Icon} name="send" size="16" /></button>`}
      <button onClick=${() => run(() => store.removePending(chat, kind, item.id))} aria-label=${kind === 'steering' ? 'Remove' : 'Remove from queue'} title=${kind === 'steering' ? 'Remove' : 'Remove from Queue'}><${Icon} name="x" size="16" /></button>
    </div>
  </div>`;
}

const SpeechRecognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

/** Dictation with the browser's speech recognition (the text lands in the input for review). */
function useDictation(getText, setText) {
  const rec = useRef(null);
  const [listening, setListening] = useState(false);
  useEffect(() => () => rec.current?.abort(), []);
  const stop = () => rec.current?.stop();
  // On send: drop what is still being recognised, or it would land back in the emptied input.
  const cancel = () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    r.onresult = null;
    try {
      r.abort();
    } catch {
      /* already ended */
    }
    setListening(false);
  };
  const start = () => {
    if (!SpeechRecognition) return;
    const r = new SpeechRecognition();
    rec.current = r;
    const base = getText().trimEnd();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      if (rec.current !== r) return;
      const said = [...e.results].map((x) => x[0]?.transcript || '').join('').trim();
      setText(base && said ? `${base} ${said}` : base || said);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Allow the microphone for this site to dictate', 'err');
      else if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Dictation stopped: ${e.error}`, 'err');
    };
    r.onend = () => {
      if (rec.current === r) rec.current = null;
      setListening(false);
    };
    try {
      r.start();
      haptic(10);
      setListening(true);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  return { supported: !!SpeechRecognition, listening, toggle: () => (listening ? stop() : start()), stop, cancel };
}

export function Composer({ store, conn, sessionUri, session, chat, chatState, autoFocus = false }) {
  const draftKey = `draft:${sessionUri}`;
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey) || '');
  const [attachments, setAttachments] = useState([]);
  const readImage = (u) => store.readImage(u);
  const [uploading, setUploading] = useState(0);
  const [sheet, setSheet] = useState(null);
  const [menu, setMenu] = useState(false);
  const ta = useRef(null);
  const fileInput = useRef(null);
  const textRef = useRef(text);
  textRef.current = text;
  const dictation = useDictation(() => textRef.current, setText);

  useEffect(() => {
    if (text) sessionStorage.setItem(draftKey, text);
    else sessionStorage.removeItem(draftKey);
    const el = ta.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(180, el.scrollHeight)}px`;
    }
  }, [text]);

  // Desktop: focus the input when a session opens, like VS Code's chat (not on touch, where it pops the keyboard).
  useEffect(() => {
    if (autoFocus && fine()) ta.current?.focus({ preventScroll: true });
  }, []);

  const active = !!chatState?.activeTurn;
  const currentModel = chat ? store.modelFor(chat) : null;
  const models = store.models(session?.provider);
  const cfg = store.sessionState.get(sessionUri)?.config;
  const props = cfg?.schema?.properties || {};
  const values = cfg?.values || {};
  const modeOpts = enumOptions(props.mode);
  const approveOpts = enumOptions(props.autoApprove);
  const label = (opts, v) => opts.find((o) => o.value === v)?.label || v;

  const setModel = (m) => {
    try {
      store.setModel(chat, m);
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  async function addFiles(files) {
    for (const file of files) {
      if (file.size > MAX_UPLOAD) {
        toast(`${file.name} is larger than 20 MB`, 'err');
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const isImage = /^image\//.test(file.type);
        const bytes = isImage ? (await downscaleImage(file)) || new Uint8Array(await file.arrayBuffer()) : new Uint8Array(await file.arrayBuffer());
        const name = isImage && !/\.jpe?g$/i.test(file.name) ? `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg` : file.name || 'upload';
        const data = b64(bytes);
        const saved = await conn.upload({ session: sessionUri, name, mime: isImage ? 'image/jpeg' : file.type, data });
        const items = [{ type: 'simple', label: name, modelRepresentation: `The user sent a file from their ${fine() ? 'other computer' : 'phone'} (Pocket Pilot). It is saved on this machine at: ${saved.path}` }];
        if (isImage && bytes.length < 3 * 1024 * 1024) items.push({ type: 'embeddedResource', label: name, data, contentType: 'image/jpeg' });
        setAttachments((a) => [...a, { name, items }]);
      } catch (err) {
        toast(`Upload failed: ${err.message}`, 'err');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  /** how: 'send' (idle), 'steer' (default while working), 'queue' or 'stop'. */
  function send(how) {
    const t = text.trim();
    if (!t && !attachments.length) return;
    const atts = attachments.flatMap((a) => a.items);
    const mode = how || (active ? 'steer' : 'send');
    dictation.cancel();
    try {
      if (!active || mode === 'send') {
        const r = store.sendMessage(sessionUri, { text: t, attachments: atts, model: currentModel || undefined });
        if (r === 'queued') toast('Added to the queue');
      } else if (mode === 'steer') {
        store.steer(sessionUri, { text: t, attachments: atts });
        toast('Sent to the running agent');
      } else if (mode === 'queue') {
        store.sendMessage(sessionUri, { text: t, attachments: atts, model: currentModel || undefined });
        toast('Added to the queue — sends when the agent is done');
      } else if (mode === 'stop') {
        store.stopAndSend(sessionUri, { text: t, attachments: atts, model: currentModel || undefined }).catch((err) => toast(err.message, 'err'));
        toast('Stopping the agent, then sending');
      }
      haptic(10);
      setText('');
      setAttachments([]);
      setMenu(false);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // Desktop keys, like VS Code: Enter sends (steers while working), Alt+Enter adds to the queue.
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && fine()) {
      e.preventDefault();
      send(e.altKey && active ? 'queue' : undefined);
    }
  };

  // Ctrl+V / ⌘V of a screenshot or copied files attaches them; pasted text stays text.
  const onPaste = (e) => {
    const cd = e.clipboardData;
    const files = [...(cd?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length || (cd.getData('text/plain') || '').trim()) return;
    e.preventDefault();
    let n = attachments.filter((a) => a.name.startsWith('Pasted image')).length;
    addFiles(files.map((f) => {
      if (!/^image\//.test(f.type) || (f.name && !/^image\.\w+$/i.test(f.name))) return f;
      n++;
      return new File([f], `Pasted image${n > 1 ? ` ${n}` : ''}.${f.type.split('/')[1] || 'png'}`, { type: f.type });
    }));
  };

  // Files dropped anywhere on the input area are attached.
  const [dragging, setDragging] = useState(false);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const onDragOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };

  const queued = chatState?.queuedMessages || [];
  const steering = chatState?.steeringMessage;
  const hasText = !!text.trim() || attachments.length > 0;
  const mode = values.mode || props.mode?.default;
  const approval = values.autoApprove || props.autoApprove?.default;
  const chip = modelChip(models, currentModel);
  const opts = hasOptions(models, currentModel) ? optionsChip(models, currentModel) : '';
  const placeholder = dictation.listening ? 'Listening…' : active ? 'Steer the agent, or add to the queue…' : `Ask ${providerLabel(session?.provider)} or describe a task…`;
  return html`<div class=${`composer-wrap ${dragging ? 'dropping' : ''}`} onDragOver=${onDragOver} onDragLeave=${onDragLeave} onDrop=${onDrop}>
    ${(queued.length > 0 || steering) && html`<div class="pending-list">
      ${steering && html`<${PendingItem} key=${steering.id} store=${store} sessionUri=${sessionUri} chat=${chat} kind="steering" item=${steering} />`}
      ${queued.map((q) => html`<${PendingItem} key=${q.id} store=${store} sessionUri=${sessionUri} chat=${chat} kind="queued" item=${q} />`)}
    </div>`}
    <div class=${`composer ${dictation.listening ? 'listening' : ''}`}>
      ${(attachments.length > 0 || uploading > 0) && html`<div class="att-row">
        ${attachments.map((a, i) => {
          const pic = a.items.find(isImageAttachment);
          return html`<span class=${`chip ${pic ? 'pic' : ''}`} key=${i}>${pic ? html`<${Thumbs} images=${[pic]} read=${readImage} size="xs" />` : html`<${Icon} name="clip" />`}<span>${a.name}</span><button onClick=${() => setAttachments(attachments.filter((_, j) => j !== i))} aria-label="Remove attachment"><${Icon} name="x" size="14" /></button></span>`;
        })}
        ${uploading > 0 && html`<span class="chip"><span class="spinner"></span>Uploading…</span>`}
      </div>`}
      <textarea ref=${ta} rows="1" placeholder=${placeholder} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey} onPaste=${onPaste}></textarea>
      <input ref=${fileInput} type="file" multiple class="hidden" accept="image/*,.pdf,.txt,.md,.json,.csv,.log,.zip,.png,.jpg,.jpeg,.gif,.webp" onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
      <div class="cbar">
        <div class="left">
          <button class="pick icon" onClick=${() => fileInput.current?.click()} aria-label="Attach photo or file"><${Icon} name="clip" /></button>
          ${models.length > 0 && html`<button class="pick" onClick=${() => setSheet('model')} aria-label=${`Model: ${modelSummary(models, currentModel)}`}><span class="model-name">${chip.name}</span><${Icon} name="down" cls="chev" /></button>`}
          ${opts && html`<button class="pick opts" onClick=${() => setSheet('options')} aria-label=${`Model options: ${opts}`}><span>${opts}</span><${Icon} name="down" cls="chev" /></button>`}
        </div>
        ${dictation.supported && html`<button class=${`pick icon mic ${dictation.listening ? 'on' : ''}`} onClick=${dictation.toggle} aria-pressed=${dictation.listening ? 'true' : 'false'} aria-label=${dictation.listening ? 'Stop dictation' : 'Dictate'}><${Icon} name="mic" /></button>`}
        ${active && html`<button class="stop" onClick=${() => { haptic(20); store.cancelTurn(chat); }} aria-label="Stop the agent"><${Icon} name="stop" /></button>`}
        ${active
          ? html`<div class="send-split">
              <button class="send" disabled=${!hasText || uploading > 0} onClick=${() => send('steer')} aria-label="Steer with message"><${Icon} name="send" /></button>
              <button class="send-more" disabled=${!hasText || uploading > 0} onClick=${() => setMenu(!menu)} aria-label="More send options" aria-expanded=${menu ? 'true' : 'false'}><${Icon} name="down" /></button>
              ${menu && html`<div class="send-menu" role="menu">
                <button role="menuitem" onClick=${() => send('stop')}><${Icon} name="stop" /><span class="grow">Stop and Send</span></button>
                <button role="menuitem" onClick=${() => send('queue')}><${Icon} name="plus" /><span class="grow">Add to Queue</span><kbd>Alt+Enter</kbd></button>
                <button role="menuitem" class="on" onClick=${() => send('steer')}><${Icon} name="bolt" /><span class="grow">Steer with Message</span><kbd>Enter</kbd></button>
              </div>`}
            </div>`
          : html`<button class="send" disabled=${!hasText || uploading > 0} onClick=${() => send()} aria-label="Send"><${Icon} name="send" /></button>`}
      </div>
    </div>
    ${(modeOpts.length > 0 || approveOpts.length > 0) && html`<div class="csub">
      ${modeOpts.length > 0 && html`<button class="sub" onClick=${() => setSheet('mode')} aria-label=${`Mode: ${label(modeOpts, mode)}`}><${Icon} name=${MODE_ICONS[mode] || 'chat'} /><span>${label(modeOpts, mode)}</span></button>`}
      ${approveOpts.length > 0 && html`<button class=${`sub ${approval === 'autoApprove' ? 'warn' : approval === 'assisted' ? 'accent' : ''}`} onClick=${() => setSheet('approve')} aria-label=${`Tool approvals: ${label(approveOpts, approval)}`}><${Icon} name=${APPROVAL_ICONS[approval] || 'shield'} /><span>${label(approveOpts, approval)}</span></button>`}
    </div>`}
    ${menu && html`<div class="menu-scrim" onClick=${() => setMenu(false)}></div>`}
    <${ModelSheet} open=${sheet === 'model'} onClose=${() => setSheet(null)} models=${models} value=${currentModel} onChange=${setModel} />
    <${ModelOptionsSheet} open=${sheet === 'options'} onClose=${() => setSheet(null)} models=${models} value=${currentModel} onChange=${setModel} midSession=${(chatState?.turns?.length || 0) > 0 || active} />
    <${OptionSheet} open=${sheet === 'mode'} title="Mode" value=${mode} options=${modeOpts} icons=${MODE_ICONS} onPick=${(v) => store.setConfig(sessionUri, { mode: v })} onClose=${() => setSheet(null)} />
    <${OptionSheet} open=${sheet === 'approve'} title="Tool approvals" value=${approval} options=${approveOpts} icons=${APPROVAL_ICONS} onPick=${(v) => store.setConfig(sessionUri, { autoApprove: v })} onClose=${() => setSheet(null)} />
  </div>`;
}
