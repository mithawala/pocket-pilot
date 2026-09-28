// Markdown -> sanitized HTML. Agent output is untrusted: everything goes through DOMPurify.
import { marked } from '../../vendor/marked/marked.esm.js';
import DOMPurify from '../../vendor/dompurify/purify.es.js';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else if (/^file:/i.test(href)) {
      // Local files cannot be opened on the phone: keep the label, remember the path.
      node.setAttribute('data-file', href);
      node.removeAttribute('href');
      node.classList.add('file-link');
    } else {
      node.removeAttribute('href');
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
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'type', 'checked', 'disabled', 'data-file', 'target', 'rel', 'loading', 'colspan', 'rowspan', 'align'],
  ALLOW_DATA_ATTR: false,
};

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
