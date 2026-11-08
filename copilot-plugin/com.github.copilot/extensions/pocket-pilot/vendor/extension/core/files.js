'use strict';
// Files a paired device may browse and download: a folder's entries, one file's details, a piece of
// a file, and the newest files under a folder. The relay checks first that the device may read there
// (inside a session folder, see RelayServer `isReadAllowed`); these only touch what they are given.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Largest piece of a file per request: a video arrives in many, so the phone shows progress and the
// connection carries the chat in between.
const MAX_CHUNK = 1024 * 1024;
// Entries of one folder sent to the phone.
const MAX_ENTRIES = 5000;
// Folders the newest-files search skips: dependencies and caches, never what an agent made for you
// (lower case). AppData is Windows' app storage in a home folder, full of caches that change all the time.
const SKIP_DIRS = new Set(['node_modules', 'bower_components', '__pycache__', 'site-packages', 'venv', 'env', 'appdata']);

function kindOf(st) {
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}

/** Runs `fn` over `items`, at most `n` at a time. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** A folder's entries with their size and last change (ms since 1970). Links show as what they point to. */
async function listFolder(dir, { limit = MAX_ENTRIES } = {}) {
  const st = await fs.promises.stat(dir);
  if (!st.isDirectory()) throw Object.assign(new Error('Not a folder'), { code: 'ENOTDIR' });
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const shown = dirents.slice(0, limit);
  const entries = await mapLimit(shown, 32, async (e) => {
    try {
      const s = await fs.promises.stat(path.join(dir, e.name));
      return { name: e.name, type: kindOf(s), size: s.isFile() ? s.size : 0, mtime: Math.round(s.mtimeMs) };
    } catch {
      // A broken link, or a file the PC won't let us look at: listed, but not openable.
      return { name: e.name, type: 'other', size: 0, mtime: 0 };
    }
  });
  return { entries, truncated: dirents.length > shown.length };
}

/** One file's or folder's details. */
async function statPath(p) {
  const s = await fs.promises.stat(p);
  return { type: kindOf(s), size: s.isFile() ? s.size : 0, mtime: Math.round(s.mtimeMs) };
}

/**
 * Up to `length` bytes of a file from `offset`, with the file's size and last change at the time of
 * reading, so the phone can tell that a file changed while it was downloading it.
 */
async function readPiece(p, offset, length) {
  const fh = await fs.promises.open(p, 'r');
  try {
    const s = await fh.stat();
    if (!s.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' });
    const want = Math.max(0, Math.min(length, MAX_CHUNK, s.size - offset));
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return { data: buf.subarray(0, got), size: s.size, mtime: Math.round(s.mtimeMs) };
  } finally {
    await fh.close();
  }
}

/**
 * The newest files under `root`, newest first, with their path from `root` ('/'-separated). Skips
 * hidden entries, links (no loops, nothing outside the folder) and dependency folders. A large folder
 * is searched for at most `budgetMs` or `maxDirs` folders, nearest folders first (`truncated` then).
 */
async function newestFiles(root, { limit = 100, budgetMs = 8000, maxDirs = 30000, now = Date.now, home = os.homedir() } = {}) {
  const deadline = now() + budgetMs;
  // A Mac keeps its apps' storage in ~/Library: skipped when the session's folder is the home folder.
  const atHome = path.resolve(root).toLowerCase() === path.resolve(home).toLowerCase();
  const queue = [''];
  let head = 0;
  let dirs = 0;
  let truncated = false;
  let found = [];
  const keep = () => {
    found.sort((a, b) => b.mtime - a.mtime);
    if (found.length > limit) found = found.slice(0, limit);
  };
  while (head < queue.length) {
    if (dirs >= maxDirs || now() > deadline) {
      truncated = true;
      break;
    }
    const rel = queue[head++];
    dirs++;
    let dirents;
    try {
      dirents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    for (const e of dirents) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (!SKIP_DIRS.has(lower) && !(atHome && !rel && lower === 'library')) queue.push(r);
      } else if (e.isFile()) files.push(r);
    }
    const stats = await mapLimit(files, 32, (r) => (now() > deadline ? null : fs.promises.stat(path.join(root, r)).then((s) => ({ path: r, name: r.split('/').pop(), size: s.size, mtime: Math.round(s.mtimeMs) }), () => null)));
    for (const s of stats) if (s) found.push(s);
    if (found.length > limit * 4) keep();
    // A folder with a huge number of files can take all the time on its own.
    if (now() > deadline) {
      truncated = true;
      break;
    }
  }
  keep();
  return { files: found, truncated, searched: dirs };
}

module.exports = { listFolder, statPath, readPiece, newestFiles, MAX_CHUNK, MAX_ENTRIES };
