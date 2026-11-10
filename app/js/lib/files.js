// Files on the PC: what they are, their addresses, downloading them in pieces (with progress, cancel
// and resume after a dropped connection), and saving them on the device (the share sheet on a phone,
// so an iPhone can "Save Video" to Photos or "Save to Files").
import { isIos, appleDevice } from './push.js';

const TYPES = {
  video: { mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo' },
  image: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon' },
  audio: { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg' },
  pdf: { pdf: 'application/pdf' },
  document: {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  },
  archive: { zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', tar: 'application/x-tar' },
  text: {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', html: 'text/html', htm: 'text/html', xml: 'text/xml', css: 'text/css',
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain', py: 'text/plain', ps1: 'text/plain', sh: 'text/plain',
    bat: 'text/plain', cmd: 'text/plain', yml: 'text/plain', yaml: 'text/plain', toml: 'text/plain', ini: 'text/plain', log: 'text/plain', cs: 'text/plain', java: 'text/plain',
    go: 'text/plain', rs: 'text/plain', rb: 'text/plain', php: 'text/plain', c: 'text/plain', h: 'text/plain', cpp: 'text/plain', sql: 'text/plain', bicep: 'text/plain', tf: 'text/plain', srt: 'text/plain', vtt: 'text/vtt',
  },
};
const BY_EXT = {};
for (const [kind, map] of Object.entries(TYPES)) for (const [ext, mime] of Object.entries(map)) BY_EXT[ext] = { kind, mime };

const extOf = (name) => String(name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';

/** What a file is, by its name: video, image, audio, pdf, document, archive, text or other. */
export function fileKind(name) {
  return BY_EXT[extOf(name)]?.kind || 'other';
}

/** The MIME type for a file name, for the saved file (an iPhone offers "Save Video" for video/mp4). */
export function mimeOf(name) {
  return BY_EXT[extOf(name)]?.mime || 'application/octet-stream';
}

/** The icon for a file kind. */
export function kindIcon(kind) {
  return { directory: 'folder', video: 'film', image: 'image', audio: 'music', archive: 'archive' }[kind] || 'file';
}

/** "48.2 MB" */
export function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1000) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = -1;
  do {
    v /= 1000;
    i++;
  } while (v >= 1000 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** When a file last changed: "Today 21:59", "Yesterday 08:12", "Mon 14:02", or the date. */
export function fileTime(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (t) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(ms)) / 86400000);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString();
}

/** The address of `name` in the folder `dir` (both file: URIs as VS Code writes them). */
export function childUri(dir, name) {
  return `${String(dir).replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
}

/** The address of a '/'-separated path under the folder `root`. */
export function underUri(root, rel) {
  return String(rel).split('/').filter(Boolean).reduce(childUri, root);
}

/** The address of a link relative to the folder `base` (`docs/a.md`, `./x`, `../y`), never above its drive. */
export function resolveUri(base, rel) {
  let uri = String(base).replace(/\/+$/, '');
  const top = /^file:\/\/[^/]*\/[^/]+/.exec(uri)?.[0] || uri;
  for (const part of String(rel).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (uri.length > top.length) uri = uri.slice(0, uri.lastIndexOf('/'));
      continue;
    }
    uri = childUri(uri, part);
  }
  return uri;
}

/** The last part of an address, decoded ("promo final.mp4"). */
export function baseName(uri) {
  const last = String(uri || '').replace(/\/+$/, '').split('/').pop() || '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The path of `uri` under the folder `root`, as parts (empty for the folder itself), or null if outside. */
export function partsUnder(root, uri) {
  const decoded = (s) => {
    const t = String(s).replace(/\/+$/, '');
    try {
      return decodeURIComponent(t);
    } catch {
      return t;
    }
  };
  // Decoded first: VS Code writes c%3A where others write C:.
  const a = decoded(root);
  const b = decoded(uri);
  if (a.toLowerCase() === b.toLowerCase()) return [];
  if (!b.toLowerCase().startsWith(`${a.toLowerCase()}/`)) return null;
  return b.slice(a.length + 1).split('/');
}

// Pieces asked for at once, and their size: a few ahead keeps a slow connection busy, and the chat still
// gets through between them.
const PIECE = 512 * 1024;
const AHEAD = 4;
// Pieces are joined into blobs as they arrive, so a big video doesn't sit in the page's memory twice.
const SEGMENT = 8 * 1024 * 1024;
/** Largest file this app downloads. */
export const MAX_DOWNLOAD = 1024 * 1024 * 1024;

const problem = (code, message) => Object.assign(new Error(message), { code });

function bytesOf(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Downloads one file from the PC in pieces. `state`: idle, running, done, failed or cancelled; a 'change'
 * event follows every step. After a dropped connection (`error.code` offline or timeout) `start()` goes on
 * where it stopped; a file that changed on the PC starts over.
 */
export class Download extends EventTarget {
  constructor(conn, uri, { name, size = 0, mtime = 0 } = {}) {
    super();
    this.conn = conn;
    this.uri = uri;
    this.name = name || baseName(uri);
    this.type = mimeOf(this.name);
    this.state = 'idle';
    this.size = size;
    this.mtime = mtime;
    this.received = 0;
    this.error = null;
    this.blob = null;
    this.usedAt = Date.now();
    this._url = null;
    this._run = 0;
    this._reset();
  }

  get resumable() {
    return this.state === 'failed' && this.received > 0 && ['offline', 'timeout'].includes(this.error?.code);
  }

  /** A blob: URL for the downloaded file (for <video>, <img>), made once. */
  get url() {
    if (!this.blob) return null;
    this._url ||= URL.createObjectURL(this.blob);
    return this._url;
  }

  start() {
    if (this.state === 'running' || this.state === 'done') return;
    if (!this.resumable) this._reset();
    const run = ++this._run;
    this._set('running', null);
    this._go(run).catch((err) => {
      if (run !== this._run) return;
      if (err.code === 'changed') this._reset();
      this._set('failed', err);
    });
  }

  /** Stops the download and drops what arrived. */
  cancel() {
    if (this.state !== 'running') return;
    this._run++;
    this._reset();
    this._set('cancelled', null);
  }

  /** Lets go of the downloaded file. */
  release() {
    this._run++;
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = null;
    this.blob = null;
    this._reset();
    if (this.state === 'done' || this.state === 'running') this.state = 'idle';
  }

  _reset() {
    this.received = 0;
    this._segments = [];
    this._parts = [];
    this._partsBytes = 0;
  }

  _set(state, error) {
    this.state = state;
    this.error = error;
    this.dispatchEvent(new Event('change'));
  }

  _add(bytes) {
    this._parts.push(bytes);
    this._partsBytes += bytes.length;
    if (this._partsBytes >= SEGMENT) {
      this._segments.push(new Blob(this._parts));
      this._parts = [];
      this._partsBytes = 0;
    }
  }

  async _go(run) {
    const live = () => run === this._run;
    if (!this.received) {
      const st = await this.conn.files('stat', { uri: this.uri });
      if (!live()) return;
      if (st.type !== 'file') throw problem('not-a-file', 'This is not a file');
      if (st.size > MAX_DOWNLOAD) throw problem('too-large', `This file is larger than ${formatSize(MAX_DOWNLOAD)}, too large to download to your phone`);
      this.size = st.size;
      this.mtime = st.mtime;
      this.dispatchEvent(new Event('change'));
    }
    const inflight = new Map();
    let next = this.received;
    try {
      while (this.received < this.size) {
        while (inflight.size < AHEAD && next < this.size) {
          const length = Math.min(PIECE, this.size - next);
          // Generous: on a slow mobile connection a piece waits behind the ones asked for before it.
          const p = this.conn.files('read', { uri: this.uri, offset: next, length }, 120000);
          p.catch(() => {});
          inflight.set(next, { p, length });
          next += length;
        }
        const offset = this.received;
        const { p, length } = inflight.get(offset);
        const r = await p;
        inflight.delete(offset);
        if (!live()) return;
        if (r.size !== this.size || r.mtime !== this.mtime) throw problem('changed', 'The file changed on your computer while it was downloading');
        const bytes = bytesOf(r.data);
        if (bytes.length !== length) throw problem('changed', 'The file changed on your computer while it was downloading');
        this._add(bytes);
        this.received += bytes.length;
        this.dispatchEvent(new Event('change'));
      }
    } finally {
      inflight.clear();
    }
    if (!live()) return;
    this.blob = new Blob([...this._segments, ...this._parts], { type: this.type });
    this._segments = [];
    this._parts = [];
    this._partsBytes = 0;
    this.usedAt = Date.now();
    this._set('done', null);
    keepWithin(this.conn);
  }
}

// Downloads per connection, so a file keeps downloading (and stays downloaded) when its page closes. The
// finished ones are kept up to KEEP_BYTES, the most recently used first.
const KEEP_BYTES = 600 * 1024 * 1024;
const registry = new WeakMap();

function keepWithin(conn) {
  const all = registry.get(conn);
  if (!all) return;
  const done = [...all.values()].filter((d) => d.state === 'done').sort((a, b) => b.usedAt - a.usedAt);
  let total = 0;
  for (const d of done) {
    total += d.size;
    if (total > KEEP_BYTES && d !== done[0]) {
      d.release();
      all.delete(d.uri);
    }
  }
}

/**
 * The download of `uri` from this connection's PC, made if needed. One for an older version of the file
 * (another size or last change than `known`) starts over, unless it is going on or can go on where it
 * stopped.
 */
export function downloadFor(conn, uri, known = {}) {
  let all = registry.get(conn);
  if (!all) {
    registry.set(conn, (all = new Map()));
    // iOS drops the connection when the app goes to the background: go on once it's back.
    conn.addEventListener?.('ready', () => {
      for (const d of all.values()) if (d.state === 'failed' && ['offline', 'timeout'].includes(d.error?.code)) d.start();
    });
  }
  let d = all.get(uri);
  const older = d && ((known.size !== undefined && known.size !== d.size) || (known.mtime && d.mtime && known.mtime !== d.mtime));
  if (older && d.state !== 'running' && !d.resumable) {
    d.release();
    all.delete(uri);
    d = null;
  }
  if (!d) {
    d = new Download(conn, uri, known);
    all.set(uri, d);
  }
  d.usedAt = Date.now();
  return d;
}

/**
 * A picture on the computer for the full-screen viewer (see loadPicture): it downloads when the viewer
 * shows it, once, so swiping through a folder of screenshots loads each as it comes.
 */
export function pictureAtt(conn, f) {
  const name = f.name || baseName(f.uri);
  const load = () => {
    const d = downloadFor(conn, f.uri, { name, size: f.size, mtime: f.mtime });
    const ready = () => ({ url: d.url, type: d.type, size: d.size });
    if (d.state === 'done') return Promise.resolve(ready());
    return new Promise((resolve, reject) => {
      const on = () => {
        if (d.state === 'done') resolve(ready());
        else if (d.state === 'failed' || d.state === 'cancelled') reject(d.error || new Error('The picture could not be loaded'));
        else return;
        d.removeEventListener('change', on);
      };
      d.addEventListener('change', on);
      if (d.state !== 'running') d.start();
    });
  };
  return { type: 'lazy', label: name, load };
}

/** Whether saving goes through the share sheet (phones and tablets) rather than a download. */
export function savesByShare() {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  return isIos() || /android/i.test(navigator.userAgent || '');
}

/** The label of the button that saves a downloaded file on this device. */
export function saveLabel() {
  if (!savesByShare()) return 'Save';
  return isIos() ? `Save to ${appleDevice()}` : 'Save';
}

/**
 * Saves a downloaded file on this device: the share sheet on a phone (call it straight from a tap, before
 * anything is awaited), a download elsewhere. Resolves to 'shared', 'cancelled' or 'downloaded'.
 */
export async function saveFile(blob, name, type = blob?.type) {
  if (savesByShare()) {
    const file = new File([blob], name, { type: type || 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return 'shared';
      } catch (err) {
        if (err?.name === 'AbortError') return 'cancelled';
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
