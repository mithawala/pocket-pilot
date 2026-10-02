// Rendering of AHP chat turns: markdown, reasoning, tool calls, confirmations, questions, errors.
import { html, Component, useState, useEffect, useRef } from '../lib/ui.js';
import { renderMarkdown, renderInline, mdPlain, mdOf } from '../lib/markdown.js';
import { highlightElement, rawLanguage } from '../lib/highlight.js';
import { duration, haptic, providerLabel } from '../lib/format.js';
import { openAsks, mcpServer } from '../lib/asks.js';
import { splitAttachments } from '../lib/attachments.js';
import { Icon, Spinner, Switch, toast } from './common.js';
import { Thumbs } from './viewer.js';

/** Wraps each <pre> in a code block with a language label and Copy button, then highlights it. */
function enhanceCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement?.classList.contains('code-block')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.textContent = rawLanguage(pre.querySelector('code')) || 'text';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-btn';
    copy.textContent = 'Copy';
    head.append(label, copy);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

export function Markdown({ text, live }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    enhanceCode(el);
    // While a response streams, wait for a pause before highlighting (it re-renders on every token).
    const timer = setTimeout(() => {
      for (const code of el.querySelectorAll('.code-block pre > code')) highlightElement(code).catch(() => {});
    }, live ? 450 : 0);
    return () => clearTimeout(timer);
  });
  return html`<div class="md" ref=${ref} dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}></div>`;
}

function parseInput(toolInput) {
  if (typeof toolInput !== 'string') return null;
  try {
    return JSON.parse(toolInput);
  } catch {
    return toolInput;
  }
}

function inputPreview(tc) {
  const input = parseInput(tc.toolInput);
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return { kind: 'command', text: input.command };
    if (typeof input.path === 'string' && Object.keys(input).length === 1) return { kind: 'path', text: input.path };
    return { kind: 'json', text: JSON.stringify(input, null, 2) };
  }
  return input ? { kind: 'text', text: String(input) } : null;
}

function resultText(tc) {
  const parts = [];
  for (const c of tc.content || []) {
    if (c.type === 'text' && c.text) parts.push(c.text);
    else if (c.type === 'terminal' && c.result?.preview) parts.push(c.result.preview + (c.result.truncated ? '\n…' : ''));
    else if (c.type === 'fileEdit') parts.push(`✎ ${c.target?.uri || c.uri || 'file edit'}`);
    else if (c.type === 'subagent') parts.push(`↪ ${c.title || 'sub-agent'}`);
  }
  if (tc.error?.message) parts.push(`Error: ${tc.error.message}`);
  const s = parts.join('\n\n');
  return s.length > 6000 ? s.slice(0, 6000) + '\n… (truncated)' : s;
}

/** The progress line VS Code shows for a tool call ("Read file.ts", "Ran `npm test`"), as markdown. */
function toolLabel(tc) {
  if (tc.status === 'completed' || tc.status === 'pending-result-confirmation') return mdOf(tc.pastTenseMessage) || mdOf(tc.invocationMessage) || tc.displayName || tc.toolName;
  if (tc.status === 'cancelled') return `Skipped: ${mdOf(tc.invocationMessage) || tc.displayName || tc.toolName}`;
  return mdOf(tc.invocationMessage) || tc.intention || tc.displayName || tc.toolName;
}

