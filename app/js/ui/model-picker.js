// Model picker, like VS Code's: one chip picks the model (a tap selects it), a second chip holds that
// model's own options — thinking level, context size, … — straight from the host's configSchema.
import { html, useEffect, useRef } from '../lib/ui.js';
import { Sheet, Icon } from './common.js';

// VS Code 1.144 lists two options twice, under a second name for other clients: `reasoningEffort`
// copies `thinkingLevel` and `autoTier` copies `tier` (same title and choices, no default). It sends
// apps that aren't VS Code (like this one) the choice under the second name only, and reads the first
// name, then the second. The phone shows each option once, reads it the same way, and sets both names.
const KNOWN_COPIES = { reasoningEffort: 'thinkingLevel', autoTier: 'tier' };
const sameChoices = (a, b) => JSON.stringify(a.enum) === JSON.stringify(b.enum);

/** The options that copy another one: { copy: original }. */
function copiesOf(props) {
  const out = {};
  const shown = [];
  for (const [k, p] of Object.entries(props)) {
    if (!Array.isArray(p?.enum) || !p.enum.length) continue;
    const known = KNOWN_COPIES[k];
    let of = known && Array.isArray(props[known]?.enum) && sameChoices(props[known], p) ? known : null;
    if (!of && p.default === undefined) of = shown.find((s) => props[s].title === p.title && sameChoices(props[s], p)) || null;
    if (of) out[k] = of;
    else shown.push(k);
  }
  return out;
}

/** A model's options, each once: [key, schema, keys of its copies]. */
function modelOptions(model) {
  const props = model?.configSchema?.properties || {};
  const copies = copiesOf(props);
  return Object.entries(props)
    .filter(([k, p]) => Array.isArray(p?.enum) && p.enum.length > 0 && !copies[k])
    .map(([k, p]) => [k, p, Object.keys(copies).filter((c) => copies[c] === k)]);
}

const optLabel = (p, v) => p.enumLabels?.[p.enum.indexOf(v)] ?? String(v);

/** The value chosen for an option in `config` (under its own name, else a copy's), if any. */
function chosen([k, p, copies], config) {
  for (const key of [k, ...copies]) {
    const v = config?.[key];
    if (v !== undefined && p.enum.includes(v)) return v;
  }
  return undefined;
}

/** `config` with an option set to `v`, under its own name and its copies'. */
function withOption([k, , copies], config, v) {
  const next = { ...(config || {}) };
  for (const key of [k, ...copies]) next[key] = v;
  return next;
}

/** Config for `model`, keeping previous values where the new model supports them. */
export function modelDefaults(model, prevConfig = {}) {
  let config = {};
  for (const opt of modelOptions(model)) {
    const p = opt[1];
    const prev = chosen(opt, prevConfig);
    config = withOption(opt, config, prev !== undefined ? prev : p.default !== undefined ? p.default : p.enum[0]);
  }
  return config;
}

/** The value each option has for `sel` (its own choice, else the model's default). */
function optionValue(opt, sel) {
  const v = chosen(opt, sel?.config);
  return v !== undefined ? v : opt[1].default;
}

export function modelSummary(models, sel) {
  if (!sel) return 'Default model';
  const m = models.find((x) => x.id === sel.id);
  const bits = [m?.name || sel.id];
  for (const opt of modelOptions(m)) {
    const v = chosen(opt, sel.config);
    if (v !== undefined) bits.push(optLabel(opt[1], v));
  }
  return bits.join(' · ');
}

/** The model chip's text: the model name. */
export function modelChip(models, sel) {
  if (!sel) return { name: 'Default model', tag: '' };
  const m = models.find((x) => x.id === sel.id);
  return { name: m?.name || sel.id, tag: optionsChip(models, sel) };
}

/** The options chip's text, e.g. "Max 1M" (thinking level + context size); '' if the model has none. */
export function optionsChip(models, sel) {
  const m = models.find((x) => x.id === sel?.id);
  return modelOptions(m).map((opt) => {
    const v = optionValue(opt, sel);
    return v === undefined ? null : optLabel(opt[1], v);
  }).filter(Boolean).join(' ');
}

export function hasOptions(models, sel) {
  return modelOptions(models.find((x) => x.id === sel?.id)).length > 0;
}

/** `sel` with option `key` of its model set to `value` (under every name VS Code knows it by). */
export function chooseOption(models, sel, key, value) {
  const opt = modelOptions(models.find((x) => x.id === sel?.id)).find(([k]) => k === key);
  return opt ? { ...sel, config: withOption(opt, sel?.config, value) } : sel;
}

function describe(m) {
  const bits = [];
  if (m.maxContextWindow) bits.push(m.maxContextWindow >= 1e6 ? `${Math.round(m.maxContextWindow / 1e5) / 10}M context` : `${Math.round(m.maxContextWindow / 1000)}K context`);
  if (m.supportsVision) bits.push('vision');
  return bits.length ? bits.join(' · ') : m.description || '';
}

/** Pick a model: a tap selects it (keeping options it supports) and closes the list. */
export function ModelSheet({ open, onClose, models, value, onChange }) {
  const listRef = useRef(null);
  const available = models.filter((m) => m.policyState !== 'disabled');
  useEffect(() => {
    if (open) requestAnimationFrame(() => listRef.current?.querySelector('.list-item.on')?.scrollIntoView({ block: 'center' }));
  }, [open]);
  return html`<${Sheet} open=${open} onClose=${onClose} title="Model">
    <div ref=${listRef}>
      ${available.map((m) => html`<button key=${m.id} class=${`list-item ${m.id === value?.id ? 'on' : ''}`} onClick=${() => { onChange({ id: m.id, config: modelDefaults(m, value?.config) }); onClose(); }}>
        <div class="grow"><div>${m.name || m.id}</div><div class="muted small">${describe(m)}</div></div>
        ${m.id === value?.id && html`<span class="check"><${Icon} name="check" /></span>`}
      </button>`)}
    </div>
  </${Sheet}>`;
}

/** The current model's options (VS Code's "Max 1M" menu): each tap applies at once. */
export function ModelOptionsSheet({ open, onClose, models, value, onChange, midSession }) {
  const m = models.find((x) => x.id === value?.id);
  const options = modelOptions(m);
  return html`<${Sheet} open=${open} onClose=${onClose} title=${m?.name || 'Model options'}>
    ${midSession && html`<div class="opt-note"><${Icon} name="info" /><span>Changing these options mid-session resets the prompt cache and may increase cost.</span></div>`}
    ${options.map((opt) => {
      const [k, p] = opt;
      const current = optionValue(opt, value);
      return html`<div class="opt-group" key=${k}>
      <div class="section-title">${p.title || k}</div>
      ${p.enum.map((v, i) => {
        const on = current === v;
        return html`<button key=${String(v)} class=${`list-item ${on ? 'on' : ''}`} onClick=${() => onChange(chooseOption(models, value, k, v))} title=${p.enumDescriptions?.[i] || ''}>
          <div class="grow"><span>${optLabel(p, v)}</span>${p.default === v && html`<span class="muted small def-tag">Default</span>`}${p.enumDescriptions?.[i] && html`<div class="muted small">${p.enumDescriptions[i]}</div>`}</div>
          ${on && html`<span class="check"><${Icon} name="check" /></span>`}
        </button>`;
      })}
    </div>`;
    })}
  </${Sheet}>`;
}
