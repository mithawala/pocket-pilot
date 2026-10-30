// Finds the PC's current tunnel URL after it changed (VS Code restart) via an encrypted secret gist.
import { unb64u, utf8, utf8d } from '../core/bytes.js';

const subtle = globalThis.crypto.subtle;
export const RENDEZVOUS_FILE = 'pocket-pilot.json';

async function decryptNote(note, keyB64u, hostId) {
  if (!note || note.v !== 1 || note.hid !== hostId || typeof note.iv !== 'string' || typeof note.ct !== 'string') return null;
  const key = await subtle.importKey('raw', unb64u(keyB64u), 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(note.iv), additionalData: utf8.encode(`pp-rdv1|${hostId}`) }, key, unb64u(note.ct));
  const data = JSON.parse(utf8d.decode(pt));
  if (typeof data.url !== 'string' || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(data.url)) return null;
  return data;
}

/**
 * @param {{gistId:string, owner?:string, key:string}} rendezvous  (from the host's welcome message)
 * @param {string} hostId
 * @returns {Promise<{url:string, ts:number}|null>}
 */
export async function lookupHostUrl(rendezvous, hostId, fetchImpl = globalThis.fetch) {
  if (!rendezvous?.gistId || !rendezvous.key) return null;
  const file = rendezvous.file || RENDEZVOUS_FILE;
  let content = null;
  try {
    const r = await fetchImpl(`https://api.github.com/gists/${encodeURIComponent(rendezvous.gistId)}`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (r.ok) {
      const j = await r.json();
      const f = j.files?.[file];
      if (f && !f.truncated) content = f.content;
    }
  } catch {
    /* rate limited or offline; try the raw CDN below */
  }
  if (!content && rendezvous.owner) {
    try {
      const r = await fetchImpl(`https://gist.githubusercontent.com/${encodeURIComponent(rendezvous.owner)}/${encodeURIComponent(rendezvous.gistId)}/raw/${file}?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) content = await r.text();
    } catch {
      /* ignore */
    }
  }
  if (!content) return null;
  try {
    return await decryptNote(JSON.parse(content), rendezvous.key, hostId);
  } catch {
    return null;
  }
}