function ToolRow({ tc }) {
  const [open, setOpen] = useState(false);
  const running = tc.status === 'running' || tc.status === 'streaming';
  const failed = tc.status === 'cancelled' || tc.success === false;
  // A request that is no longer open but never got an outcome (the agent moved on without one).
  const unsettled = ['pending-confirmation', 'pending-result-confirmation', 'auth-required'].includes(tc.status);
  const preview = open ? inputPreview(tc) : null;
  const out = open ? resultText(tc) : '';
  const toggle = (e) => {
    if (e.target.closest('[data-file]')) return;
    setOpen(!open);
  };
  return html`<div class=${`tool ${failed ? 'failed' : ''}`}>
    <button class="head" onClick=${toggle} aria-expanded=${open}>
      <span class="ts">${running ? html`<${Spinner} />` : failed ? html`<span class="errc"><${Icon} name="x" /></span>` : unsettled ? html`<span class="dimc"><${Icon} name=${tc.status === 'auth-required' ? 'key' : 'shield'} /></span>` : html`<span class="okc"><${Icon} name="check" /></span>`}</span>
      <span class="tt" dangerouslySetInnerHTML=${{ __html: renderInline(toolLabel(tc)) }}></span>
      <${Icon} name=${open ? 'down' : 'right'} cls="tchev" />
    </button>
    ${open && html`<div class="detail">
      ${tc.intention && html`<div class="muted small">${tc.intention}</div>`}
      ${preview && html`<div class="lbl">${preview.kind === 'command' ? 'Command' : 'Input'}</div><pre>${preview.kind === 'command' ? `$ ${preview.text}` : preview.text}</pre>`}
      ${out && html`<div class="lbl">Output</div><pre>${out}</pre>`}
      ${!preview && !out && html`<div class="muted small">No details.</div>`}
    </div>`}
  </div>`;
}

function ToolGroup({ calls, activeTurn }) {
  const runningCount = calls.filter((c) => c.status === 'running' || c.status === 'streaming').length;
  const [open, setOpen] = useState(false);
  if (calls.length <= 2 || runningCount || (activeTurn && calls.length <= 4)) {
    return html`<div class="tools">${calls.map((tc) => html`<${ToolRow} key=${tc.toolCallId} tc=${tc} />`)}</div>`;
  }
  const failed = calls.filter((c) => c.status === 'cancelled' || c.success === false).length;
  return html`<div class="tools">
    <button class="group-head" onClick=${() => setOpen(!open)} aria-expanded=${open}>
      <${Icon} name=${open ? 'down' : 'right'} />
      <span>Used ${calls.length} tools${failed ? ` · ${failed} failed` : ''}</span>
    </button>
    ${open ? html`<div class="tools nested">${calls.map((tc) => html`<${ToolRow} key=${tc.toolCallId} tc=${tc} />`)}</div>` : html`<${ToolRow} tc=${calls[calls.length - 1]} />`}
  </div>`;
}

function Reasoning({ text, live }) {
  const [open, setOpen] = useState(false);
  const preview = mdPlain(text, 110);
  return html`<div class=${`reasoning ${live ? 'live' : ''}`}>
    <button onClick=${() => setOpen(!open)} aria-expanded=${open}>
      <${Icon} name=${open ? 'down' : 'right'} />
      <span class=${`rl ${live ? 'shimmer' : ''}`}>${live ? 'Thinking…' : 'Thought'}</span>
      ${!open && !live && preview && html`<span class="rp">${preview}</span>`}
    </button>
    ${open && html`<div class="body"><${Markdown} text=${text} /></div>`}
  </div>`;
}

