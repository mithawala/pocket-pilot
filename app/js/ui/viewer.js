// Pictures in chats: thumbnails under a message (or a queued one) and a full-screen viewer with pinch
// and double-tap zoom, swipe to the next picture, and swipe down, the close button or Escape to leave.
import { html, useState, useEffect, useRef } from '../lib/ui.js';
import { Icon, Spinner } from './common.js';
import { loadPicture, pictureError } from '../lib/attachments.js';

const MAX_ZOOM = 5;

// ---------------------------------------------------------------- thumbnails

/**
 * A row of thumbnails; a tap opens the pictures full screen. `read(uri)` reads a picture from the PC.
 * @param {{ images: object[], read: (uri: string) => Promise<object>, size?: 'md'|'sm' }} p
 */
export function Thumbs({ images, read, size = 'md' }) {
  if (!images?.length) return null;
  const items = images.map((att) => ({ att, read }));
  return html`<div class=${`thumbs ${size} ${size === 'md' && images.length === 1 ? 'one' : ''}`}>
    ${images.map((att, i) => html`<${Thumb} key=${att.uri || `${i}:${att.label}`} att=${att} read=${read} onOpen=${() => openPictures(items, i)} />`)}
  </div>`;
}

function Thumb({ att, read, onOpen }) {
  const ref = useRef(null);
  const [state, setState] = useState({});
  useEffect(() => {
    let stop = false;
    const load = () => loadPicture(att, read).then((r) => !stop && setState({ url: r.url }), (err) => !stop && setState({ error: pictureError(err) }));
    const el = ref.current;
    // Load a picture when it comes near the screen: a long chat can hold many.
    if (typeof IntersectionObserver !== 'function' || !el) {
      load();
      return () => { stop = true; };
    }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      load();
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => {
      stop = true;
      io.disconnect();
    };
  }, [att.uri, att.data]);
  const label = att.label || 'Picture';
  return html`<button type="button" ref=${ref} class=${`thumb ${state.url ? 'ready' : state.error ? 'failed' : 'loading'}`} onClick=${onOpen} aria-label=${`View ${label}`} title=${state.error || label}>
    ${state.url ? html`<img src=${state.url} alt="" draggable="false" />` : html`<${Icon} name="image" />`}
    ${!state.url && html`<span class="thumb-label">${label}</span>`}
  </button>`;
}

// ---------------------------------------------------------------- viewer

const viewers = new Set();

/** Shows pictures full screen, starting at `index`. Items are `{ att, read }`. */
export function openPictures(items, index = 0) {
  for (const show of viewers) show({ items, index });
}

