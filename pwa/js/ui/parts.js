// Rendering of AHP chat turns: markdown, reasoning, tool calls, confirmations, questions, errors.
import { html, Component, useState, useEffect, useRef } from '../lib/ui.js';
import { renderMarkdown, mdPlain, mdOf } from '../lib/markdown.js';
import { duration, haptic } from '../lib/format.js';
import { Icon, toolIcon, Spinner, Switch, toast } from './common.js';

export function Markdown({ text }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const pre of el.querySelectorAll('pre')) {
      if (pre.querySelector('.copy-btn')) continue;
      const b = document.createElement('button');
      b.className = 'copy-btn';
      b.type = 'button';
      b.textContent = 'Copy';
      pre.appendChild(b);
    }
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

function toolLabel(tc) {
  if (tc.status === 'completed' || tc.status === 'pending-result-confirmation') return mdPlain(tc.pastTenseMessage) || mdPlain(tc.invocationMessage) || tc.displayName;
  if (tc.status === 'cancelled') return `Skipped: ${mdPlain(tc.invocationMessage) || tc.displayName}`;
  return mdPlain(tc.invocationMessage) || tc.intention || tc.displayName || tc.toolName;
}

function ToolRow({ tc }) {
  const [open, setOpen] = useState(false);
  const running = tc.status === 'running' || tc.status === 'streaming';
  const failed = tc.status === 'cancelled' || tc.success === false;
  const preview = open ? inputPreview(tc) : null;
  const out = open ? resultText(tc) : '';
  return html`<div class="tool">
    <button class="head" onClick=${() => setOpen(!open)} aria-expanded=${open}>
      <span class="ti"><${Icon} name=${toolIcon(tc)} /></span>
      <span class="tt"><b>${tc.displayName || tc.toolName}</b> · ${toolLabel(tc)}</span>
      <span class="ts">${running ? html`<${Spinner} />` : failed ? html`<span class="errc"><${Icon} name="x" size="16" /></span>` : html`<span class="okc"><${Icon} name="check" size="16" /></span>`}</span>
    </button>
    ${open && html`<div class="detail">
      ${tc.intention && html`<div class="muted small">${tc.intention}</div>`}
      ${preview && html`<div class="lbl">${preview.kind === 'command' ? 'Command' : 'Input'}</div><pre>${preview.kind === 'command' ? `$ ${preview.text}` : preview.text}</pre>`}
      ${out && html`<div class="lbl">Result</div><pre>${out}</pre>`}
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
      <${Icon} name=${open ? 'down' : 'right'} size="16" />
      <span>Used ${calls.length} tools${failed ? ` · ${failed} failed` : ''}</span>
    </button>
    ${open ? calls.map((tc) => html`<${ToolRow} key=${tc.toolCallId} tc=${tc} />`) : html`<${ToolRow} tc=${calls[calls.length - 1]} />`}
  </div>`;
}

function Reasoning({ text, live }) {
  const [open, setOpen] = useState(false);
  const first = mdPlain(text, 90) || 'Thinking…';
  return html`<div class="reasoning">
    <button onClick=${() => setOpen(!open)} aria-expanded=${open}>
      ${live ? html`<${Spinner} />` : html`<${Icon} name="brain" size="15" />`}
      <span>${open ? 'Thinking' : first}</span>
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
  return html`<div class="confirm" id=${`confirm-${tc.toolCallId}`}>
    <div class="ch"><${Icon} name="shield" /> ${mdPlain(tc.confirmationTitle) || `Allow ${tc.displayName || tc.toolName}?`}</div>
    <div class="cm"><${Markdown} text=${mdOf(tc.invocationMessage)} /></div>
    ${preview && html`<pre>${preview.kind === 'command' ? `$ ${preview.text}` : preview.text.slice(0, 4000)}</pre>`}
    ${edits.length > 0 && html`<div class="muted small">${edits.length} file edit(s) will be applied.</div>`}
    ${risk && html`<div class="risk">Risk check: ${mdPlain(risk.reason, 240)}${typeof risk.safety === 'number' ? ` · safety ${Math.round(risk.safety * 100)}%` : ''}</div>`}
    <div class="actions">
      ${options
        ? options.map((o) => html`<button class=${`btn ${o.kind === 'approve' ? 'ok' : 'danger'}`} disabled=${busy} onClick=${() => act(o.kind === 'approve', o.id)}>${o.label}</button>`)
        : html`<button class="btn danger" disabled=${busy} onClick=${() => act(false)}>Deny</button><button class="btn ok" disabled=${busy} onClick=${() => act(true)}>Allow</button>`}
    </div>
  </div>`;
}

