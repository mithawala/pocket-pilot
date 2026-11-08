// Files in a session's folder on the PC: the newest first (Recent) or folder by folder, and a page per
// file that previews it (pictures, videos, sound, text) and downloads it to this device. An iPhone saves
// through the share sheet: "Save Video" keeps a video in Photos, "Save to Files" keeps anything.
import { html, useState, useEffect, useRef } from '../lib/ui.js';
import { Icon, Sheet, Spinner, toast } from './common.js';
import { fileKind, kindIcon, formatSize, fileTime, childUri, underUri, baseName, partsUnder, downloadFor, saveFile, saveLabel, savesByShare, MAX_DOWNLOAD } from '../lib/files.js';
import { filePath, folderName } from '../lib/format.js';
import { canonicalLanguage, highlightElement } from '../lib/highlight.js';
import { openPictures } from './viewer.js';
import { isIos } from '../lib/push.js';

// Pictures and text up to these sizes open by themselves; anything else waits for Download.
const AUTO_PICTURE = 25 * 1024 * 1024;
const AUTO_TEXT = 1024 * 1024;
// Text shown on the page (a longer file is still downloaded whole).
const TEXT_PREVIEW = 200000;
// Windows' own files, which nobody wants to download.
const JUNK = new Set(['desktop.ini', 'thumbs.db']);
const visible = (e) => !e.name.startsWith('.') && !JUNK.has(e.name.toLowerCase());
// The newest files of a folder, for a minute: switching between Recent and Folders doesn't search again.
const RECENT_FOR_MS = 60000;
const recentCache = new Map();

/** Re-renders when `target` fires 'change'. */
function useChanges(target) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!target) return undefined;
    const on = () => tick((n) => n + 1);
    target.addEventListener('change', on);
    return () => target.removeEventListener('change', on);
  }, [target]);
}

/** What to tell the person when a file can't be listed, read or downloaded. */
export function fileError(err) {
  switch (err?.code) {
    case 'denied':
      return "Only the files in this session's folder can be opened.";
    case 'not-found':
      return 'This is no longer on your computer.';
    case 'offline':
      return 'Not connected to your computer. It goes on when the connection is back.';
    case 'timeout':
      return 'Your computer took too long to answer.';
    case 'changed':
      return 'The file changed on your computer while it was downloading. Download it again.';
    case 'unsupported':
      return 'Update Pocket Pilot on your computer to download files.';
    default:
      return err?.message || 'Something went wrong.';
  }
}

/** Where a file is, from the session's folder: "acme-web / renders", or its full path elsewhere. */
function placeOf(root, uri) {
  const parts = root ? partsUnder(root, uri) : null;
  if (!parts) return filePath(uri).replace(/[\\/][^\\/]*$/, '');
  return [folderName(root), ...parts.slice(0, -1)].join(' / ');
}

function TextPreview({ blob, name }) {
  const [text, setText] = useState(null);
  const ref = useRef(null);
  const ext = (name.match(/\.([\w-]+)$/)?.[1] || '').toLowerCase();
  const lang = canonicalLanguage(ext) ? ext : '';
  useEffect(() => {
    let stop = false;
    blob.slice(0, TEXT_PREVIEW).text().then((t) => !stop && setText(blob.size > TEXT_PREVIEW ? `${t}\n… (the rest is in the downloaded file)` : t), () => !stop && setText('(This file could not be shown as text.)'));
    return () => { stop = true; };
  }, [blob]);
  useEffect(() => {
    if (text && lang && text.length < 120000 && ref.current) highlightElement(ref.current).catch(() => {});
  }, [text, lang]);
  if (text === null) return html`<${Spinner} />`;
  return html`<div class="md file-text"><pre><code key=${name} ref=${ref} class=${lang ? `language-${lang}` : ''}>${text}</code></pre></div>`;
}

/** The hint under Save, for what an iPhone's share sheet offers for this kind of file. */
function saveHint(kind) {
  if (!savesByShare()) return '';
  if (!isIos()) return 'Choose where to keep it, or send it to an app.';
  if (kind === 'video') return 'Choose Save Video to keep it in Photos, or Save to Files.';
  if (kind === 'image') return 'Choose Save Image to keep it in Photos, or Save to Files.';
  return 'Choose Save to Files, or send it to an app.';
}

