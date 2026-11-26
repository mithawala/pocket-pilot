// Links to local files in what an agent writes: `[report](C:/Users/me/report.pdf)`, `[x](file:///…)`,
// `[src](src/app.ts#L10)`, and to pages running on the computer (`http://localhost:5173`). Shared by the
// phone (which makes them tappable) and the computer (which lets a paired device open what the agent
// linked), so both read a link the same way.

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A local path as a file: URI: each part percent-encoded, a Windows drive (C:) kept as it is. */
export function pathToUri(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const enc = (rest) => rest.split('/').map(encodeURIComponent).join('/');
  const drive = /^([a-zA-Z]:)(\/.*)?$/.exec(s);
  if (drive) return `file:///${drive[1]}${enc(drive[2] || '/')}`;
  // A network share (\\server\share), only as Windows writes it.
  const unc = /^\/\/([^/]+)(\/.*)?$/.exec(s);
  if (unc && /^\\\\/.test(String(p))) return `file://${encodeURIComponent(unc[1])}${enc(unc[2] || '/')}`;
  if (s.startsWith('/') && !s.startsWith('//')) return `file://${enc(s)}`;
  return null;
}

/**
 * What a link target points to on the computer: `{ uri }` (a file: URI) for an absolute path,
 * `{ rel }` for a path relative to the session's folder, or null for a web link or anything else.
 * Line numbers (`#L10`, `:10:5`) are left out: the file is what opens.
 */
export function localLink(href) {
  const h = String(href || '').trim();
  if (!h || h.startsWith('#') || h.startsWith('?')) return null;
  if (/^file:/i.test(h)) {
    const bare = h.replace(/[?#].*$/, '');
    try {
      return { uri: new URL(bare).href };
    } catch {
      return null;
    }
  }
  let p = h;
  const vscode = /^vscode(?:-insiders)?:\/\/file(\/.*)$/i.exec(h);
  if (vscode) p = vscode[1].replace(/^\/([a-zA-Z]:)/, '$1');
  // C:%5CUsers%5C… is how the markdown library writes C:\Users\… in a link.
  else if (/^[a-zA-Z][\w+.-]*:/.test(h) && !/^[a-zA-Z]:([\\/]|%5c)/i.test(h)) return null;
  p = decode(p.replace(/[?#].*$/, '')).replace(/:\d+(?::\d+)?$/, '');
  if (!p.trim()) return null;
  // //host/path is a web address without its scheme, not a network share (\\server\share).
  if (/^\/\/[^/]/.test(p)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\/]/.test(p) || p.startsWith('/')) {
    const uri = pathToUri(p);
    return uri ? { uri } : null;
  }
  // "C:" alone, or "\x" (the root of some drive): not a place to open.
  if (/^[a-zA-Z]:$/.test(p) || p.startsWith('\\')) return null;
  return { rel: p.replace(/\\/g, '/') };
}

// [label](destination "title"): labels may hold [brackets], destinations (balanced) parentheses or
// be written <with spaces>. Each part can only match its own characters, so a long line without a
// closing bracket or parenthesis is read once, not once per character.
const LINK = /\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\(\s*(?:<([^<>\n]*)>|((?:[^\s()]|\([^\s()]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
// [label]: destination, on its own line: a link written once and used by its label elsewhere.
const REF = /^[ \t]{0,3}\[(?:[^[\]\\\n]|\\.)+\]:[ \t]*(?:<([^<>\n]*)>|(\S+))/gm;
const unescape = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** The links (and pictures) in some markdown: each one's destination as written (markdown escapes undone), and the link's markdown. */
export function linkMatches(markdown) {
  const md = String(markdown || '');
  const out = [];
  for (const m of md.matchAll(LINK)) out.push({ target: unescape(m[1] ?? m[2]), text: m[0] });
  if (md.includes(']:')) for (const m of md.matchAll(REF)) out.push({ target: unescape(m[1] ?? m[2]), text: m[0].trim() });
  return out;
}

/** The destinations of the links (and pictures) in some markdown, as written (markdown escapes undone). */
export function linkTargets(markdown) {
  return linkMatches(markdown).map((l) => l.target);
}

// ---------------------------------------------------------------- pages running on the computer

// The computer's own addresses, and 0.0.0.0 (a server that listens on every address prints that).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * A page running on the computer (`http://localhost:5173/`, `http://127.0.0.1:5182`, `http://[::1]:8080/x`):
 * `{ url, scheme, host, port, key, path, address }`, or null for anything else. `key` (`http:5173`) is
 * what opening it gives access to: everything on that port.
 */
export function localWebUrl(href) {
  const h = String(href || '').trim();
  if (!/^https?:\/\//i.test(h)) return null;
  let u;
  try {
    u = new URL(h);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) || u.username || u.password) return null;
  const scheme = u.protocol.slice(0, -1);
  const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
  if (!(port > 0)) return null;
  const address = `${host}${u.port ? `:${u.port}` : ''}`;
  const path = `${u.pathname || '/'}${u.search}${u.hash}`;
  return { url: `${scheme}://${address}${path}`, scheme, host, port, key: `${scheme}:${port}`, path, address };
}

// Such an address in text, up to its port: what comes next can't continue a host name or port
// (`http://localhost.example.com` is someone else's), or slip in a user name (`…@example.com`).
const LOCAL_WEB = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?(?![\p{L}\p{N}_@%-]|[.:][\p{L}\p{N}_-])/giu;

/** The pages on the computer some text mentions, linked or not: each parsed, with `text`, its address as written. */
export function localWebMatches(text) {
  const s = String(text || '');
  if (!s.includes('://')) return [];
  const out = [];
  for (const m of s.matchAll(LOCAL_WEB)) {
    const web = localWebUrl(m[0]);
    if (web) out.push({ ...web, text: m[0] });
  }
  return out;
}
