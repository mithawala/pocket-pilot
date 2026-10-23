// Files sent from a device to the PC: photos, screenshots and documents. The device prepares them (a
// picture becomes a JPEG at most 1600 px wide), the PC saves them in the session's folder
// (.pocket-pilot/uploads), and the message carries a note with the saved path for the agent, plus small
// pictures inline so the model sees them and the chat shows them.
import { b64 } from '../core/bytes.js';

export const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_INLINE_PICTURE = 3 * 1024 * 1024;
// The picture formats models take inline; others (HEIC, SVG…) the browser couldn't convert go as files only.
const MODEL_PICTURE = /^image\/(png|jpeg|gif|webp)$/i;

async function toJpeg(file, maxDim = 1600, quality = 0.85) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return null;
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * A file ready to upload: `{ name, mime, data (base64), size, picture }`. Pictures the browser can read
 * become JPEGs; anything else keeps its name and type. `picture` is set when the model can see it inline.
 * Throws when the file is larger than 20 MB.
 */
export async function prepareFile(file, { convert = toJpeg } = {}) {
  if (file.size > MAX_UPLOAD) throw new Error(`${file.name || 'This file'} is larger than 20 MB`);
  const jpeg = /^image\//.test(file.type) ? await convert(file) : null;
  const bytes = jpeg || new Uint8Array(await file.arrayBuffer());
  const name = jpeg && !/\.jpe?g$/i.test(file.name || '') ? `${(file.name || '').replace(/\.[^.]+$/, '') || 'photo'}.jpg` : file.name || 'upload';
  return { name, mime: jpeg ? 'image/jpeg' : file.type || 'application/octet-stream', data: b64(bytes), size: bytes.length, picture: !!jpeg || MODEL_PICTURE.test(file.type) };
}

/** Where the user is, as the agent reads it: a phone, or another computer with a mouse. */
export function senderDevice() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches ? 'other computer' : 'phone';
}

/**
 * The message attachments for a file the PC saved at `path`: a note for the agent with the path (the
 * Copilot app plugin turns it into a file attachment), and a small picture inline.
 */
export function attachmentItems(file, path, from = senderDevice()) {
  const items = [{ type: 'simple', label: file.name, modelRepresentation: `The user sent a file from their ${from} (Pocket Pilot). It is saved on this machine at: ${path}` }];
  if (file.picture && file.size < MAX_INLINE_PICTURE) items.push({ type: 'embeddedResource', label: file.name, data: file.data, contentType: file.mime });
  return items;
}

/** Uploads a prepared file into the session's folder on the PC and returns its message attachments. */
export async function uploadFile(conn, sessionUri, file) {
  const saved = await conn.upload({ session: sessionUri, name: file.name, mime: file.mime, data: file.data });
  return attachmentItems(file, saved.path);
}

/** How a file waiting to be sent shows in the input: its picture, if it is one. */
export function previewItems(file) {
  return file.picture && file.size < MAX_INLINE_PICTURE ? [{ type: 'embeddedResource', label: file.name, data: file.data, contentType: file.mime }] : [];
}

/**
 * The words for a message of just files (`pictures`: for each file, whether it's a picture). Agents take
 * a message with words, and the Copilot app plugin turns one without them away.
 */
export function filesOnlyText(pictures) {
  const all = pictures.every(Boolean);
  if (pictures.length === 1) return all ? 'Take a look at this picture.' : 'Take a look at this file.';
  return all ? 'Take a look at these pictures.' : 'Take a look at these files.';
}

/**
 * The files pasted into an input (a screenshot, copied files), named "Pasted image", "Pasted image 2"…
 * after `taken` earlier ones; null when the paste is text, which stays text.
 */
export function pastedFiles(clipboardData, taken = 0) {
  const files = [...(clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length || (clipboardData.getData('text/plain') || '').trim()) return null;
  let n = taken;
  return files.map((f) => {
    if (!/^image\//.test(f.type) || (f.name && !/^image\.\w+$/i.test(f.name))) return f;
    n++;
    return new File([f], `Pasted image${n > 1 ? ` ${n}` : ''}.${f.type.split('/')[1] || 'png'}`, { type: f.type });
  });
}
