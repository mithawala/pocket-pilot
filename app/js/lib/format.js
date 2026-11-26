export const S = { Idle: 1, Error: 2, InProgress: 8, Input: 16, IsRead: 32, IsArchived: 64 };
export const has = (s, bit) => ((s || 0) & bit) === bit;

export function statusOf(status) {
  if (has(status, S.Input)) return { key: 'input', label: 'Needs you', tone: 'warn' };
  if (has(status, S.InProgress)) return { key: 'running', label: 'Working', tone: 'busy' };
  if (has(status, S.Error)) return { key: 'error', label: 'Error', tone: 'err' };
  return { key: 'idle', label: 'Idle', tone: 'idle' };
}

const ACTIVITY = 31;

/**
 * A session's status as a person reads it: its main chat's activity, with "needs input" from any chat.
 * The protocol promotes an error in *any* chat (say, a sub-agent that failed long ago) to the whole
 * session. Same rule as the extension's session monitor (extension/core/monitor.js), which corrects
 * the statuses it sends; the app applies it too, for PCs that run an older extension.
 */
export function effectiveStatus(raw, state) {
  const chats = state?.chats || [];
  if (typeof raw !== 'number' || !chats.length) return raw;
  const main = chats.find((c) => c.resource === state.defaultChat) || [...chats].sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))[0];
  if (!main || typeof main.status !== 'number') return raw;
  let activity = main.status & ACTIVITY;
  if (chats.some((c) => typeof c.status === 'number' && (c.status & S.Input) === S.Input)) activity = S.Input;
  return (raw & ~ACTIVITY) | (activity || S.Idle);
}

export function ago(ts) {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 604800) return `${Math.round(s / 86400)}d`;
  return new Date(t).toLocaleDateString();
}

export function duration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function folderName(uri) {
  if (!uri) return '';
  try {
    const p = decodeURIComponent(new URL(uri).pathname).replace(/\/+$/, '');
    return p.split('/').pop() || p;
  } catch {
    return String(uri).split(/[\\/]/).filter(Boolean).pop() || '';
  }
}

export function filePath(uri) {
  try {
    return decodeURIComponent(new URL(uri).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
  } catch {
    return String(uri);
  }
}

export function providerLabel(p) {
  return { copilotcli: 'Copilot', copilot: 'Copilot', claude: 'Claude', codex: 'Codex' }[p] || (p ? p[0].toUpperCase() + p.slice(1) : 'Agent');
}

/** Where a paired PC's sessions live: VS Code (the extension) or the GitHub Copilot app/CLI (the plugin). */
export function hostApp(host) {
  return host?.hostKind === 'copilot' ? 'the GitHub Copilot app' : 'VS Code';
}

/**
 * The computer a host runs on, by its name: without the " · Copilot" the Copilot app plugin adds to it,
 * or the ".local" of a Mac's name.
 */
export function hostComputer(host) {
  return String(host?.hostName || '').replace(/\s*·\s*Copilot$/i, '').replace(/\.local$/i, '').trim() || 'Computer';
}

/** A paired computer's name before you give it your own: the computer, and the app it serves. */
export function defaultHostLabel(host) {
  return `${hostComputer(host)} · ${host?.hostKind === 'copilot' ? 'Copilot app' : 'VS Code'}`;
}

/**
 * What the app calls a paired computer: the name you gave it on this device, or its default name. One
 * computer paired from VS Code and from the GitHub Copilot app shows up twice, so the default tells
 * them apart.
 */
export function hostLabel(host) {
  return host?.customName || defaultHostLabel(host);
}

/** A name typed for a computer, tidied: one line, at most 60 characters ('' for the default name). */
export function cleanHostLabel(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
}

export function deviceDescription() {
  const ua = navigator.userAgent;
  const os = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /mac os/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : 'Device';
  const browser = /edg(ios|a)?\//i.test(ua) ? 'Edge' : /crios|chrome/i.test(ua) ? 'Chrome' : /fxios|firefox/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Browser';
  let model = '';
  const m = /Android [\d.]+; ([^;)]+)/.exec(ua);
  if (m && !/^K$/.test(m[1])) model = m[1].trim();
  return { name: model || os, platform: `${os} · ${browser}` };
}

export function haptic(pattern = 12) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

export function uuid() {
  return crypto.randomUUID();
}