/**
 * One file: its details, a preview once it's downloaded, and Download, then Save. `file` holds the
 * `uri`, and the `size` and `mtime` when a listing gave them (otherwise they're asked for).
 */
export function FileDetail({ conn, file, root, onBack }) {
  const { uri } = file;
  const name = file.name || baseName(uri);
  const kind = fileKind(name);
  const [info, setInfo] = useState(file.size !== undefined ? { size: file.size, mtime: file.mtime } : null);
  const [infoError, setInfoError] = useState(null);
  const d = downloadFor(conn, uri, { name, ...(info || {}) });
  useChanges(d);
  useEffect(() => {
    if (info) return undefined;
    let stop = false;
    conn.files('stat', { uri }).then((r) => {
      if (stop) return;
      if (r.type !== 'file') setInfoError({ message: 'This is not a file.' });
      else setInfo({ size: r.size, mtime: r.mtime });
    }, (err) => !stop && setInfoError(err));
    return () => { stop = true; };
  }, [uri]);
  // Small pictures and text open by themselves.
  useEffect(() => {
    if (!info || d.state !== 'idle') return;
    if ((kind === 'image' && info.size <= AUTO_PICTURE) || (kind === 'text' && info.size <= AUTO_TEXT)) d.start();
  }, [info, d]);
  const size = d.size || info?.size || 0;
  const mtime = d.mtime || info?.mtime || 0;
  const tooLarge = size > MAX_DOWNLOAD;
  const save = () => {
    // Straight from the tap: iOS opens the share sheet only right after one.
    saveFile(d.blob, name, d.type).then((how) => {
      if (how === 'downloaded' && savesByShare()) toast(`Downloaded ${name}`);
    }, (err) => toast(err.message, 'err'));
  };
  const openFull = () => openPictures([{ att: { type: 'url', url: d.url, label: name }, read: null }], 0);
  let preview;
  if (d.state === 'done' && kind === 'image') preview = html`<button type="button" class="file-img" onClick=${openFull} aria-label=${`View ${name} full screen`}><img src=${d.url} alt=${name} /></button>`;
  else if (d.state === 'done' && kind === 'video') preview = html`<video class="file-video" src=${d.url} controls playsinline preload="metadata"></video>`;
  else if (d.state === 'done' && kind === 'audio') preview = html`<audio class="file-audio" src=${d.url} controls preload="metadata"></audio>`;
  else if (d.state === 'done' && kind === 'text') preview = html`<${TextPreview} blob=${d.blob} name=${name} />`;
  else preview = html`<div class=${`file-hero ${kind}`}><${Icon} name=${kindIcon(kind)} /></div>`;
  const pct = size ? Math.min(100, Math.round((d.received / size) * 100)) : 0;
  let actions;
  if (infoError) actions = html`<div class="errpart">${fileError(infoError)}</div>`;
  else if (!info && d.state === 'idle') actions = html`<div class="file-wait"><${Spinner} /></div>`;
  else if (tooLarge) actions = html`<div class="errpart">At ${formatSize(size)}, this file is too large to download to your phone (up to ${formatSize(MAX_DOWNLOAD)}).</div>`;
  else if (d.state === 'running') {
    actions = html`<div class="dl">
      <div class="dl-bar" role="progressbar" aria-label=${`Downloading ${name}`} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}><span style=${`width:${pct}%`}></span></div>
      <div class="dl-row"><span class="muted small grow">${size ? `${formatSize(d.received)} of ${formatSize(size)}` : 'Starting…'}</span><button class="btn sm" onClick=${() => d.cancel()}>Cancel</button></div>
    </div>`;
  } else if (d.state === 'done') {
    const hint = saveHint(kind);
    actions = html`<div class="file-actions">
      <button class="btn primary block" onClick=${save}><${Icon} name=${savesByShare() ? 'share' : 'download'} /> ${saveLabel()}</button>
      ${hint && html`<div class="muted small file-hint">${hint}</div>`}
    </div>`;
  } else {
    const failed = d.state === 'failed';
    actions = html`<div class="file-actions">
      ${failed && html`<div class="errpart">${fileError(d.error)}</div>`}
      <button class="btn primary block" onClick=${() => d.start()}><${Icon} name=${d.resumable ? 'refresh' : 'download'} /> ${d.resumable ? `Resume · ${formatSize(d.received)} of ${formatSize(size)}` : `${failed ? 'Try again' : 'Download'} · ${formatSize(size)}`}</button>
    </div>`;
  }
  return html`<div class="file-detail">
    ${onBack && html`<button class="btn sm file-back" onClick=${onBack}><${Icon} name="back" size="16" /> Files</button>`}
    <div class="file-head">
      <div class="file-name">${name}</div>
      <div class="muted small">${[size || info ? formatSize(size) : '', fileTime(mtime)].filter(Boolean).join(' · ')}</div>
      <div class="kv">${placeOf(root, uri)}</div>
    </div>
    <div class="file-preview">${preview}</div>
    ${actions}
  </div>`;
}

