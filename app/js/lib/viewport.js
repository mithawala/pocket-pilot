// Keeps the app exactly as tall as the visible screen. On iOS the on-screen keyboard doesn't resize
// the page: it shrinks a "visual viewport" and pans it, so the app follows that viewport to keep the
// composer right above the keyboard. iOS doesn't always report the keyboard closing, though, which
// used to leave the app short with an empty band at the bottom until a reload. So the app only
// follows the visual viewport while something is being edited, and measures again whenever focus,
// visibility or the page itself changes.
//
// Home Screen apps meet two WebKit bugs that leave a band at the bottom of the screen:
// - iOS 26.5 and later (and the iOS 27 beta; WebKit bug 301994): iOS makes the web view as tall as the
//   screen minus the status bar. Under a translucent status bar it starts at the top of the screen, and
//   the band below it is drawn by iOS, outside the page. index.html avoids that with an opaque status
//   bar and no viewport-fit=cover; if iOS still leaves the app short of the screen, bottomInset() keeps
//   it from reserving room for a home indicator it doesn't reach (--safe-bottom).
// - iOS 17 and 18: once the keyboard has been open, WebKit can keep the viewport (innerHeight, 100dvh)
//   short by the status bar's height. Hiding and showing an element sized by the viewport makes it
//   measure again, so the app does that when it finds itself shorter than it was.

const NO_KEYBOARD = /^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i;
// Scroll positions that hiding the app would reset.
const SCROLLERS = '.scroll, .sheet, .pending-list, .pending-item .pt';

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

/**
 * The room to keep at the bottom for the home indicator, in px, or null to leave it to CSS
 * (env(safe-area-inset-bottom)). The keyboard covers the home indicator, and a Home Screen app that iOS
 * made shorter than the screen stops above it (by `full - innerHeight`), so neither needs the room.
 * @param {{keyboard: boolean, full: number, innerHeight: number, safeBottom: number}} o
 */
export function bottomInset({ keyboard, full, innerHeight, safeBottom }) {
  if (keyboard) return 0;
  if (!full) return null;
  return Math.max(0, Math.round(safeBottom - Math.max(0, full - innerHeight)));
}

/** Whether WebKit shrank the viewport after the keyboard (iOS 17 and 18, see the top of this file). */
export function viewportStuck({ tallest, innerHeight, editing }) {
  return !editing && tallest > 0 && innerHeight < tallest - 4 && tallest - innerHeight <= 160;
}

/** Sets --app-h, --vv-top and --safe-bottom on the root element and keeps them current. Returns the update function. */
export function trackViewport(win = window) {
  const doc = win.document;
  const style = doc.documentElement.style;
  const vv = win.visualViewport || null;
  const standalone = win.navigator?.standalone === true;
  let frame = 0;
  let timer = 0;
  let healNext = false;
  let healedAt = 0;
  let probe = null;
  // The tallest the app has been, per orientation, while nothing was edited.
  const tallest = { portrait: 0, landscape: 0 };
  const orientation = () => (win.innerHeight >= win.innerWidth ? 'portrait' : 'landscape');
  // env(safe-area-inset-bottom), read through an invisible element.
  const safeBottom = () => {
    if (!doc.body || !doc.createElement) return 0;
    if (!probe) {
      probe = doc.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:env(safe-area-inset-bottom, 0px);visibility:hidden;pointer-events:none';
      doc.body.appendChild(probe);
    }
    return probe.getBoundingClientRect().height || 0;
  };
  // Hide and show the app while it's sized by the viewport (100dvh), so WebKit measures the viewport
  // again. The lists keep their scroll positions.
  const heal = () => {
    const shell = doc.querySelector?.('.shell');
    if (!shell) return;
    healedAt = Date.now();
    const kept = [...shell.querySelectorAll(SCROLLERS)].map((el) => [el, el.scrollTop]);
    style.removeProperty?.('--app-h');
    shell.style.display = 'none';
    void shell.offsetHeight;
    shell.style.display = '';
    void shell.offsetHeight;
    for (const [el, top] of kept) el.scrollTop = top;
  };
  const apply = () => {
    if (frame) win.cancelAnimationFrame?.(frame);
    clearTimeout(timer);
    frame = 0;
    timer = 0;
    const editing = isEditing(doc);
    const o = orientation();
    if (healNext) {
      healNext = false;
      if (standalone && Date.now() - healedAt > 1500 && viewportStuck({ tallest: tallest[o], innerHeight: win.innerHeight, editing })) {
        heal();
        // Once is enough: if WebKit keeps this height, it's the app's height now.
        tallest[o] = win.innerHeight;
      }
    }
    if (!editing) tallest[o] = Math.max(tallest[o], win.innerHeight);
    const fit = fitViewport({ innerHeight: win.innerHeight, vv, editing });
    if (!fit) return;
    style.setProperty('--app-h', `${fit.height}px`);
    style.setProperty('--vv-top', `${fit.top}px`);
    const full = fullScreenHeight({ standalone, innerWidth: win.innerWidth, innerHeight: win.innerHeight, screen: win.screen });
    const inset = bottomInset({ keyboard: fit.keyboard, full, innerHeight: win.innerHeight, safeBottom: full ? safeBottom() : 0 });
    if (inset === null) style.removeProperty?.('--safe-bottom');
    else style.setProperty('--safe-bottom', `${inset}px`);
    if (!fit.keyboard && (win.scrollY || win.scrollX)) win.scrollTo(0, 0);
  };
  // One update per frame while the keyboard animates. The timer covers frames that never come, as in
  // a page iOS suspended or restored from the back/forward cache.
  const schedule = () => {
    if (frame || timer) return;
    frame = win.requestAnimationFrame ? win.requestAnimationFrame(apply) : 0;
    timer = setTimeout(apply, 150);
  };
  // Once the keyboard has closed, check that the Home Screen app got its height back.
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
  return apply;
}