function ResultConfirmCard({ tc, turnId, ctx }) {
  const out = resultText(tc);
  return html`<div class="confirm">
    <div class="ch"><${Icon} name="shield" /> Review the result of ${tc.displayName}</div>
    ${out && html`<pre>${out}</pre>`}
    <div class="actions">
      <button class="btn danger" onClick=${() => ctx.store.confirmResult(ctx.chat, turnId, tc.toolCallId, false)}>Reject</button>
      <button class="btn ok" onClick=${() => ctx.store.confirmResult(ctx.chat, turnId, tc.toolCallId, true)}>Accept</button>
    </div>
  </div>`;
}

function QuestionField({ q, value, onChange }) {
  if (q.kind === 'boolean') {
    return html`<div class="row"><span class="grow">${q.message}</span><${Switch} on=${!!value} label=${q.message} onChange=${onChange} /></div>`;
  }
  if (q.kind === 'single-select' || q.kind === 'multi-select') {
    const multi = q.kind === 'multi-select';
    const sel = multi ? value || [] : value;
    return html`<div>
      <div class="qt">${q.title || q.message}</div>
      ${q.title && html`<div class="muted small">${q.message}</div>`}
      <div class="options" role=${multi ? 'group' : 'radiogroup'}>
        ${q.options.map((o) => {
          const on = multi ? sel.includes(o.id) : sel === o.id;
          return html`<button class=${`chip ${on ? 'on' : ''}`} onClick=${() => onChange(multi ? (on ? sel.filter((x) => x !== o.id) : [...sel, o.id]) : o.id)}>
            ${o.label}${o.recommended ? ' ★' : ''}${o.description ? html`<small>${o.description}</small>` : null}
          </button>`;
        })}
      </div>
    </div>`;
  }
  const numeric = q.kind === 'number' || q.kind === 'integer';
  return html`<div class="field">
    <label>${q.title || q.message}</label>
    ${q.title && html`<div class="muted small">${q.message}</div>`}
    <input class="input" type=${numeric ? 'number' : 'text'} value=${value ?? q.defaultValue ?? ''} onInput=${(e) => onChange(numeric ? Number(e.target.value) : e.target.value)} />
  </div>`;
}

function answerFor(q, v) {
  if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
  const kind = q.kind === 'boolean' ? 'boolean' : q.kind === 'single-select' ? 'selected' : q.kind === 'multi-select' ? 'selected-many' : q.kind === 'number' || q.kind === 'integer' ? 'number' : 'text';
  return { state: 'submitted', value: { kind, value: v } };
}