function FileRow({ entry, meta, onOpen }) {
  const folder = entry.type === 'directory';
  const kind = folder ? 'directory' : fileKind(entry.name);
  return html`<button class="list-item file-row" onClick=${onOpen} disabled=${entry.type === 'other'}>
    <${Icon} name=${kindIcon(kind)} />
    <span class="grow fr"><span class="fn">${entry.name}</span>${meta && html`<span class="fm">${meta}</span>`}</span>
    ${folder && html`<${Icon} name="right" />`}
  </button>`;
}

/** The newest files anywhere under the session's folder. */
function RecentList({ conn, root, onFile, refresh }) {
  const [state, setState] = useState(() => recentCache.get(root) || { loading: true });
  useEffect(() => {
    const cached = recentCache.get(root);
    if (cached && cached.refresh === refresh && Date.now() - cached.at < RECENT_FOR_MS) {
      setState(cached);
      return undefined;
    }
    let stop = false;
    setState({ loading: true });
    conn.files('recent', { uri: root, limit: 100 }, 45000).then((r) => {
      const next = { files: r.files.filter(visible), truncated: r.truncated, at: Date.now(), refresh };
      recentCache.set(root, next);
      if (!stop) setState(next);
    }, (err) => !stop && setState({ error: err }));
    return () => { stop = true; };
  }, [root, refresh]);
  if (state.loading) return html`<div class="empty"><${Spinner} /><p>Looking for the newest files…</p></div>`;
  if (state.error) return html`<div class="errpart">${fileError(state.error)}</div>`;
  if (!state.files.length) return html`<div class="empty">No files in this folder yet.</div>`;
  return html`<div class="file-list">
    ${state.files.map((f) => {
      const where = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')).replace(/\//g, ' / ') : '';
      return html`<${FileRow} key=${f.path} entry=${{ name: f.name, type: 'file' }} meta=${[where, formatSize(f.size), fileTime(f.mtime)].filter(Boolean).join(' · ')} onOpen=${() => onFile({ uri: underUri(root, f.path), name: f.name, size: f.size, mtime: f.mtime })} />`;
    })}
    ${state.truncated && html`<div class="muted small file-note">This folder is large, so not all of it was searched. Look in Folders for the rest.</div>`}
  </div>`;
}

/** One folder: its folders by name, then its files, newest first. */
function FolderList({ conn, root, dir, onDir, onFile, refresh }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let stop = false;
    setState({ loading: true });
    conn.files('list', { uri: dir }).then((r) => {
      if (stop) return;
      const entries = r.entries.filter(visible);
      const folders = entries.filter((e) => e.type === 'directory').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      const rest = entries.filter((e) => e.type !== 'directory').sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
      setState({ dir, entries: [...folders, ...rest], truncated: r.truncated });
    }, (err) => !stop && setState({ dir, error: err }));
    return () => { stop = true; };
  }, [dir, refresh]);
  // Only what was listed for this folder: not the previous folder's list while this one loads.
  const current = state.dir === dir ? state : { loading: true };
  const parts = partsUnder(root, dir) || [];
  return html`<div>
    <div class="crumbs" aria-label="Folder">
      ${[folderName(root), ...parts].map((p, i, all) => html`<span key=${i} class="crumb">
        ${i > 0 && html`<span class="sep">/</span>`}
        ${i === all.length - 1 ? html`<b>${p}</b>` : html`<button onClick=${() => onDir(underUri(root, parts.slice(0, i).join('/')))}>${p}</button>`}
      </span>`)}
    </div>
    ${current.loading && html`<div class="empty"><${Spinner} /></div>`}
    ${current.error && html`<div class="errpart">${fileError(current.error)}</div>`}
    ${current.entries && !current.entries.length && html`<div class="empty">This folder is empty.</div>`}
    ${current.entries && html`<div class="file-list">
      ${current.entries.map((e) => html`<${FileRow} key=${e.name} entry=${e} meta=${e.type === 'file' ? `${formatSize(e.size)} · ${fileTime(e.mtime)}` : ''}
        onOpen=${() => (e.type === 'directory' ? onDir(childUri(dir, e.name)) : onFile({ uri: childUri(dir, e.name), name: e.name, size: e.size, mtime: e.mtime }))} />`)}
      ${current.truncated && html`<div class="muted small file-note">Only the first ${current.entries.length} entries are shown.</div>`}
    </div>`}
  </div>`;
}

