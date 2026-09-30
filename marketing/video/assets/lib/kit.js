// Pocket Pilot marketing videos: shared building blocks. Plain DOM only — every animation lives on
// the composition's one paused GSAP timeline, so any frame can be rendered from its time alone.
window.PP = (() => {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ROBOT = '<path d="M15.2 6.3l1.6-2.6"/><circle cx="17.3" cy="3.1" r="1.05" fill="currentColor" stroke="none"/><path d="M6.4 13.1v-1C6.4 8.3 8.9 5.6 12 5.6s5.6 2.7 5.6 6.5v1"/><rect x="8.5" y="8.8" width="7" height="3.3" rx="1.65"/><path d="M3.6 15q8.4-1.9 16.8 0l-.9 5a1.3 1.3 0 0 1-1.3 1.1H5.8a1.3 1.3 0 0 1-1.3-1.1z"/>';
  const ICONS = {
    robot: ROBOT,
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/>',
    face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5V13h-1"/><path d="M9 16c1.7 1.3 4.3 1.3 6 0"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    bolt: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    question: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    laptop: '<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v9h14v-9M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    cloudoff: '<path d="M2 2l20 20M17.5 17.5H7a5 5 0 0 1-1.4-9.8M10 5.3A6 6 0 0 1 18 9h.5a4 4 0 0 1 2.7 7"/>',
    terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    github: '<path fill="currentColor" stroke="none" d="M12 1.5a10.5 10.5 0 0 0-3.3 20.5c.5.1.7-.2.7-.5v-1.9c-2.9.6-3.5-1.3-3.5-1.3-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.1 3.1.9.1-.7.4-1.1.6-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.4.1-2.8 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.2 0c2-1.4 2.9-1.1 2.9-1.1.6 1.5.2 2.5.1 2.8.7.8 1.1 1.7 1.1 2.8 0 4-2.5 4.9-4.8 5.2.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5z"/>',
  };
  const icon = (name, extra = '') => svg(ICONS[name] || '', extra);

  /**
   * A captured app screen (assets/ui/fragments.js) inside the scoped `.pp-app` container. Captured and
   * rebuilt interfaces are marked data-layout-ignore: their layering (sheets, sticky bars) and their
   * colors are the real app's, so HyperFrames' layout and contrast audits skip them.
   */
  function app(screen, cls = '') {
    return `<div class="pp-app ${cls}" data-screen="${esc(screen)}" data-layout-ignore>${window.PP_UI[screen]}</div>`;
  }

  /** Scrolls every captured chat to its end, like the app pins it (scroll positions aren't in the markup). */
  function settle(root = document) {
    for (const el of root.querySelectorAll('.pp-app .scroll')) el.scrollTop = el.scrollHeight;
  }

  const STATUS = `<div class="dev-status"><span>9:41</span><span class="icons">
    <svg width="19" height="12" viewBox="0 0 19 12"><rect x="0" y="8" width="3.2" height="4" rx="1" fill="#fff"/><rect x="5" y="5.5" width="3.2" height="6.5" rx="1" fill="#fff"/><rect x="10" y="3" width="3.2" height="9" rx="1" fill="#fff"/><rect x="15" y="0" width="3.2" height="12" rx="1" fill="#fff"/></svg>
    <svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 2.6c2.3 0 4.4.9 6 2.4l1.2-1.2A10.2 10.2 0 0 0 8.5 1 10.2 10.2 0 0 0 1.3 3.8L2.5 5c1.6-1.5 3.7-2.4 6-2.4zm0 3.4c1.4 0 2.6.5 3.6 1.4l1.2-1.2A6.9 6.9 0 0 0 8.5 4.3 6.9 6.9 0 0 0 3.7 6.2l1.2 1.2c1-.9 2.2-1.4 3.6-1.4zm0 3.4c.5 0 1 .2 1.3.5L8.5 11.2 7.2 9.9c.3-.3.8-.5 1.3-.5z" fill="#fff"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="#fff" stroke-opacity=".4"/><rect x="2" y="2" width="18" height="9" rx="2" fill="#fff"/><path d="M25 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="#fff" fill-opacity=".45"/></svg>
  </span></div>`;

  /** An iPhone around `content` (HTML) — by default one captured screen. */
  function phone({ id, screen, content, cls = '' }) {
    return `<div class="iphone ${cls}" id="${id}" data-layout-ignore>
      <i class="dev-side action"></i><i class="dev-side vol-up"></i><i class="dev-side vol-down"></i><i class="dev-side power"></i>
      <div class="dev-frame"><div class="dev-bezel"></div>
        <div class="dev-screen" id="${id}-screen">
          ${content ?? app(screen)}
          ${STATUS}
          <div class="dev-island"></div><div class="dev-home"></div><div class="dev-glare"></div>
        </div>
      </div>
    </div>`;
  }

  function notif({ id, title, body, time = 'now' }) {
    return `<div class="notif" id="${id}" data-layout-ignore><img src="assets/img/icon.svg" alt="">
      <div class="txt"><div class="top"><span>POCKET PILOT</span><span>${esc(time)}</span></div>
      <div class="title">${esc(title)}</div><div class="body">${esc(body)}</div></div></div>`;
  }

  function lock({ id, children = '' }) {
    return `<div class="lock" id="${id}"><div class="date">Tuesday, September 30</div><div class="clock">9:41</div>${children}</div>`;
  }

  const CODE = [
    ['<span class="k">import</span> { sign, verify } <span class="k">from</span> <span class="s">\'./jwt\'</span>;'],
    [''],
    ['<span class="k">export class</span> <span class="t">TokenService</span> {'],
    ['  <span class="k">constructor</span>(<span class="k">private readonly</span> secret: <span class="t">string</span>) {}'],
    [''],
    ['  <span class="c">// One place for every token the auth module issues</span>'],
    ['  <span class="f">issue</span>(userId: <span class="t">string</span>, ttl = <span class="n">3600</span>) {'],
    ['    <span class="k">return</span> <span class="f">sign</span>({ sub: userId }, <span class="k">this</span>.secret, { expiresIn: ttl });'],
    ['  }'],
    [''],
    ['  <span class="f">check</span>(token: <span class="t">string</span>) {'],
    ['    <span class="k">return</span> <span class="f">verify</span>(token, <span class="k">this</span>.secret);'],
    ['  }'],
    ['}'],
  ];

  const EXPLORER = `<div class="f d">⌄ acme-api</div><div class="f d">&nbsp;&nbsp;⌄ src</div><div class="f d">&nbsp;&nbsp;&nbsp;&nbsp;⌄ auth</div>
          <div class="f">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;login.ts <b>M</b></div><div class="f">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;middleware.ts <b>M</b></div>
          <div class="f sel">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;token-service.ts <b>U</b></div><div class="f">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;logout.ts</div>
          <div class="f d">&nbsp;&nbsp;&nbsp;&nbsp;› tests</div><div class="f">&nbsp;&nbsp;package.json</div><div class="f">&nbsp;&nbsp;README.md</div>`;

  /**
   * A VS Code window with the Copilot chat on the right, showing a captured screen's conversation.
   * `code` is a list of highlighted lines (HTML); each line gets the class `cl` and an id `<id>-l<n>`.
   */
  function vscode({ id, chat = 'approval', chatWidth = 440, title = 'token-service.ts — acme-api', tabs = ['middleware.ts', '*token-service.ts', 'login.ts'], code = CODE.map(([l]) => l), explorer = EXPLORER }) {
    const lines = code.map((l, i) => `<div class="cl" id="${id}-l${i + 1}"><span class="ln">${i + 1}</span>${l}</div>`).join('');
    const tabHtml = tabs.map((t) => (t.startsWith('*') ? `<span class="on">${t.slice(1)}</span>` : `<span>${t}</span>`)).join('');
    return `<div class="vsc" id="${id}" data-layout-ignore>
      <div class="titlebar"><span class="dots"><i></i><i></i><i></i></span><span class="name">${title} — Visual Studio Code</span></div>
      <div class="main">
        <div class="activity">
          <div class="ic">${svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>')}</div>
          <div class="ic">${svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>')}</div>
          <div class="ic">${svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 9"/>')}</div>
          <div class="ic">${svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1" transform="rotate(12 17.5 6.5)"/>')}</div>
          <div class="ic on" id="${id}-pp">${svg(ROBOT)}</div>
        </div>
        <div class="explorer"><div class="h">EXPLORER</div>${explorer}</div>
        <div class="editor"><div class="tabs">${tabHtml}</div><div class="code">${lines}</div></div>
        <div class="chatpane" style="width:${chatWidth}px"><div class="ph">${svg(ROBOT, 'width="16" height="16"')}CHAT</div><div class="body" id="${id}-chat">${app(chat, 'vsc-chat')}</div></div>
      </div>
      <div class="statusbar"><span>⎇ main</span><span>⊘ 0 ⚠ 0</span><span style="flex:1"></span><span class="pp">${svg(ROBOT, 'width="14" height="14"')}Pocket Pilot · 1 device</span></div>
    </div>`;
  }

  /**
   * The one paused timeline of a composition. Tweens never render ahead of their start
   * (immediateRender: false), so the state at any time is the CSS start state plus every tween
   * that has begun — whatever order the renderer seeks in. Hence: give each hidden element its
   * start state in CSS (or via words()), and give every tween explicit end values.
   */
  function timeline() {
    return gsap.timeline({ paused: true, defaults: { ease: 'power3.out', immediateRender: false } });
  }

  /**
   * Wraps every word under `el` in a span.w (for a word-by-word reveal) and returns them, hidden
   * unless `hide` is false. Words inside a `.grad` get their own slice of the gradient: a parent
   * that clips its background to its text would keep painting the words while they're hidden.
   */
  function words(el, { hide = true } = {}) {
    const out = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walk.nextNode()) nodes.push(walk.currentNode);
    for (const n of nodes) {
      if (!n.textContent.trim() || n.parentElement.closest('pre, code, svg')) {
        if (n.textContent.trim() && n.parentElement.closest('pre, code')) {
          const s = document.createElement('span');
          s.className = 'w';
          n.parentNode.replaceChild(s, n);
          s.appendChild(n);
          out.push(s);
        }
        continue;
      }
      const frag = document.createDocumentFragment();
      for (const part of n.textContent.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) frag.appendChild(document.createTextNode(part));
        else {
          const s = document.createElement('span');
          s.className = 'w';
          s.textContent = part;
          frag.appendChild(s);
          out.push(s);
        }
      }
      n.parentNode.replaceChild(frag, n);
    }
    const grads = new Set(out.map((w) => w.closest('.grad')).filter(Boolean));
    for (const host of grads) {
      const hr = host.getBoundingClientRect();
      const bg = getComputedStyle(host).backgroundImage;
      for (const w of out.filter((x) => host.contains(x))) {
        const r = w.getBoundingClientRect();
        Object.assign(w.style, { backgroundImage: bg, backgroundSize: `${hr.width}px ${hr.height}px`, backgroundPosition: `${hr.left - r.left}px ${hr.top - r.top}px`, backgroundRepeat: 'no-repeat', webkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' });
      }
      host.style.backgroundImage = 'none';
    }
    if (hide) for (const w of out) w.style.opacity = '0';
    return out;
  }

  /**
   * Camera math: the x/y to give an element (scaled by `scale` about its own centre) so that the
   * point `from` (page coordinates, untransformed) lands on `to`.
   */
  function focus(el, from, to, scale) {
    const r = el.getBoundingClientRect();
    const ox = r.left + r.width / 2;
    const oy = r.top + r.height / 2;
    return { x: to[0] - ox - scale * (from[0] - ox), y: to[1] - oy - scale * (from[1] - oy), scale };
  }

  /** The centre of `el` in page coordinates (call before anything is transformed). */
  function center(el) {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  /** Seeded PRNG (mulberry32): the same "random" layout on every frame and every render. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A tap: a finger dot presses in, a ripple spreads. `x`/`y` are relative to `layer`. */
  function tap(tl, layer, x, y, at, { size = 64 } = {}) {
    const finger = document.createElement('div');
    finger.className = 'finger';
    const ring = document.createElement('div');
    ring.className = 'tap';
    for (const el of [finger, ring]) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      layer.appendChild(el);
    }
    ring.style.width = ring.style.height = `${size}px`;
    ring.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
    tl.fromTo(finger, { opacity: 0, scale: 1.6 }, { opacity: 1, scale: 1, duration: 0.25, ease: 'power2.out' }, at - 0.25)
      .to(finger, { scale: 0.86, duration: 0.1, ease: 'power1.in' }, at)
      .to(finger, { scale: 1, opacity: 0, duration: 0.3, ease: 'power1.out' }, at + 0.14)
      .fromTo(ring, { opacity: 0.9, scale: 0.4 }, { opacity: 0, scale: 2.2, duration: 0.6, ease: 'power2.out' }, at + 0.02);
    return finger;
  }

  /** The iOS keyboard (dark), 390 × 300. Keys get ids `<id>-<letter>`, `<id>-space`, `<id>-return`. */
  function keyboard({ id, suggestions = ['“the”', 'to', 'it'] }) {
    const row = (keys, cls = '') => `<div class="kb-row ${cls}">${keys}</div>`;
    const letters = (s) => [...s].map((c) => `<span class="kb-key" id="${id}-${c}">${c}</span>`).join('');
    return `<div class="kb" id="${id}">
      <div class="kb-sugg">${suggestions.map((s) => `<span>${esc(s)}</span>`).join('<i></i>')}</div>
      ${row(letters('qwertyuiop'))}
      ${row(letters('asdfghjkl'), 'mid')}
      ${row(`<span class="kb-key fn wide">${svg('<path d="M12 4l8 8h-5v8H9v-8H4z"/>', 'width="20" height="20"')}</span>${letters('zxcvbnm')}<span class="kb-key fn wide">${svg('<path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/><path d="M17 9l-5 6M12 9l5 6"/>', 'width="20" height="20"')}</span>`)}
      ${row(`<span class="kb-key fn w123">123</span><span class="kb-key fn emo">${svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1.9 2 5.1 2 7 0M9 9.5h.01M15 9.5h.01"/>', 'width="22" height="22"')}</span><span class="kb-key space" id="${id}-space">space</span><span class="kb-key fn ret" id="${id}-return">return</span>`)}
      <div class="kb-bottom"><span>${svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>', 'width="24" height="24"')}</span><span>${svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', 'width="24" height="24"')}</span></div>
    </div>`;
  }

  /** A mouse pointer for clicks on the PC. Move it with x/y; `click()` animates a press. It enters and leaves through the frame edge. */
  function pointer({ id }) {
    return `<div class="pointer" id="${id}" data-layout-allow-overflow><svg width="30" height="30" viewBox="0 0 24 24"><path d="M5 2.5v17.2l4.3-4.1 2.8 6.4 3-1.3-2.8-6.3 6-.3z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg><i></i></div>`;
  }

  function click(tl, el, at) {
    const ring = el.querySelector('i');
    tl.fromTo(el, { scale: 1 }, { scale: 0.86, duration: 0.08, ease: 'power1.in' }, at)
      .fromTo(el, { scale: 0.86 }, { scale: 1, duration: 0.16, ease: 'power1.out' }, at + 0.1)
      .fromTo(ring, { opacity: 0.8, scale: 0.3 }, { opacity: 0, scale: 1.6, duration: 0.45, ease: 'power2.out' }, at + 0.02);
  }

  /**
   * Kinetic type on one beat grid (the kinetic-beat-slam rule): entrances vary by axis and ease —
   * slam (scale + blur), snap (from the side), rise (up with a tilt) — and exits are quick cuts.
   * `flash` is a full-frame white layer, `stage` the element a shake moves.
   */
  function kinetic(tl, { flash, stage } = {}) {
    const k = {
      slam: (el, t, { from = 1.4, blur = 12, d = 0.24, ease = 'power4.out' } = {}) =>
        tl.fromTo(el, { opacity: 0, scale: from, filter: `blur(${blur}px)` }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: d, ease }, t),
      snap: (el, t, { dx = -160, d = 0.24, ease = 'expo.out' } = {}) =>
        tl.fromTo(el, { opacity: 0, x: dx }, { opacity: 1, x: 0, duration: d, ease }, t),
      rise: (el, t, { dy = 90, rot = 4, d = 0.32, ease = 'circ.out' } = {}) =>
        tl.fromTo(el, { opacity: 0, y: dy, rotation: rot }, { opacity: 1, y: 0, rotation: 0, duration: d, ease }, t),
      pop: (el, t, { from = 0.5, d = 0.45 } = {}) =>
        tl.fromTo(el, { opacity: 0, scale: from }, { opacity: 1, scale: 1, duration: d, ease: 'back.out(2)' }, t),
      off: (el, t, d = 0.1) => tl.fromTo(el, { opacity: 1 }, { opacity: 0, duration: d, ease: 'power2.in' }, t),
      flash: (t, a = 0.2) => flash && tl.fromTo(flash, { opacity: a }, { opacity: 0, duration: 0.28, ease: 'power2.out' }, t),
      shake: (t, amp = 10) => {
        if (!stage) return;
        const r = rng(Math.round(t * 1000) + 7);
        const p = [0, 1, 2, 3].map((i) => ({ x: (r() - 0.5) * 2 * amp * (1 - i / 4), y: (r() - 0.5) * 2 * amp * (1 - i / 4) }));
        let from = { x: 0, y: 0 };
        [...p, { x: 0, y: 0 }].forEach((to, i) => {
          tl.fromTo(stage, from, { ...to, duration: i ? 0.05 : 0.04, ease: 'none' }, t + (i ? 0.04 + (i - 1) * 0.05 : 0));
          from = to;
        });
      },
    };
    return k;
  }

  /** The ThemeToggle.tsx window of the "add dark mode" demo session (acme-web). Spread into vscode(). */
  function themeToggle() {
    const K = (s) => `<span class="k">${s}</span>`, S = (s) => `<span class="s">${s}</span>`, F = (s) => `<span class="f">${s}</span>`, T = (s) => `<span class="t">${s}</span>`;
    return {
      title: 'ThemeToggle.tsx — acme-web',
      tabs: ['Page.tsx', '*ThemeToggle.tsx'],
      code: [
        `${K('import')} { useEffect, useState } ${K('from')} ${S("'react'")};`,
        '',
        `${K('type')} ${T('Theme')} = ${S("'light'")} | ${S("'dark'")};`,
        '',
        `${K('export function')} ${F('ThemeToggle')}() {`,
        `  ${K('const')} [theme, setTheme] = ${F('useState')}&lt;${T('Theme')}&gt;(() =&gt;`,
        `    (localStorage.${F('getItem')}(${S("'theme'")}) ${K('as')} ${T('Theme')})`,
        `      ?? (${F('matchMedia')}(${S("'(prefers-color-scheme: dark)'")}).matches`,
        `        ? ${S("'dark'")} : ${S("'light'")}));`,
        '',
        `  ${F('useEffect')}(() =&gt; {`,
        `    document.documentElement.dataset.theme = theme;`,
        `    localStorage.${F('setItem')}(${S("'theme'")}, theme);`,
        `  }, [theme]);`,
        '',
        `  ${K('return')} &lt;${T('Toggle')} checked={theme === ${S("'dark'")}}`,
        `    onChange={(on) =&gt; ${F('setTheme')}(on ? ${S("'dark'")} : ${S("'light'")})} /&gt;;`,
        '}',
      ],
      explorer: `<div class="f d">⌄ acme-web</div><div class="f d">&nbsp;&nbsp;⌄ src</div><div class="f d">&nbsp;&nbsp;&nbsp;&nbsp;⌄ settings</div>
          <div class="f">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Page.tsx <b>M</b></div><div class="f sel">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ThemeToggle.tsx <b>U</b></div>
          <div class="f d">&nbsp;&nbsp;&nbsp;&nbsp;› components</div><div class="f">&nbsp;&nbsp;package.json</div><div class="f">&nbsp;&nbsp;README.md</div>`,
    };
  }

  return { esc, icon, app, settle, phone, notif, lock, vscode, themeToggle, keyboard, pointer, click, kinetic, timeline, words, focus, center, rng, tap };
})();
