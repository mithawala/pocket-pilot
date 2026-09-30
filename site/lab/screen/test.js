// Reports whether iOS gives this Home Screen web app the whole screen (WebKit bug 301994 leaves a
// status-bar-high band at the bottom of Home Screen apps with PWA markup on iOS 26.5 and later).
(() => {
  const $ = (id) => document.getElementById(id);
  const probe = (prop) => {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:0;top:0;width:0;visibility:hidden;height:env(${prop}, 0px)`;
    document.body.appendChild(el);
    const h = Math.round(el.getBoundingClientRect().height);
    el.remove();
    return h;
  };
  const ios = (navigator.userAgent.match(/OS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/) || []).slice(1).filter(Boolean).join('.');

  function render() {
    const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    const portrait = innerHeight >= innerWidth;
    const screenLong = Math.max(screen.width, screen.height);
    const screenShort = Math.min(screen.width, screen.height);
    const full = portrait ? screenLong : screenShort;
    const gap = Math.round(full - innerHeight);
    const top = probe('safe-area-inset-top');
    const bottom = probe('safe-area-inset-bottom');
    const rows = [
      ['iOS', ios || 'not iOS'],
      ['Opened from the Home Screen', standalone ? 'yes' : 'no'],
      ['Screen', `${screen.width} × ${screen.height}`],
      ['Page', `${innerWidth} × ${innerHeight}`],
      ['Visual viewport', window.visualViewport ? `${Math.round(visualViewport.width)} × ${Math.round(visualViewport.height)}` : '—'],
      ['Safe area top / bottom', `${top} / ${bottom}`],
      ['Screen left over at the bottom', `${Math.max(0, gap)} pt`],
      ['Markup', 'manifest, no apple-* tags'],
    ];
    $('facts').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    const verdict = $('verdict');
    if (!standalone) {
      verdict.className = 'verdict wait';
      verdict.textContent = 'Add this page to your Home Screen, then open it from there.';
      $('note').textContent = 'In Safari: Share → Add to Home Screen → Add. Then open "Screen test" from the Home Screen.';
    } else if (!portrait) {
      verdict.className = 'verdict wait';
      verdict.textContent = 'Hold the phone upright (portrait).';
      $('note').textContent = '';
    } else if (gap > 4) {
      verdict.className = 'verdict bad';
      verdict.textContent = `✗ iOS left ${gap} pt of the screen under the page.`;
      $('note').textContent = 'The dark strip under the blue bar is the bug. Take a screenshot and send it to me.';
    } else {
      verdict.className = 'verdict ok';
      verdict.textContent = '✓ The page fills the whole screen.';
      $('note').textContent = 'No strip under the blue bar: this markup avoids the bug. Take a screenshot and send it to me.';
    }
  }
  render();
  for (const ev of ['resize', 'orientationchange', 'pageshow']) addEventListener(ev, () => setTimeout(render, 150));
  window.visualViewport?.addEventListener('resize', () => setTimeout(render, 150));
})();