function ConfirmCard({ tc, turnId, ctx }) {
  const [busy, setBusy] = useState(false);
  const preview = inputPreview(tc);
  const risk = tc.riskAssessment?.status === 'complete' ? tc.riskAssessment : null;
  const edits = tc.edits?.items || [];
  const act = (approved, optionId) => {
    setBusy(true);
    haptic(approved ? 15 : [10, 40, 10]);
    try {
      ctx.store.confirmTool(ctx.chat, turnId, tc.toolCallId, approved, optionId);
    } catch (err) {
      setBusy(false);
      toast(err.message, 'err');
    }
  };
  const options = Array.isArray(tc.options) && tc.options.length ? tc.options : null;
  let buttons;
  if (options) {
    // Same choices as VS Code; the one-off approval is the primary action, like VS Code's "Allow".
    const approves = options.filter((o) => o.kind === 'approve');
    const primary = approves.find((o) => /once/i.test(`${o.id} ${o.label}`)) || approves[0];
    const ordered = [primary, ...approves.filter((o) => o !== primary), ...options.filter((o) => o.kind !== 'approve')].filter(Boolean);
    buttons = ordered.map((o) => html`<button key=${o.id} class=${`btn ${o === primary ? 'primary' : ''}`} disabled=${busy} onClick=${() => act(o.kind === 'approve', o.id)}>${o.label}</button>`);
  } else {
    buttons = [
      html`<button key="allow" class="btn primary" disabled=${busy} onClick=${() => act(true)}>Allow</button>`,
      html`<button key="skip" class="btn" disabled=${busy} onClick=${() => act(false)}>Skip</button>`,
    ];
  }
  const message = mdOf(tc.invocationMessage);
  return html`<div class="confirm" id=${`confirm-${tc.toolCallId}`}>
    <div class="ch"><${Icon} name="shield" /><span>${mdPlain(tc.confirmationTitle) || `Allow ${tc.displayName || tc.toolName}?`}</span></div>
    ${message && html`<div class="cm"><${Markdown} text=${message} /></div>`}
    ${preview && (preview.kind === 'command'
      ? html`<pre class="cmd"><span class="prompt">$ </span>${preview.text}</pre>`
      : html`<pre class="cmd">${preview.text.slice(0, 4000)}</pre>`)}
    ${edits.length > 0 && html`<div class="note">${edits.length} file edit${edits.length === 1 ? '' : 's'} will be applied.</div>`}
    ${risk && html`<div class="risk">Risk check: ${mdPlain(risk.reason, 240)}${typeof risk.safety === 'number' ? ` · safety ${Math.round(risk.safety * 100)}%` : ''}</div>`}
    <div class="actions">${buttons}</div>
  </div>`;
}

function ResultConfirmCard({ tc, turnId, ctx }) {
  const out = resultText(tc);
  return html`<div class="confirm">
    <div class="ch"><${Icon} name="shield" /><span>Review the result of ${tc.displayName}</span></div>
    ${out && html`<pre class="cmd">${out}</pre>`}
    <div class="actions">
      <button class="btn primary" onClick=${() => ctx.store.confirmResult(ctx.chat, turnId, tc.toolCallId, true)}>Accept</button>
      <button class="btn" onClick=${() => ctx.store.confirmResult(ctx.chat, turnId, tc.toolCallId, false)}>Reject</button>
    </div>
  </div>`;
}

/** An MCP tool paused on a sign-in, which only the PC can do. */
function AuthCard({ tc, ctx }) {
  const server = tc._meta?.mcpServerName || (mcpServer(tc) ? String(mcpServer(tc)).split(':').pop() : '') || tc.displayName || tc.toolName;
  const tool = tc._meta?.mcpToolName;
  return html`<div class="confirm info">
    <div class="ch"><${Icon} name="key" /><span>Sign in to ${server} on your PC</span></div>
    <div class="cm muted small">The agent is paused until you do${tool ? `, so it can use ${tool}` : ''}. Sign in from this chat in ${ctx.host || 'VS Code'}, or stop the agent to go on without it.</div>
  </div>`;
}

