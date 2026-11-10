// Links to local files in what an agent writes: `[report](C:/Users/me/report.pdf)`, `[x](file:///…)`,
// `[src](src/app.ts#L10)`. Shared by the phone (which makes them tappable) and the computer (which lets
// a paired device open what the agent linked), so both read a link the same way.

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
