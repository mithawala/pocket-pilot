// Markdown -> sanitized HTML. Agent output is untrusted: everything goes through DOMPurify.
import { marked } from '../../vendor/marked/marked.esm.js';
import DOMPurify from '../../vendor/dompurify/purify.es.js';
import { localLink } from '../core/links.js';

marked.setOptions({ gfm: true, breaks: false });

// DOMPurify drops hrefs it doesn't know (file:, C:/…) before afterSanitizeAttributes runs, so remember
// every link's target on the way in. (No DOM, e.g. in Node tests, means no hooks: this module is only
// imported there, never rendered.)
const rawHrefs = new WeakMap();
const addHook = typeof DOMPurify.addHook === 'function' ? DOMPurify.addHook.bind(DOMPurify) : () => {};
addHook('uponSanitizeAttribute', (node, data) => {
  if (node.tagName === 'A' && data.attrName === 'href') rawHrefs.set(node, data.attrValue || '');
});

addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const raw = rawHrefs.get(node) ?? node.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(raw) && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else {
      // A file or folder on the computer (C:/…, file:…, or relative to the session's folder): it opens
      // in the app, so keep the label and remember where it points.
      const local = localLink(raw);
      node.removeAttribute('href');
      if (local?.uri) node.setAttribute('data-file', local.uri);
      else if (local?.rel) node.setAttribute('data-file-rel', local.rel);
      if (local) node.classList.add('file-link');
    }
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (!/^(https:|data:image\/)/i.test(src)) node.remove();
    else node.setAttribute('loading', 'lazy');
  }
});

const PURIFY = {
  ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'type', 'checked', 'disabled', 'data-file', 'data-file-rel', 'target', 'rel', 'loading', 'colspan', 'rowspan', 'align'],
  ALLOW_DATA_ATTR: false,
};

// A picture on the computer (![shot](C:/…/shot.png)) can't show inline: it becomes a link that opens it.
// Done on the parsed picture, so code that shows such markdown stays as it is.
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
marked.use({
  renderer: {
    image({ href, title, text }) {
      if (!localLink(href)) return false;
      let name = String(text || '').trim();
      if (!name) {
        name = String(href).replace(/[?#].*$/, '').split(/[\\/]/).pop() || 'picture';
        try {
          name = decodeURIComponent(name);
        } catch {
          /* as written */
        }
      }
      return `<a href="${attr(href)}"${title ? ` title="${attr(title)}"` : ''}>${attr(name)}</a>`;
    },
  },
});

const cache = new Map();

export function renderMarkdown(src) {
  const text = String(src ?? '');
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let htmlOut;
  try {
    htmlOut = DOMPurify.sanitize(marked.parse(text), PURIFY);
  } catch {
    htmlOut = DOMPurify.sanitize(text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
  }
  if (cache.size > 400) cache.clear();
  cache.set(text, htmlOut);
  return htmlOut;
}

/** One line of markdown (links, `code`, emphasis) without block wrappers — for tool progress rows. */
export function renderInline(src) {
  const text = String(src ?? '');
  const key = `\u0000inline:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let htmlOut;
  try {
    htmlOut = DOMPurify.sanitize(marked.parseInline(text), PURIFY);
  } catch {
    htmlOut = DOMPurify.sanitize(text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, htmlOut);
  return htmlOut;
}

/** Plain text of an AHP StringOrMarkdown value. */
export function mdPlain(v, max = 0) {
  let s = typeof v === 'string' ? v : v && typeof v.markdown === 'string' ? v.markdown : '';
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
  return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function mdOf(v) {
  return typeof v === 'string' ? v : v && typeof v.markdown === 'string' ? v.markdown : '';
}
