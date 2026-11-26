// A page a session runs on the computer (http://localhost:5173, a review page), opened on this device. The
// computer gives it a link of its own (extension/core/preview.js) that lets the browser it's opened in
// through once; the link is asked for again after each use and before it runs out.
import { html, useState, useEffect, useRef } from '../lib/ui.js';
import { Icon, Sheet, Spinner } from './common.js';
import { localWebUrl } from '../core/links.js';

const NOTICE_KEY = 'pp:previewNoticeSeen';

function noticeSeen() {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

function markNoticeSeen() {
  try {
    localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    /* private browsing: shown again next time */
  }
}

const sentence = (s) => String(s || '').replace(/([^.!?])$/, '$1.');

/** What to tell the person when a page can't be opened (`host`: VS Code or the GitHub Copilot app). */
export function pageError(err, host = 'VS Code') {
  switch (err?.code) {
    case 'offline':
      return 'Not connected to your computer. Try again when the connection is back.';
    case 'timeout':
      return 'Your computer took too long to answer. Try again.';
    case 'tunnel':
      return `${sentence(err.message)} Cloudflare sometimes holds back new links for a minute: try again soon.`;
    case 'unsupported':
      return `Pages open through Pocket Pilot's quick tunnel, and your computer uses another one. To open them, set the tunnel back to quick in Pocket Pilot's settings in ${host}.`;
    case 'invalid':
      return 'This isn’t a page on your computer.';
    case 'closed':
      return 'Pocket Pilot stopped on your computer.';
    case 'gone':
      return 'This page was closed on your computer, after 30 minutes without use or from the Pocket Pilot panel.';
    default:
      return err?.message ? sentence(err.message) : 'Something went wrong.';
  }
}

/** The sheet for a link to a page on the computer (`url`, from a chat), or nothing. */
export function PageSheet({ conn, url, host, onClose }) {
  const web = url ? localWebUrl(url) : null;
  // The link for `url`: { url, link, expiresIn } or { url, error }; `busy` while a new one is on its way.
  const [got, setGot] = useState({ url: null });
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const [notice, setNotice] = useState(() => !noticeSeen());
  // What the last answer was for, and whether it gave a link: until one did, an ask opens the page.
  const last = useRef(null);
  const support = conn?.previewSupport;
  const can = !!web && support === 1;

  // Each time it opens: how a page opens is told in full until the first one is opened.
  useEffect(() => {
    if (url) setNotice(!noticeSeen());
  }, [url]);

  useEffect(() => {
    if (!url) {
      last.current = null;
      setGot({ url: null });
      return undefined;
    }
    if (!can) return undefined;
    let stop = false;
    let renew = null;
    // `first`: tapping the link (or Try again) opens the page and counts as using it. Keeping a link
    // ready afterwards doesn't, and doesn't open a page that was closed meanwhile.
    const first = !(last.current?.url === url && last.current.ok);
    setBusy(true);
    conn.preview(web.url, { first }).then((r) => {
      if (stop) return;
      last.current = { url, ok: true };
      setGot({ url, link: r.url, expiresIn: r.expiresIn, at: Date.now() });
      setBusy(false);
      // Before it runs out (5 minutes), a new one.
      renew = setTimeout(() => setRound((n) => n + 1), Math.max(30, (r.expiresIn || 300) * 0.8) * 1000);
    }, (err) => {
      if (stop) return;
      last.current = { url, ok: false };
      setGot({ url, error: err });
      setBusy(false);
    });
    return () => {
      stop = true;
      clearTimeout(renew);
    };
  }, [url, round, can]);

  // Back from the background (timers wait there): a link about to run out is asked for again first.
  useEffect(() => {
    if (!url || !got.link) return undefined;
    const back = () => {
      if (document.visibilityState === 'visible' && Date.now() - got.at > Math.max(30, (got.expiresIn || 300) * 0.8) * 1000) setRound((n) => n + 1);
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [url, got]);

  if (!url) return null;
  const mine = got.url === url;
  const opened = () => {
    if (notice) markNoticeSeen();
    // That link opens once: the next tap needs a new one.
    setTimeout(() => setRound((n) => n + 1), 600);
  };

  let body;
  if (!web) body = html`<div class="errpart">This isn’t a page on your computer.</div>`;
  else if (support === undefined) body = html`<div class="errpart">Update Pocket Pilot on your computer to open the pages your sessions run, like this one. In ${host}, click Update in the Pocket Pilot panel.</div>`;
  else if (support !== 1) body = html`<div class="errpart">${pageError({ code: 'unsupported' }, host)}</div>`;
  else if (mine && got.error?.code === 'demo') body = html`<p class="new-note"><${Icon} name="info" /><span>${got.error.message}</span></p>`;
  else if (mine && got.error && !busy) {
    const gone = got.error.code === 'gone';
    body = html`<div class="errpart">${pageError(got.error, host)}</div>
      <button class=${`btn block${gone ? ' primary' : ''}`} onClick=${() => setRound((n) => n + 1)}><${Icon} name=${gone ? 'globe' : 'refresh'} /> ${gone ? 'Open it again' : 'Try again'}</button>`;
  } else if (!mine || !got.link) {
    body = html`<div class="page-wait"><${Spinner} /><span>Opening a private link to this page… The first time takes a few seconds.</span></div>`;
  } else {
    body = html`<a class=${`btn primary block page-open${busy ? ' busy' : ''}`} href=${busy ? undefined : got.link} target="_blank" rel="noopener" aria-disabled=${busy ? 'true' : undefined} onClick=${(e) => (busy ? e.preventDefault() : opened())}>
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="globe" />`} Open page
      </a>
      ${notice
        ? html`<div class="page-notice">
            <div class="page-notice-title"><${Icon} name="shield" /> How this page opens</div>
            <p>It runs on your computer. Pocket Pilot gives it a private link that opens once, in the browser you tap it in.</p>
            <p>Unlike your chats, the page isn’t end-to-end encrypted: Cloudflare carries it like any https website.</p>
            <p>It closes after 30 minutes without use, or when you close it in Pocket Pilot on your computer.</p>
          </div>`
        : html`<p class="new-note muted small"><${Icon} name="shield" /><span>A private link for this phone, not end-to-end encrypted like your chats. Closes after 30 minutes unused.</span></p>`}`;
  }
  return html`<${Sheet} open=${true} onClose=${onClose} wide=${true} doneLabel="Close" title="Page on your computer">
    <div class="file-detail page-detail">
      <div class="file-head"><div class="file-name">${web ? web.address : url}</div>${web && web.path !== '/' && html`<div class="kv">${web.path}</div>`}</div>
      ${body}
    </div>
  </${Sheet}>`;
}
