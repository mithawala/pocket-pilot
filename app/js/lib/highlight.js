// Syntax highlighting for code blocks with highlight.js (loaded on first use, one grammar at a time).
// Colours come from the One Dark / One Light tokens in app.css.
const LANGS = new Set(['bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'dockerfile', 'go', 'ini', 'java', 'javascript', 'json', 'kotlin', 'markdown', 'php', 'plaintext', 'powershell', 'python', 'ruby', 'rust', 'shell', 'sql', 'swift', 'typescript', 'xml', 'yaml']);
const ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  sh: 'bash', zsh: 'bash', console: 'shell', shellsession: 'shell', terminal: 'shell',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  py: 'python', python3: 'python', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', xaml: 'xml', csproj: 'xml',
  yml: 'yaml', md: 'markdown', cs: 'csharp', 'c#': 'csharp', rs: 'rust', kt: 'kotlin', golang: 'go',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c', rb: 'ruby', docker: 'dockerfile', toml: 'ini', jsonc: 'json', json5: 'json',
  text: 'plaintext', txt: 'plaintext', patch: 'diff', sqlite: 'sql', postgres: 'sql', tsql: 'sql',
};

let corePromise = null;
const grammars = new Map();

function core() {
  corePromise ||= import('../../vendor/hljs/core.min.js').then((m) => m.default);
  return corePromise;
}

function grammar(hljs, name) {
  if (hljs.getLanguage(name)) return Promise.resolve(true);
  if (!grammars.has(name)) {
    grammars.set(name, import(`../../vendor/hljs/languages/${name}.min.js`)
      .then((m) => {
        hljs.registerLanguage(name, m.default);
        return true;
      })
      .catch(() => false));
  }
  return grammars.get(name);
}

/** The language named in a fenced code block's class (as written by the agent), e.g. "ts". */
export function rawLanguage(codeEl) {
  const m = /(?:^|\s)language-([\w#+.-]+)/.exec(codeEl?.className || '');
  return m ? m[1].toLowerCase() : '';
}

export function canonicalLanguage(raw) {
  const name = ALIASES[raw] || raw;
  return LANGS.has(name) ? name : null;
}

/** Highlights a <code> element in place. The source is its text, so the output is safe to insert. */
export async function highlightElement(codeEl) {
  const name = canonicalLanguage(rawLanguage(codeEl));
  if (!name || name === 'plaintext' || codeEl.dataset.hl) return false;
  const hljs = await core();
  if (!(await grammar(hljs, name))) return false;
  const text = codeEl.textContent;
  const { value } = hljs.highlight(text, { language: name, ignoreIllegals: true });
  if (!codeEl.isConnected || codeEl.textContent !== text) return false;
  codeEl.innerHTML = value;
  codeEl.dataset.hl = '1';
  return true;
}
