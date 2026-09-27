import { html, useState, useRef, useEffect } from '../lib/ui.js';
import { Icon, Sheet, toast } from './common.js';
import { ModelSheet, modelSummary } from './model-picker.js';
import { b64 } from '../core/bytes.js';
import { haptic } from '../lib/format.js';

const MAX_UPLOAD = 20 * 1024 * 1024;

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

function OptionSheet({ open, title, options, value, onPick, onClose }) {
  return html`<${Sheet} open=${open} onClose=${onClose} title=${title}>
    ${options.map((o) => html`<button class=${`list-item ${o.value === value ? 'on' : ''}`} onClick=${() => { onPick(o.value); onClose(); }}>
      <div class="grow"><div>${o.label}</div>${o.description && html`<div class="muted small">${o.description}</div>`}</div>
      ${o.value === value && html`<span class="check"><${Icon} name="check" /></span>`}
    </button>`)}
  </${Sheet}>`;
}

function enumOptions(schema) {
  if (!schema?.enum) return [];
  return schema.enum.map((v, i) => ({ value: v, label: schema.enumLabels?.[i] || v, description: schema.enumDescriptions?.[i] }));
}

export function Composer({ store, conn, sessionUri, session, chat, chatState }) {
  const draftKey = `draft:${sessionUri}`;
  const modelKey = `model:${sessionUri}`;
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey) || '');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(0);
  const [sheet, setSheet] = useState(null);
  const [model, setModelState] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(modelKey) || 'null');
    } catch {
      return null;
    }
  });
  const setModel = (m) => {
    setModelState(m);
    sessionStorage.setItem(modelKey, JSON.stringify(m));
  };
  const [steer, setSteer] = useState(false);
  const ta = useRef(null);
  const fileInput = useRef(null);

  useEffect(() => {
    if (text) sessionStorage.setItem(draftKey, text);
    else sessionStorage.removeItem(draftKey);
    const el = ta.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(180, el.scrollHeight)}px`;
    }
  }, [text]);

  const active = !!chatState?.activeTurn;
  const lastModel = [...(chatState?.turns || [])].reverse().find((t) => t.message?.model)?.message.model || chatState?.activeTurn?.message?.model || null;
  const currentModel = model || lastModel;
  const models = store.models(session?.provider);
  const cfg = store.sessionState.get(sessionUri)?.config;
  const props = cfg?.schema?.properties || {};
  const values = cfg?.values || {};
  const modeOpts = enumOptions(props.mode);
  const approveOpts = enumOptions(props.autoApprove);
  const label = (opts, v) => opts.find((o) => o.value === v)?.label || v;

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
        const items = [{ type: 'simple', label: name, modelRepresentation: `The user sent a file from their phone. It is saved on this machine at: ${saved.path}` }];
        if (isImage && bytes.length < 3 * 1024 * 1024) items.push({ type: 'embeddedResource', label: name, data, contentType: 'image/jpeg' });
        setAttachments((a) => [...a, { name, items }]);
      } catch (err) {
        toast(`Upload failed: ${err.message}`, 'err');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function send() {
    const t = text.trim();
    if (!t && !attachments.length) return;
    try {
      if (active && steer) {
        store.steer(sessionUri, t);
        toast('Sent to the running agent');
      } else {
        const r = store.sendMessage(sessionUri, { text: t, attachments: attachments.flatMap((a) => a.items), model: currentModel || undefined });
        if (r === 'queued') toast('Queued — sends when the current step finishes');
      }
      haptic(10);
      setText('');
      setAttachments([]);
      setSteer(false);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      send();
    }
  };

  const queued = chatState?.queuedMessages || [];
  const steering = chatState?.steeringMessage;
  return html`<div class="composer-wrap">
    ${(queued.length > 0 || steering) && html`<div class="pending-list">
      ${steering && html`<div class="pending-item"><${Icon} name="bolt" size="15" /><span>Steering: ${steering.message.text}</span><button onClick=${() => store.removePending(chat, 'steering', steering.id)} aria-label="Remove"><${Icon} name="x" size="16" /></button></div>`}
      ${queued.map((q) => html`<div class="pending-item" key=${q.id}><${Icon} name="list" size="15" /><span>Queued: ${q.message.text}</span><button onClick=${() => store.removePending(chat, 'queued', q.id)} aria-label="Remove"><${Icon} name="x" size="16" /></button></div>`)}
    </div>`}
    <div class="composer">
      <div class="pills">
        ${models.length > 0 && html`<button class="chip" onClick=${() => setSheet('model')}><${Icon} name="cpu" />${modelSummary(models, currentModel)}</button>`}
        ${modeOpts.length > 0 && html`<button class="chip" onClick=${() => setSheet('mode')}><${Icon} name="wand" />${label(modeOpts, values.mode || props.mode?.default)}</button>`}
        ${approveOpts.length > 0 && html`<button class="chip" onClick=${() => setSheet('approve')}><${Icon} name="shield" />${label(approveOpts, values.autoApprove || props.autoApprove?.default)}</button>`}
        ${active && html`<button class=${`chip ${steer ? 'on' : ''}`} onClick=${() => setSteer(!steer)}><${Icon} name="bolt" />Steer now</button>`}
      </div>
      ${(attachments.length > 0 || uploading > 0) && html`<div class="att-row">
        ${attachments.map((a, i) => html`<span class="chip" key=${i}><${Icon} name="image" />${a.name}<button onClick=${() => setAttachments(attachments.filter((_, j) => j !== i))} aria-label="Remove attachment"><${Icon} name="x" size="14" /></button></span>`)}
        ${uploading > 0 && html`<span class="chip"><span class="spinner"></span>Uploading…</span>`}
      </div>`}
      <div class="line">
        <button class="attach" onClick=${() => fileInput.current?.click()} aria-label="Attach photo or file"><${Icon} name="clip" /></button>
        <input ref=${fileInput} type="file" multiple class="hidden" accept="image/*,.pdf,.txt,.md,.json,.csv,.log,.zip,.png,.jpg,.jpeg,.gif,.webp" onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        <textarea ref=${ta} rows="1" placeholder=${active ? (steer ? 'Steer the agent…' : 'Follow up…') : 'Message the agent…'} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey}></textarea>
        ${active && html`<button class="stop" onClick=${() => { haptic(20); store.cancelTurn(chat); }} aria-label="Stop the agent"><${Icon} name="stop" /></button>`}
        <button class="send" disabled=${(!text.trim() && !attachments.length) || uploading > 0} onClick=${send} aria-label="Send"><${Icon} name="send" /></button>
      </div>
    </div>
    <${ModelSheet} open=${sheet === 'model'} onClose=${() => setSheet(null)} models=${models} value=${currentModel} onChange=${setModel} />
    <${OptionSheet} open=${sheet === 'mode'} title="Mode" value=${values.mode} options=${modeOpts} onPick=${(v) => store.setConfig(sessionUri, { mode: v })} onClose=${() => setSheet(null)} />
    <${OptionSheet} open=${sheet === 'approve'} title="Tool approvals" value=${values.autoApprove} options=${approveOpts} onPick=${(v) => store.setConfig(sessionUri, { autoApprove: v })} onClose=${() => setSheet(null)} />
  </div>`;
}
