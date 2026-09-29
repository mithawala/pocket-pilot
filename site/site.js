// Pocket Pilot product page. Loaded in <head>: runs the redirect before anything renders.
(function () {
  // Pairing links from older builds pointed at the site root; forward them to the app.
  // The fragment never leaves the browser.
  if (/^#pair(=|%3D)/i.test(location.hash)) {
    location.replace('./app/' + location.hash);
    return;
  }
  const root = document.documentElement;
  root.classList.add('js');
  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))) root.classList.add('on-phone');

  document.addEventListener('DOMContentLoaded', () => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Scroll reveal.
    const reveal = document.querySelectorAll('[data-reveal]');
    if (reduced || !('IntersectionObserver' in window)) {
      reveal.forEach((el) => el.classList.add('in'));
    } else {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      reveal.forEach((el) => io.observe(el));
    }

    // Sticky nav styling + mobile menu.
    const nav = document.querySelector('.nav');
    const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    const menu = document.querySelector('.menu-btn');
    menu.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      menu.setAttribute('aria-expanded', String(open));
    });
    nav.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => {
      nav.classList.remove('open');
      menu.setAttribute('aria-expanded', 'false');
    }));

    // iPhone / Android tabs (pre-select the visitor's platform).
    document.querySelectorAll('[data-tabs]').forEach((box) => {
      const buttons = box.querySelectorAll('[data-tab]');
      const select = (name) => {
        buttons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
        box.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
      };
      buttons.forEach((b) => b.addEventListener('click', () => select(b.dataset.tab)));
      if (/Android/i.test(navigator.userAgent)) select('android');
    });

    // Get started: VS Code or the GitHub Copilot app. #copilot-app / #vscode links pick the tab.
    const platforms = document.querySelector('[data-platforms]');
    if (platforms) {
      const selectPlatform = (name) => {
        platforms.querySelectorAll('[data-platform]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.platform === name)));
        document.querySelectorAll('[data-platform-panel]').forEach((p) => {
          p.hidden = p.dataset.platformPanel !== name;
          if (!p.hidden) p.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('in'));
        });
      };
      platforms.querySelectorAll('[data-platform]').forEach((b) => b.addEventListener('click', () => selectPlatform(b.dataset.platform)));
      document.querySelectorAll('a[href="#copilot-app"], a[href="#vscode"]').forEach((a) => a.addEventListener('click', () => selectPlatform(a.getAttribute('href') === '#vscode' ? 'vscode' : 'copilot')));
      const fromHash = () => {
        const name = { '#copilot-app': 'copilot', '#vscode': 'vscode' }[location.hash];
        if (!name) return;
        selectPlatform(name);
        document.getElementById('start').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
      };
      addEventListener('hashchange', fromHash);
      fromHash();
    }

    // Hero: the desktop side switches between VS Code and the GitHub Copilot app.
    const hero = document.querySelector('[data-hero]');
    if (hero) {
      const tabs = hero.querySelectorAll('[data-show]');
      let chosen = false;
      const show = (name) => {
        tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.show === name)));
        hero.querySelectorAll('[data-view]').forEach((w) => {
          const on = w.dataset.view === name;
          if (on && w.hidden) {
            w.classList.remove('fade-in');
            void w.offsetWidth;
            w.classList.add('fade-in');
          }
          w.hidden = !on;
        });
      };
      tabs.forEach((b) => b.addEventListener('click', () => {
        chosen = true;
        show(b.dataset.show);
      }));
      let paused = false;
      hero.addEventListener('mouseenter', () => { paused = true; });
      hero.addEventListener('mouseleave', () => { paused = false; });
      if (!reduced) {
        setInterval(() => {
          if (chosen || paused || document.hidden) return;
          const current = [...tabs].find((b) => b.getAttribute('aria-selected') === 'true')?.dataset.show;
          show(current === 'vscode' ? 'copilot' : 'vscode');
        }, 7000);
      }
    }

    // Copy buttons.
    document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.classList.add('done');
        setTimeout(() => btn.classList.remove('done'), 1600);
      } catch {
        /* clipboard unavailable */
      }
    }));

    // The live demo only loads on wide screens, once it scrolls near the viewport.
    const frame = document.querySelector('iframe[data-src]');
    if (frame) {
      const load = () => {
        if (!frame.src && matchMedia('(min-width: 901px)').matches) frame.src = frame.dataset.src;
      };
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) load();
        }, { rootMargin: '400px 0px' });
        io.observe(frame);
      } else {
        load();
      }
    }
  });
})();
