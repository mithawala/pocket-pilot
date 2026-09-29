// Model picker, like VS Code's: one chip picks the model (a tap selects it), a second chip holds that
// model's own options — thinking level, context size, … — straight from the host's configSchema.
import { html, useEffect, useRef } from '../lib/ui.js';
import { Sheet, Icon } from './common.js';

function enumProps(model) {
  return Object.entries(model?.configSchema?.properties || {}).filter(([, p]) => Array.isArray(p.enum) && p.enum.length > 0);
}

const optLabel = (p, v) => p.enumLabels?.[p.enum.indexOf(v)] ?? String(v);

/** Config for `model`, keeping previous values where the new model supports them. */
export function modelDefaults(model, prevConfig = {}) {
  const config = {};
  for (const [k, p] of enumProps(model)) {
    const prev = prevConfig?.[k];
    config[k] = p.enum.includes(prev) ? prev : p.default !== undefined ? p.default : p.enum[0];
  }
  return config;
}

/** The value each option has for `sel` (its own choice, else the model's default). */
function optionValue(p, k, sel) {
  const v = sel?.config?.[k];
  return v !== undefined && p.enum.includes(v) ? v : p.default !== undefined ? p.default : undefined;
}

export function modelSummary(models, sel) {
  if (!sel) return 'Default model';
  const m = models.find((x) => x.id === sel.id);
  const bits = [m?.name || sel.id];
  for (const [k, p] of enumProps(m)) {
    const v = sel.config?.[k];
    if (v !== undefined) bits.push(optLabel(p, v));
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
  return enumProps(m).map(([k, p]) => {
    const v = optionValue(p, k, sel);
    return v === undefined ? null : optLabel(p, v);
  }).filter(Boolean).join(' ');
}

export function hasOptions(models, sel) {
  return enumProps(models.find((x) => x.id === sel?.id)).length > 0;
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
  const props = enumProps(m);
  const set = (k, v) => onChange({ ...value, config: { ...(value?.config || {}), [k]: v } });
  return html`<${Sheet} open=${open} onClose=${onClose} title=${m?.name || 'Model options'}>
    ${midSession && html`<div class="opt-note"><${Icon} name="info" /><span>Changing these options mid-session resets the prompt cache and may increase cost.</span></div>`}
    ${props.map(([k, p]) => html`<div class="opt-group" key=${k}>
      <div class="section-title">${p.title || k}</div>
      ${p.enum.map((v, i) => {
        const on = optionValue(p, k, value) === v;
        return html`<button key=${String(v)} class=${`list-item ${on ? 'on' : ''}`} onClick=${() => set(k, v)} title=${p.enumDescriptions?.[i] || ''}>
          <div class="grow"><span>${optLabel(p, v)}</span>${p.default === v && html`<span class="muted small def-tag">Default</span>`}${p.enumDescriptions?.[i] && html`<div class="muted small">${p.enumDescriptions[i]}</div>`}</div>
          ${on && html`<span class="check"><${Icon} name="check" /></span>`}
        </button>`;
      })}
    </div>`)}
  </${Sheet}>`;
}