/** Mounted once at the root of the app: the full-screen viewer, when open. */
export function PictureViewer() {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    const show = (o) => setOpen({ ...o, key: Date.now() });
    viewers.add(show);
    return () => viewers.delete(show);
  }, []);
  if (!open?.items?.length) return null;
  return html`<${Viewer} key=${open.key} items=${open.items} start=${open.index} onClose=${() => setOpen(null)} />`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function Viewer({ items, start, onClose }) {
  const [index, setIndex] = useState(clamp(start || 0, 0, items.length - 1));
  const [pic, setPic] = useState({ loading: true });
  const stageRef = useRef(null);
  const imgRef = useRef(null);
  const closeRef = useRef(null);
  const view = useRef({ s: 1, x: 0, y: 0 });
  const g = useRef({ pointers: new Map(), lastTap: null });
  const many = items.length > 1;
  const item = items[index];
  const go = (d) => {
    if (many) setIndex((i) => (i + d + items.length) % items.length);
  };

  // The transform is applied directly: gestures shouldn't re-render the component.
  const paint = (animate = false) => {
    const img = imgRef.current;
    if (!img) return;
    const { s, x, y } = view.current;
    img.style.transition = animate ? 'transform 0.2s ease' : 'none';
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  };
  // Keeps a zoomed picture covering the screen instead of drifting off it.
  const bounded = ({ s, x, y }) => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return { s, x, y };
    const w = img.offsetWidth * s;
    const h = img.offsetHeight * s;
    const mx = Math.max(0, (w - stage.clientWidth) / 2);
    const my = Math.max(0, (h - stage.clientHeight) / 2);
    return { s, x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
  };
  const reset = (animate) => {
    view.current = { s: 1, x: 0, y: 0 };
    paint(animate);
  };
  // Zoom to `s`, keeping the picture point under `at` (client coordinates) where it is.
  const zoomAt = (s, at, from = view.current) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const c = { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 };
    const k = s / from.s;
    view.current = bounded({ s, x: at.x - c.x - k * (at.x - c.x - from.x), y: at.y - c.y - k * (at.y - c.y - from.y) });
  };

  useEffect(() => {
    let stop = false;
    setPic({ loading: true });
    view.current = { s: 1, x: 0, y: 0 };
    loadPicture(item.att, item.read).then((r) => !stop && setPic({ url: r.url }), (err) => !stop && setPic({ error: pictureError(err) }));
    return () => { stop = true; };
  }, [index]);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === 'ArrowRight') {
        go(1);
      } else if (e.key === 'ArrowLeft') {
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const down = (e) => {
    const st = g.current;
    try {
      stageRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* not an active pointer (synthetic events) */
    }
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...st.pointers.values()];
    if (pts.length === 2) {
      st.pinch = { d0: Math.max(1, dist(pts[0], pts[1])), m0: mid(pts[0], pts[1]), from: { ...view.current } };
      st.drag = null;
    } else if (pts.length === 1) {
      st.pinch = null;
      st.drag = { x0: e.clientX, y0: e.clientY, t0: Date.now(), from: { ...view.current }, moved: false };
    }
  };
  const move = (e) => {
    const st = g.current;
    if (!st.pointers.has(e.pointerId)) return;
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...st.pointers.values()];
    if (st.pinch && pts.length >= 2) {
      const { d0, m0, from } = st.pinch;
      const s = clamp(from.s * (dist(pts[0], pts[1]) / d0), 1, MAX_ZOOM);
      const m = mid(pts[0], pts[1]);
      // Scale around where the pinch started, and follow the fingers as they move together.
      zoomAt(s, m0, from);
      view.current = bounded({ ...view.current, x: view.current.x + (m.x - m0.x), y: view.current.y + (m.y - m0.y) });
      paint();
      return;
    }
    const d = st.drag;
    if (!d) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) d.moved = true;
    if (d.from.s > 1) {
      view.current = bounded({ s: d.from.s, x: d.from.x + dx, y: d.from.y + dy });
    } else {
      // Not zoomed: the picture follows the finger, to the side (next picture) or down (close).
      const sideways = Math.abs(dx) > Math.abs(dy);
      view.current = { s: 1, x: sideways && many ? dx : 0, y: sideways ? 0 : Math.max(0, dy) };
      const stage = stageRef.current;
      if (stage) stage.style.backgroundColor = `rgba(0, 0, 0, ${sideways ? 1 : clamp(1 - Math.max(0, dy) / 500, 0.35, 1)})`;
    }
    paint();
  };
  const up = (e) => {
    const st = g.current;
    st.pointers.delete(e.pointerId);
    const stage = stageRef.current;
    if (st.pinch) {
      if (st.pointers.size < 2) {
        st.pinch = null;
        if (view.current.s < 1.05) reset(true);
        // A finger still down carries on as a drag.
        const rest = [...st.pointers.values()][0];
        st.drag = rest ? { x0: rest.x, y0: rest.y, t0: Date.now(), from: { ...view.current }, moved: true } : null;
      }
      return;
    }
    const d = st.drag;
    st.drag = null;
    if (!d) return;
    if (stage) stage.style.backgroundColor = '';
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    const ms = Date.now() - d.t0;
    if (!d.moved && ms < 300) {
      // Double tap: zoom in where you tapped, or back out.
      const now = Date.now();
      const last = st.lastTap;
      if (last && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
        st.lastTap = null;
        if (view.current.s > 1) reset(true);
        else {
          zoomAt(2.5, { x: e.clientX, y: e.clientY });
          paint(true);
        }
        return;
      }
      st.lastTap = { t: now, x: e.clientX, y: e.clientY };
      return;
    }
    if (d.from.s > 1) return;
    if (many && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      go(dx < 0 ? 1 : -1);
      return;
    }
    if (dy > 110 || (dy > 40 && dy / Math.max(ms, 1) > 0.6)) {
      onClose();
      return;
    }
    reset(true);
  };
  const wheel = (e) => {
    e.preventDefault();
    const s = clamp(view.current.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), 1, MAX_ZOOM);
    zoomAt(s, { x: e.clientX, y: e.clientY });
    paint();
  };

  const label = item.att.label || 'Picture';
  return html`<div class="viewer" role="dialog" aria-modal="true" aria-label=${label}>
    <div class="viewer-bar">
      <span class="viewer-title">${label}${many ? html` <span class="viewer-count">${index + 1} / ${items.length}</span>` : ''}</span>
      <button type="button" ref=${closeRef} class="viewer-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
    </div>
    <div class="viewer-stage" ref=${stageRef} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onWheel=${wheel}>
      ${pic.url && html`<img ref=${imgRef} src=${pic.url} alt=${label} draggable="false" />`}
      ${pic.loading && html`<${Spinner} lg />`}
      ${pic.error && html`<div class="viewer-error"><${Icon} name="image" size="28" /><p>${pic.error}</p></div>`}
    </div>
    ${many && html`<button type="button" class="viewer-btn viewer-prev" onClick=${() => go(-1)} aria-label="Previous picture"><${Icon} name="back" /></button>
      <button type="button" class="viewer-btn viewer-next" onClick=${() => go(1)} aria-label="Next picture"><${Icon} name="right" /></button>`}
  </div>`;
}
