import { html, useEffect, useState, useRef } from '../lib/ui.js';

// Icons from, or based on, Feather (MIT, Cole Bemis) and Lucide (ISC, Lucide Contributors).
// License texts: THIRD-PARTY-NOTICES.md, which ships with the site, the extension and the plugin.
const P = {
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  'circle-check': 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14.01l-3-3',
  'circle-x': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
  'alert-circle': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v4M12 16h.01',
  rocket: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  checklist: 'M10 6h10M10 12h10M10 18h10M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17',
  'shield-check': 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  'shield-off': 'M19.7 14a6.9 6.9 0 0 0 .3-2V5l-8-3-3.2 1.2M4.7 4.7L4 5v7c0 6 8 10 8 10a20.3 20.3 0 0 0 5.62-4.38M1 1l22 22',
  monitor: 'M20 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8 21h8M12 17v4',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z',
  stop: 'M7 7h10v10H7z',
  clip: 'M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  create: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 18v-6M9 15h6',
  db: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  sparkle: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2zM19 3v4M21 5h-4',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  alert: 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  right: 'M9 18l6-6-6-6',
  down: 'M6 9l6 6 6-6',
  up: 'M18 15l-6-6-6 6',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9z',
  brain: 'M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2zM14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2z',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zM15.5 7.5l3 3L22 7l-3-3',
  image: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  cpu: 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 9h6v6H9z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  wand: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  share: 'M8 9H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2M12 2v13M8 6l4-4 4 4',
  'plus-square': 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 8v8M8 12h8',
  maximize: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
};

export function Icon({ name, size = 20, cls }) {
  const d = P[name] || P.info;
  return html`<svg class=${cls} viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${d} /></svg>`;
}

export function toolIcon(tc) {
  const kind = tc?._meta?.toolKind || '';
  const n = `${kind} ${tc?.toolName || ''}`.toLowerCase();
  if (/terminal|shell|bash|powershell|command/.test(n)) return 'terminal';
  if (/edit|replace|patch/.test(n)) return 'edit';
  if (/create|write/.test(n)) return 'create';
  if (/read|view|open/.test(n)) return 'file';
  if (/search|grep|glob|find/.test(n)) return 'search';
  if (/sql|db|query/.test(n)) return 'db';
  if (/web|fetch|http|browser/.test(n)) return 'globe';
  if (/skill|agent|task/.test(n)) return 'sparkle';
  return 'bolt';
}

// ---------------------------------------------------------------- toasts

const toastListeners = new Set();
let toastSeq = 0;
export function toast(message, tone = '') {
  const t = { id: ++toastSeq, message, tone };
  for (const l of toastListeners) l(t);
}

export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const add = (t) => {
      setItems((xs) => [...xs.slice(-2), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.tone === 'err' ? 6000 : 3200);
    };
    toastListeners.add(add);
    return () => toastListeners.delete(add);
  }, []);
  return html`<div class="toasts" role="status" aria-live="polite">${items.map((t) => html`<div class=${`toast ${t.tone}`} key=${t.id}>${t.message}</div>`)}</div>`;
}

// ---------------------------------------------------------------- sheet

// Open sheets, newest last: Escape closes only the top one (a model picker over the new-session sheet).
const openSheets = [];
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openSheets.length) openSheets[openSheets.length - 1].current();
  });
}

/** Whether a downward swipe of `dy` pixels in `ms` milliseconds closes a sheet `height` pixels tall. */
export function swipeCloses(dy, ms, height) {
  return dy > Math.min(140, height * 0.3) || (dy > 40 && dy / Math.max(ms, 1) > 0.5);
}

/**
 * Puts an open layer (a sheet, a full-screen editor) on the Escape stack, so Escape closes only the
 * newest one. Returns a ref that always holds the latest `onClose`.
 */
export function useEscape(open, onClose) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    openSheets.push(close);
    return () => {
      const i = openSheets.indexOf(close);
      if (i >= 0) openSheets.splice(i, 1);
    };
  }, [open]);
  return close;
}

/**
 * A bottom sheet (a centred dialog on wide screens). It always says how to leave it: the Done button in
 * its header (`doneLabel`, e.g. Cancel where closing backs out), a swipe down, a tap outside, or Escape.
 * `full` makes it fill the screen, for writing a long text in it.
 */
export function Sheet({ open, onClose, title, children, wide = false, full = false, doneLabel = 'Done' }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const close = useEscape(open, onClose);
  if (!open) return null;
  const el = () => ref.current;
  // Swipe down to close: from the handle or the header at any time, or from the content once it's
  // scrolled to the top (an upward swipe, or any swipe further down the content, just scrolls). Not
  // full screen: there Done (or the button by the text) goes back, and the text needs its swipes.
  const start = (e) => {
    if (full || e.touches.length !== 1 || !matchMedia('(max-width: 899px)').matches) return;
    const fromHead = !!e.target.closest('.sheet-top');
    if (!fromHead && (el().scrollTop > 0 || e.target.closest('input, textarea, select, pre'))) return;
    const t = e.touches[0];
    drag.current = { x0: t.clientX, y0: t.clientY, dy: 0, t0: Date.now(), active: fromHead };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const t = e.touches[0];
    const dx = t.clientX - d.x0;
    const dy = t.clientY - d.y0;
    if (!d.active) {
      if (dy > 8 && dy > Math.abs(dx) && el().scrollTop <= 0) d.active = true;
      else if (dy < -4 || Math.abs(dx) > 8) {
        drag.current = null;
        return;
      } else return;
    }
    d.dy = Math.max(0, dy);
    el().style.transition = 'none';
    el().style.transform = `translateY(${d.dy}px)`;
    if (e.cancelable) e.preventDefault();
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    const sheet = el();
    sheet.style.transition = 'transform 0.18s ease';
    if (swipeCloses(d.dy, Date.now() - d.t0, sheet.offsetHeight)) {
      sheet.style.transform = 'translateY(100%)';
      if (sheet.previousElementSibling) sheet.previousElementSibling.style.opacity = '0';
      setTimeout(() => close.current(), 170);
    } else {
      sheet.style.transform = '';
    }
  };
  return html`<div>
    <div class="scrim" onClick=${onClose}></div>
    <div ref=${ref} class=${`sheet ${wide ? 'wide' : ''} ${full ? 'full' : ''}`} role="dialog" aria-modal="true" aria-label=${title}
      ontouchstart=${start} ontouchmove=${move} ontouchend=${end} ontouchcancel=${end}>
      <div class="sheet-top">
        <div class="grab" aria-hidden="true"></div>
        <div class="sheet-head">
          <h3>${title || ''}</h3>
          <button type="button" class="sheet-done" onClick=${onClose}>${doneLabel}</button>
        </div>
      </div>
      ${children}
    </div>
  </div>`;
}

export function StatusPill({ status }) {
  return html`<span class=${`st-${status.key}`}><span class="st-dot"></span> ${status.label}</span>`;
}

export function Spinner({ lg }) {
  return html`<span class=${`spinner ${lg ? 'lg' : ''}`} role="progressbar" aria-label="Loading"></span>`;
}

export function Switch({ on, onChange, label }) {
  return html`<button class=${`switch ${on ? 'on' : ''}`} role="switch" aria-checked=${on ? 'true' : 'false'} aria-label=${label} onClick=${() => onChange(!on)}></button>`;
}