function QuestionField({ q, value, onChange, own, onOwn }) {
  if (q.kind === 'boolean') {
    return html`<div class="row"><span class="grow">${q.message}</span><${Switch} on=${!!value} label=${q.message} onChange=${onChange} /></div>`;
  }
  if (q.kind === 'single-select' || q.kind === 'multi-select') {
    const multi = q.kind === 'multi-select';
    const sel = multi ? value || [] : value;
    // The agent takes an answer in your own words too: instead of a choice, or (several choices) with them.
    const typed = !!q.allowFreeformInput && !multi && !!(own || '').trim();
    return html`<div>
      <div class="qt">${q.title || q.message}</div>
      ${q.title && html`<div class="muted small" style="margin:-2px 0 8px">${q.message}</div>`}
      <div class="options" role=${multi ? 'group' : 'radiogroup'}>
        ${q.options.map((o) => {
          const on = multi ? sel.includes(o.id) : sel === o.id && !typed;
          return html`<button key=${o.id} class=${`opt ${on ? 'on' : ''}`} role=${multi ? 'checkbox' : 'radio'} aria-checked=${on ? 'true' : 'false'} onClick=${() => {
            onChange(multi ? (on ? sel.filter((x) => x !== o.id) : [...sel, o.id]) : o.id);
            if (!multi) onOwn('');
          }}>
            <span class=${`mark ${multi ? 'box' : ''}`}></span>
            <span class="grow">${o.label}${o.recommended && html`<span class="rec">Recommended</span>`}${o.description && html`<small>${o.description}</small>`}</span>
          </button>`;
        })}
      </div>
      ${q.allowFreeformInput && html`<textarea class=${`input own ${typed ? 'on' : ''}`} rows="2" value=${own || ''} placeholder=${multi ? 'Add your own answer…' : 'Or type your own answer…'} aria-label=${multi ? 'Your own answer, with the choices' : 'Your own answer, instead of a choice'} onInput=${(e) => onOwn(e.target.value)}></textarea>`}
    </div>`;
  }
  const numeric = q.kind === 'number' || q.kind === 'integer';
  return html`<div class="field">
    <div class="qt">${q.title || q.message}</div>
    ${q.title && html`<div class="muted small">${q.message}</div>`}
    <input class="input" type=${numeric ? 'number' : 'text'} value=${value ?? q.defaultValue ?? ''} onInput=${(e) => onChange(numeric ? Number(e.target.value) : e.target.value)} />
  </div>`;
}

/**
 * The answer to one question, as VS Code sends it: an answer typed instead of a choice is a text answer,
 * and one typed along with several choices goes with them (`freeformValues`). Null when unanswered.
 */
export function answerFor(q, v, own) {
  const typed = q.allowFreeformInput ? String(own || '').trim() : '';
  if (typed && q.kind === 'single-select') return { state: 'submitted', value: { kind: 'text', value: typed } };
  if (typed && q.kind === 'multi-select') {
    const sel = Array.isArray(v) ? v : [];
    return { state: 'submitted', value: sel.length ? { kind: 'selected-many', value: sel, freeformValues: [typed] } : { kind: 'text', value: typed } };
  }
  if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
  const kind = q.kind === 'boolean' ? 'boolean' : q.kind === 'single-select' ? 'selected' : q.kind === 'multi-select' ? 'selected-many' : q.kind === 'number' || q.kind === 'integer' ? 'number' : 'text';
  return { state: 'submitted', value: { kind, value: v } };
}

function InputRequestCard({ request, ctx }) {
  const qs = request.questions || [];
  const [vals, setVals] = useState(() => Object.fromEntries(qs.map((q) => [q.id, q.defaultValue])));
  const [own, setOwn] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = (response) => {
    setBusy(true);
    haptic(15);
    const answers = {};
    if (response === 'accept') {
      for (const q of qs) {
        const a = answerFor(q, vals[q.id], own[q.id]);
        if (a) answers[q.id] = a;
        else if (!q.required) answers[q.id] = { state: 'skipped' };
      }
    }
    try {
      ctx.store.answerInput(ctx.chat, request.id, response, response === 'accept' ? answers : undefined);
    } catch (err) {
      setBusy(false);
      toast(err.message, 'err');
    }
  };
  const missing = qs.some((q) => q.required && !answerFor(q, vals[q.id], own[q.id]));
  return html`<div class="confirm info">
    <div class="ch"><${Icon} name="chat" /><span>The agent has a question</span></div>
    ${request.message && html`<div class="cm"><${Markdown} text=${request.message} /></div>`}
    ${request.url && html`<div class="qbody"><a class="btn sm" href=${request.url} target="_blank" rel="noopener noreferrer">Open link</a></div>`}
    ${qs.length > 0 && html`<div class="qbody">${qs.map((q) => html`<div class="question" key=${q.id}><${QuestionField} q=${q} value=${vals[q.id]} onChange=${(v) => setVals({ ...vals, [q.id]: v })} own=${own[q.id]} onOwn=${(t) => setOwn((o) => ({ ...o, [q.id]: t }))} /></div>`)}</div>`}
    <div class="actions">
      <button class="btn primary" disabled=${busy || missing} onClick=${() => submit('accept')}>${qs.length ? 'Submit' : 'Done'}</button>
      <button class="btn" disabled=${busy} onClick=${() => submit('decline')}>Skip</button>
    </div>
  </div>`;
}