/** Recent and Folders, and a file's page in place of the list (Files goes back to where you were). */
function FilesBrowser({ conn, root }) {
  const [tab, setTab] = useState(() => (localStorage.getItem('pp:filesTab') === 'folders' ? 'folders' : 'recent'));
  const [dir, setDir] = useState(root);
  const [file, setFile] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const box = useRef(null);
  const scrollTop = useRef(0);
  const sheet = () => box.current?.closest('.sheet');
  const pick = (t) => {
    setTab(t);
    try {
      localStorage.setItem('pp:filesTab', t);
    } catch {
      /* private mode */
    }
  };
  const open = (f) => {
    scrollTop.current = sheet()?.scrollTop || 0;
    setFile(f);
    if (sheet()) sheet().scrollTop = 0;
  };
  const back = () => {
    setFile(null);
    requestAnimationFrame(() => {
      if (sheet()) sheet().scrollTop = scrollTop.current;
    });
  };
  if (file) return html`<div ref=${box}><${FileDetail} key=${file.uri} conn=${conn} file=${file} root=${root} onBack=${back} /></div>`;
  return html`<div ref=${box} class="files">
    <div class="row files-bar">
      <div class="seg grow" role="tablist">
        <button role="tab" aria-selected=${tab === 'recent' ? 'true' : 'false'} class=${tab === 'recent' ? 'on' : ''} onClick=${() => pick('recent')}>Recent</button>
        <button role="tab" aria-selected=${tab === 'folders' ? 'true' : 'false'} class=${tab === 'folders' ? 'on' : ''} onClick=${() => pick('folders')}>Folders</button>
      </div>
      <button class="icon-btn" onClick=${() => setRefresh((n) => n + 1)} aria-label="Refresh" title="Refresh"><${Icon} name="refresh" /></button>
    </div>
    ${tab === 'recent'
      ? html`<${RecentList} conn=${conn} root=${root} onFile=${open} refresh=${refresh} />`
      : html`<${FolderList} conn=${conn} root=${root} dir=${dir} onDir=${setDir} onFile=${open} refresh=${refresh} />`}
  </div>`;
}

/** The session's files (from the session menu). `root` is the session's folder. */
export function FilesSheet({ open, onClose, conn, root, host }) {
  let body;
  if (!conn?.canBrowseFiles) body = html`<div class="empty">Update Pocket Pilot on your computer to browse and download the files in your sessions: in ${host || 'VS Code'}, click Update in the Pocket Pilot panel.</div>`;
  else if (!root) body = html`<div class="empty">This session has no folder on your computer.</div>`;
  else body = html`<${FilesBrowser} key=${root} conn=${conn} root=${root} />`;
  return html`<${Sheet} open=${open} onClose=${onClose} title="Files" wide=${true}>${body}</${Sheet}>`;
}

/** A file the agent links to in the chat. */
export function FileSheet({ conn, uri, root, onClose }) {
  return html`<${Sheet} open=${!!uri} onClose=${onClose} wide=${true} doneLabel="Close" title="File">
    ${uri && html`<${FileDetail} key=${uri} conn=${conn} file=${{ uri }} root=${root} />`}
  </${Sheet}>`;
}
