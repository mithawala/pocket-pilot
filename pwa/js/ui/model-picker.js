// Model picker: model + its own options (thinking level, context size, …) straight from the
// agent host's model configSchema, so the phone offers exactly what VS Code offers.
import { html, useState, useEffect } from '../lib/ui.js';
import { Sheet, Icon } from './common.js';

function enumProps(model) {
  return Object.entries(model?.configSchema?.properties || {}).filter(([, p]) => Array.isArray(p.enum) && p.enum.length > 0);
}

/** Config for `model`, keeping previous values where the new model supports them. */
export function modelDefaults(model, prevConfig = {}) {
  const config = {};
  for (const [k, p] of enumProps(model)) {
    const prev = prevConfig?.[k];
    config[k] = p.enum.includes(prev) ? prev : p.default !== undefined ? p.default : p.enum[0];
  }
  return config;
}

export function modelSummary(models, sel) {
  if (!sel) return 'Default model';
  const m = models.find((x) => x.id === sel.id);
  const bits = [m?.name || sel.id];
  for (const [k, p] of enumProps(m)) {
    const v = sel.config?.[k];
    if (v === undefined) continue;
    const i = p.enum.indexOf(v);
    bits.push(p.enumLabels?.[i] ?? String(v));
  }
  return bits.join(' · ');
}

function describe(m) {
  const bits = [];
  if (m.maxContextWindow) bits.push(m.maxContextWindow >= 1e6 ? `${Math.round(m.maxContextWindow / 1e5) / 10}M context` : `${Math.round(m.maxContextWindow / 1000)}K context`);
  if (m.supportsVision) bits.push('vision');
  return bits.join(' · ');
}

export function ModelSheet({ open, onClose, models, value, onChange }) {
  const [sel, setSel] = useState(value || null);
  useEffect(() => {
    if (open) setSel(value || null);
  }, [open]);
  const available = models.filter((m) => m.policyState !== 'disabled');
  const current = available.find((m) => m.id === sel?.id);
  const pick = (m) => setSel({ id: m.id, config: modelDefaults(m, sel?.config) });
  const setOpt = (k, v) => setSel({ ...sel, config: { ...(sel?.config || {}), [k]: v } });
  return html`<${Sheet} open=${open} onClose=${onClose} title="Model">
    ${current && enumProps(current).map(([k, p]) => html`<div class="field model-opt" key=${k}>
      <label>${p.title || k}</label>
      <div class="seg wrap" role="radiogroup" aria-label=${p.title || k}>
        ${p.enum.map((v, i) => html`<button class=${sel?.config?.[k] === v ? 'on' : ''} title=${p.enumDescriptions?.[i] || ''} onClick=${() => setOpt(k, v)}>${p.enumLabels?.[i] ?? String(v)}</button>`)}
      </div>
    </div>`)}
    ${current && html`<button class="btn primary block model-use" onClick=${() => { onChange(sel); onClose(); }}>Use ${modelSummary(available, sel)}</button>`}
    <div class="section-title">${current ? 'Other models' : 'Choose a model'}</div>
    ${available.map((m) => html`<button key=${m.id} class=${`list-item ${m.id === sel?.id ? 'on' : ''}`} onClick=${() => pick(m)}>
      <div class="grow"><div>${m.name || m.id}</div><div class="muted small">${describe(m)}</div></div>
      ${m.id === sel?.id && html`<span class="check"><${Icon} name="check" /></span>`}
    </button>`)}
  </${Sheet}>`;
}
