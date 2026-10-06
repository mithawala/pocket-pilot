// Pictures attached to chat messages: screenshots pasted in VS Code or the GitHub Copilot app, photos
// sent from the phone. VS Code keeps them as files on the PC (`resource` attachments, read through
// `resourceRead`); the phone's own uploads travel inline (`embeddedResource`, base64).

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
};

/** The image MIME type a file name suggests, or ''. */
export function mimeFromName(name) {
  const clean = decodeSafe(String(name || '').split(/[?#]/)[0]);
  const ext = clean.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || '';
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The content type an attachment declares, if any (VS Code puts it in `_meta`). */
export function attachmentType(a) {
  return String(a?.contentType || a?._meta?.contentType || a?._meta?.['vscode.agentHost.snapshotAttachment']?.contentType || '');
}

/** Whether an attachment is a picture the app can show. */
export function isImageAttachment(a) {
  if (!a) return false;
  if (a.type === 'embeddedResource') {
    if (typeof a.data !== 'string' || !a.data) return false;
  } else if (a.type === 'resource') {
    if (typeof a.uri !== 'string' || !a.uri) return false;
  } else {
    return false;
  }
  const type = attachmentType(a);
  if (type) return /^image\//i.test(type);
  return a.displayKind === 'image' || !!mimeFromName(a.uri) || !!mimeFromName(a.label);
}

/**
 * A message's attachments split into pictures (shown as thumbnails) and the rest (shown as chips),
 * without the context VS Code adds on its own (open browser pages, the workspace) and without the
 * note that travels next to a photo from the phone.
 */
export function splitAttachments(message) {
  const all = Array.isArray(message?.attachments) ? message.attachments : [];
  const images = all.filter(isImageAttachment);
  const pictured = new Set(images.map((a) => a.label).filter(Boolean));
  const others = all.filter((a) => a && !isImageAttachment(a)
    && !(a.type === 'simple' && /browser pages|workspace/i.test(a.label || ''))
    && !(a.type === 'simple' && pictured.has(a.label)));
  return { images, others };
}

/** The image type of some bytes, from their first bytes (the extension can be wrong), or ''. */
export function sniffImageType(bytes) {
  const b = bytes;
  if (!b || b.length < 4) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
    if (/^(hei[cmsx]|hev[cmsx]|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  const head = new TextDecoder().decode(b.subarray(0, 512)).replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return '';
}

export function base64ToBytes(data) {
  const bin = atob(String(data || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** What the viewer says when a picture can't be loaded. */
export function pictureError(err) {
  const msg = String(err?.message || err || '');
  if (/outside your session folders|not (allowed|supported)|MethodNotFound|-32601/i.test(msg)) return 'Update Pocket Pilot on your computer to see the pictures sent in chats.';
  if (/too large/i.test(msg)) return 'This picture is too large to show here.';
  if (/not a picture/i.test(msg)) return 'This file isn\'t a picture the app can show.';
  if (/not found|ENOENT|-32008/i.test(msg)) return 'This picture is no longer on your computer.';
  return msg || 'The picture could not be loaded.';
}

// Loaded pictures, most recently used last. Each holds a blob: URL, released when it drops out.
const MAX_CACHED = 48;
const cache = new Map();

function cacheKey(att) {
  if (att.type === 'resource') return `r:${att.uri}`;
  const d = att.data;
  return `e:${att.label || ''}:${d.length}:${d.slice(0, 48)}:${d.slice(-48)}`;
}

/**
 * Loads a picture attachment and resolves to `{ url, type, size }` with a blob: URL for <img>.
 * `read(uri)` fetches a `resource` from the PC (resourceRead with base64). Results are cached.
 */
export function loadPicture(att, read) {
  const key = cacheKey(att);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = (async () => {
    let data = att.data;
    let declared = attachmentType(att);
    if (att.type === 'resource') {
      const r = await read(att.uri);
      if (!r || typeof r.data !== 'string') throw new Error('The picture could not be loaded');
      if (r.encoding !== 'base64') throw new Error('Not a picture');
      data = r.data;
      declared = r.contentType || declared;
    }
    const bytes = base64ToBytes(data);
    const type = sniffImageType(bytes) || (/^image\//i.test(declared) ? declared : '') || mimeFromName(att.uri || att.label);
    if (!type) throw new Error('Not a picture');
    return { url: URL.createObjectURL(new Blob([bytes], { type })), type, size: bytes.length };
  })();
  cache.set(key, p);
  p.catch(() => {
    if (cache.get(key) === p) cache.delete(key);
  });
  while (cache.size > MAX_CACHED) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey);
    old.then((v) => URL.revokeObjectURL(v.url), () => {});
  }
  return p;
}

/** For tests: forget every loaded picture. */
export function clearPictures() {
  for (const p of cache.values()) p.then((v) => URL.revokeObjectURL(v.url), () => {});
  cache.clear();
}