/** Groups consecutive plain tool calls so a long agent run stays readable; open requests stand alone. */
function groupParts(parts, open) {
  const out = [];
  let tools = null;
  for (const p of parts) {
    const plainTool = p.kind === 'toolCall' && !open.has(p);
    if (plainTool) {
      if (!tools) out.push((tools = { kind: 'tools', calls: [] }));
      tools.calls.push(p.toolCall);
      continue;
    }
    tools = null;
    out.push(p);
  }
  return out;
}

/** One-line summary of an answered (or skipped) question, e.g. "Answered · Date library: date-fns". */
function answerText(part) {
  const req = part.request || {};
  if (part.response !== 'accept') return `Skipped: ${mdPlain(req.message || req.questions?.[0]?.message, 90)}`;
  const bits = [];
  for (const q of req.questions || []) {
    const a = req.answers?.[q.id];
    if (!a || a.state !== 'submitted') continue;
    const v = a.value?.value;
    const label = (id) => q.options?.find((o) => o.id === id)?.label || String(id);
    const own = (a.value?.freeformValues || []).filter((x) => typeof x === 'string' && x.trim());
    const text = Array.isArray(v) ? [...v.map(label), ...own].join(', ') : q.options ? label(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    bits.push(`${q.title || mdPlain(q.message, 40)}: ${text}`);
  }
  return bits.length ? `Answered · ${bits.join(' · ')}` : `Answered: ${mdPlain(req.message, 90)}`;
}

function Parts({ parts, turnId, active, ctx, retry, open }) {
  const grouped = groupParts(parts, open);
  const lastIdx = grouped.length - 1;
  return grouped.map((p, i) => {
    const live = active && i === lastIdx;
    switch (p.kind) {
      case 'tools':
        return html`<${ToolGroup} key=${`t${i}`} calls=${p.calls} activeTurn=${active} />`;
      case 'markdown':
        return html`<div class="assistant" key=${p.id || i}><${Markdown} text=${p.content} live=${live} /></div>`;
      case 'reasoning':
        return html`<${Reasoning} key=${p.id || i} text=${p.content} live=${live} />`;
      case 'toolCall':
        // Only open requests get here (see groupParts).
        if (p.toolCall.status === 'pending-confirmation') return html`<${ConfirmCard} key=${p.toolCall.toolCallId} tc=${p.toolCall} turnId=${turnId} ctx=${ctx} />`;
        if (p.toolCall.status === 'pending-result-confirmation') return html`<${ResultConfirmCard} key=${p.toolCall.toolCallId} tc=${p.toolCall} turnId=${turnId} ctx=${ctx} />`;
        return html`<${AuthCard} key=${p.toolCall.toolCallId} tc=${p.toolCall} ctx=${ctx} />`;
      case 'inputRequest':
        if (open.has(p)) return html`<${InputRequestCard} key=${p.request.id} request=${p.request} ctx=${ctx} />`;
        if (!p.response && active) {
          // The agent went on without an answer from this app: it was dealt with on the PC.
          return html`<div class="tools" key=${p.request.id}><div class="tool"><div class="head">
            <span class="ts"><span class="dimc"><${Icon} name="chat" /></span></span>
            <span class="tt">${mdPlain(p.request?.message || p.request?.questions?.[0]?.message, 90) || 'Question'}</span>
          </div></div></div>`;
        }
        return html`<div class="tools" key=${p.request.id}><div class=${`tool ${p.response === 'accept' ? '' : 'failed'}`}><div class="head">
          <span class="ts">${p.response === 'accept' ? html`<span class="okc"><${Icon} name="check" /></span>` : html`<span class="errc"><${Icon} name="x" /></span>`}</span>
          <span class="tt">${answerText(p)}</span>
        </div></div></div>`;
      case 'error':
        return html`<div class="errpart" key=${`e${i}`}>
          <b>Error:</b> ${p.error?.message || 'Something went wrong'}
          ${p.resumable && !active && html`<div class="retry"><button class="btn sm" onClick=${() => ctx.store.resumeTurn(ctx.chat, turnId)}>Retry</button></div>`}
          ${!p.resumable && !active && retry && html`<div class="retry"><button class="btn sm" onClick=${retry}><${Icon} name="refresh" size="15" /> Try again</button></div>`}
        </div>`;
      case 'systemNotification':
        return html`<div class="sysnote" key=${`s${i}`}>${mdPlain(p.content, 200)}</div>`;
      case 'contentRef':
        return html`<div class="sysnote" key=${`r${i}`}>📎 ${p.uri || 'attachment'}</div>`;
      default:
        return null;
    }
  });
}

function UserMessage({ message, pending, read }) {
  const { images, others } = splitAttachments(message);
  return html`<div class="msg-user">
    <div>
      ${(message.text || !images.length) && html`<div class=${`bubble ${pending ? 'pending' : ''}`}>${message.text}</div>`}
      ${images.length > 0 && html`<${Thumbs} images=${images} read=${read} />`}
      ${others.length > 0 && html`<div class="att">${others.map((a, i) => html`<span class="chip" key=${i}><${Icon} name=${a.displayKind === 'image' ? 'image' : 'clip'} /><span>${a.label}</span></span>`)}</div>`}
    </div>
  </div>`;
}

function RespHead({ provider }) {
  return html`<div class="resp-head"><img class=${`av ${provider === 'claude' ? 'claude' : ''}`} src="./icons/bot.svg" alt="" /><span>${providerLabel(provider)}</span></div>`;
}

export class Turn extends Component {
  shouldComponentUpdate(next) {
    return next.turn !== this.props.turn || next.active !== this.props.active || next.activity !== this.props.activity || next.isLast !== this.props.isLast;
  }
  render({ turn, active, activity, ctx, isLast }) {
    const parts = turn.responseParts || [];
    const last = parts[parts.length - 1];
    // Requests still open in this turn; a past turn has none (see openAsks).
    const open = new Set(active ? openAsks(turn) : []);
    // "Working…" between steps, but not while the agent waits for you: the request's card says so.
    const waiting = active && !open.size && (!last || (last.kind !== 'markdown' && !(last.kind === 'toolCall' && ['running', 'streaming'].includes(last.toolCall.status)) && last.kind !== 'reasoning'));
    const model = turn.message?.model?.id;
    return html`<div class="turn">
      <${UserMessage} message=${turn.message} read=${ctx.readImage} />
      <${RespHead} provider=${ctx.provider} />
      <${Parts} parts=${parts} turnId=${turn.id} active=${active} ctx=${ctx} open=${open} retry=${isLast && turn.state === 'error' ? ctx.retry?.(turn) : null} />
      ${active && waiting && html`<div class="activity-line"><${Spinner} /><span class="shimmer">${activity || 'Working…'}</span></div>`}
      ${!active && html`<div class="turn-foot">
        ${turn.state === 'cancelled' && html`<span>Stopped</span>`}
        ${turn.state === 'error' && html`<span class="st-error">Error</span>`}
        ${turn.duration ? html`<span>${duration(turn.duration)}</span>` : null}
        ${model && html`<span>${ctx.modelName(model)}</span>`}
      </div>`}
    </div>`;
  }
}

export function PendingTurn({ message, read }) {
  return html`<div class="turn"><${UserMessage} message=${message} pending=${true} read=${read} /><div class="activity-line"><${Spinner} /><span class="shimmer">Sending…</span></div></div>`;
}
