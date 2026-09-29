// Keeps the app exactly as tall as the visible screen. On iOS the on-screen keyboard doesn't resize
// the page: it shrinks a "visual viewport" and pans it, so the app follows that viewport to keep the
// composer right above the keyboard. iOS doesn't always report the keyboard closing, though, which
// used to leave the app short with an empty band at the bottom until a reload. So the app only
// follows the visual viewport while something is being edited, and measures again whenever focus,
// visibility or the page itself changes.
//
// Home Screen apps have a worse variant: once the keyboard has been open, WebKit can keep the whole
// viewport (innerHeight, 100dvh) short by about the status bar's height until the app is closed, a
// dark band under every screen. Hiding and showing a full-height element makes WebKit measure the
// viewport again, so the app does that when it finds itself shorter than the screen.

const NO_KEYBOARD = /^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i;

/** Whether the focused element brings up the on-screen keyboard. */
export function isEditing(doc) {
  const el = doc?.activeElement;
  if (!el || el.disabled || el.readOnly) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !NO_KEYBOARD.test(el.type || 'text');
}

/**
 * The app's height and offset for the current viewport, or null to leave it alone (pinch-zoomed).
 * @param {{innerHeight: number, vv?: {height: number, offsetTop: number, scale: number}|null, editing: boolean}} o
 */
export function fitViewport({ innerHeight, vv, editing }) {
  if (!vv) return { height: Math.round(innerHeight), top: 0, keyboard: false };
  if (Math.abs((vv.scale || 1) - 1) > 0.01) return null;
  if (editing && vv.height < innerHeight - 1) return { height: Math.round(vv.height), top: Math.round(Math.max(0, vv.offsetTop || 0)), keyboard: true };
  return { height: Math.round(innerHeight), top: 0, keyboard: false };
}

/**
 * How tall an iPhone or iPad Home Screen app is when it fills the screen (portrait or landscape), or 0
 * where that doesn't apply: in a browser tab, in Split View or Stage Manager, on other systems.
 * @param {{standalone: boolean, innerWidth: number, innerHeight: number, screen?: {width: number, height: number}}} o
 */
export function fullScreenHeight({ standalone, innerWidth, innerHeight, screen }) {
  if (!standalone || !screen?.width || !screen?.height) return 0;
  const portrait = innerHeight >= innerWidth;
  const short = Math.min(screen.width, screen.height);
  const long = Math.max(screen.width, screen.height);
  if (Math.abs(innerWidth - (portrait ? short : long)) > 1) return 0;
  return portrait ? long : short;
}

/** Whether WebKit has left the viewport short of the screen (see the top of this file). */
export function viewportStuck({ full, innerHeight, editing }) {
  return !editing && full > 0 && innerHeight < full - 4 && full - innerHeight <= 160;
}

/** Sets --app-h / --vv-top on the root element and keeps them current. Returns the update function. */
export function trackViewport(win = window) {
  const doc = win.document;
  const style = doc.documentElement.style;
  const vv = win.visualViewport || null;
  const standalone = win.navigator?.standalone === true;
  let frame = 0;
  let timer = 0;
  let healNext = false;
  let healedAt = 0;
  // Hide and show the app (a full-height element) so WebKit measures the viewport again. The lists keep
  // their scroll positions.
  const heal = () => {
    const shell = doc.querySelector?.('.shell');
    if (!shell) return;
    healedAt = Date.now();
    const kept = [...shell.querySelectorAll('.scroll, .sheet')].map((el) => [el, el.scrollTop]);
    shell.style.display = 'none';
    void shell.offsetHeight;
    shell.style.display = '';
    for (const [el, top] of kept) el.scrollTop = top;
  };
  const apply = () => {
    if (frame) win.cancelAnimationFrame?.(frame);
    clearTimeout(timer);
    frame = 0;
    timer = 0;
    const editing = isEditing(doc);
    if (healNext) {
      healNext = false;
      const full = fullScreenHeight({ standalone, innerWidth: win.innerWidth, innerHeight: win.innerHeight, screen: win.screen });
      if (Date.now() - healedAt > 1500 && viewportStuck({ full, innerHeight: win.innerHeight, editing })) heal();
    }
    const fit = fitViewport({ innerHeight: win.innerHeight, vv, editing });
    if (!fit) return;
    style.setProperty('--app-h', `${fit.height}px`);
    style.setProperty('--vv-top', `${fit.top}px`);
    if (!fit.keyboard && (win.scrollY || win.scrollX)) win.scrollTo(0, 0);
  };
  // One update per frame while the keyboard animates. The timer covers frames that never come, as in
  // a page iOS suspended or restored from the back/forward cache.
  const schedule = () => {
    if (frame || timer) return;
    frame = win.requestAnimationFrame ? win.requestAnimationFrame(apply) : 0;
    timer = setTimeout(apply, 150);
  };
  // Once the keyboard has closed, check that the Home Screen app got its whole screen back.
  const checkStuck = () => {
    if (!standalone) return;
    for (const ms of [200, 900]) {
      setTimeout(() => {
        healNext = true;
        schedule();
      }, ms);
    }
  };
  // The keyboard takes a moment to open or close after focus moves: measure again once it has.
  const settle = () => {
    apply();
    for (const ms of [120, 400, 800]) setTimeout(schedule, ms);
    checkStuck();
  };
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  win.addEventListener('resize', schedule);
  win.addEventListener('orientationchange', settle);
  win.addEventListener('pageshow', settle);
  doc.addEventListener('visibilitychange', () => {
    if (!doc.hidden) settle();
  });
  doc.addEventListener('focusin', settle);
  doc.addEventListener('focusout', settle);
  apply();
  checkStuck();
  return apply;
}