function InputRequestCard({ request, ctx }) {
  const qs = request.questions || [];
  const [vals, setVals] = useState(() => Object.fromEntries(qs.map((q) => [q.id, q.defaultValue])));
  const [busy, setBusy] = useState(false);
  const submit = (response) => {
    setBusy(true);
    haptic(15);
    const answers = {};
    if (response === 'accept') {
      for (const q of qs) {
        const a = answerFor(q, vals[q.id]);
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
  const missing = qs.some((q) => q.required && !answerFor(q, vals[q.id]));
  return html`<div class="confirm">
    <div class="ch"><${Icon} name="info" /> The agent has a question</div>
    ${request.message && html`<div class="cm"><${Markdown} text=${request.message} /></div>`}
    ${request.url && html`<a class="btn sm" href=${request.url} target="_blank" rel="noopener noreferrer">Open link</a>`}
    ${qs.map((q) => html`<div class="question" key=${q.id}><${QuestionField} q=${q} value=${vals[q.id]} onChange=${(v) => setVals({ ...vals, [q.id]: v })} /></div>`)}
    <div class="actions">
      <button class="btn" disabled=${busy} onClick=${() => submit('decline')}>Skip</button>
      <button class="btn primary" disabled=${busy || missing} onClick=${() => submit('accept')}>${qs.length ? 'Submit' : 'Done'}</button>
    </div>
  </div>`;
}

/** Groups consecutive plain tool calls so a long agent run stays readable. */
function groupParts(parts) {
  const out = [];
  let tools = null;
  for (const p of parts) {
    const plainTool = p.kind === 'toolCall' && !['pending-confirmation', 'pending-result-confirmation', 'auth-required'].includes(p.toolCall.status);
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

function Parts({ parts, turnId, active, ctx }) {
  const grouped = groupParts(parts);
  const lastIdx = grouped.length - 1;
  return grouped.map((p, i) => {
    const live = active && i === lastIdx;
    switch (p.kind) {
      case 'tools':
        return html`<${ToolGroup} key=${`t${i}`} calls=${p.calls} activeTurn=${active} />`;
      case 'markdown':
        return html`<div class="assistant" key=${p.id || i}><${Markdown} text=${p.content} /></div>`;
      case 'reasoning':
        return html`<${Reasoning} key=${p.id || i} text=${p.content} live=${live} />`;
      case 'toolCall':
        if (p.toolCall.status === 'pending-confirmation') return active ? html`<${ConfirmCard} key=${p.toolCall.toolCallId} tc=${p.toolCall} turnId=${turnId} ctx=${ctx} />` : null;
        if (p.toolCall.status === 'pending-result-confirmation') return active ? html`<${ResultConfirmCard} key=${p.toolCall.toolCallId} tc=${p.toolCall} turnId=${turnId} ctx=${ctx} />` : null;
        return html`<div class="confirm" key=${p.toolCall.toolCallId}><div class="ch"><${Icon} name="key" /> ${p.toolCall.displayName} needs you to sign in on the PC.</div></div>`;
      case 'inputRequest':
        if (!p.response && active) return html`<${InputRequestCard} key=${p.request.id} request=${p.request} ctx=${ctx} />`;
        return html`<div class="sysnote" key=${p.request.id}>${p.response === 'accept' ? 'Answered' : 'Skipped'}: ${mdPlain(p.request.message || p.request.questions?.[0]?.message, 80)}</div>`;
      case 'error':
        return html`<div class="errpart" key=${`e${i}`}>
          <b>Error:</b> ${p.error?.message || 'Something went wrong'}
          ${p.resumable && !active && html`<div style="margin-top:8px"><button class="btn sm" onClick=${() => ctx.store.resumeTurn(ctx.chat, turnId)}>Retry</button></div>`}
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

function UserMessage({ message, pending }) {
  const atts = (message.attachments || []).filter((a) => a.type !== 'simple' || !/browser pages|workspace/i.test(a.label || ''));
  return html`<div class="msg-user">
    <div>
      <div class=${`bubble ${pending ? 'pending' : ''}`}>${message.text}</div>
      ${atts.length > 0 && html`<div class="att">${atts.map((a, i) => html`<span key=${i}>📎 ${a.label}</span>`)}</div>`}
    </div>
  </div>`;
}

export class Turn extends Component {
  shouldComponentUpdate(next) {
    return next.turn !== this.props.turn || next.active !== this.props.active || next.activity !== this.props.activity;
  }
  render({ turn, active, activity, ctx }) {
    const parts = turn.responseParts || [];
    const last = parts[parts.length - 1];
    const waiting = active && (!last || (last.kind !== 'markdown' && !(last.kind === 'toolCall' && ['running', 'streaming'].includes(last.toolCall.status)) && last.kind !== 'reasoning'));
    return html`<div class="turn">
      <${UserMessage} message=${turn.message} />
      <${Parts} parts=${parts} turnId=${turn.id} active=${active} ctx=${ctx} />
      ${active && waiting && html`<div class="activity-line"><span class="typing"><i></i><i></i><i></i></span>${activity || ''}</div>`}
      ${!active && html`<div class="turn-foot">
        ${turn.state === 'cancelled' && html`<span>⏹ Stopped</span>`}
        ${turn.state === 'error' && html`<span>⚠ Error</span>`}
        ${turn.duration ? html`<span>${duration(turn.duration)}</span>` : null}
        ${turn.message?.model?.id && html`<span>${turn.message.model.id}</span>`}
      </div>`}
    </div>`;
  }
}

export function PendingTurn({ message }) {
  return html`<div class="turn"><${UserMessage} message=${message} pending=${true} /><div class="activity-line"><span class="typing"><i></i><i></i><i></i></span>Sending…</div></div>`;
}
