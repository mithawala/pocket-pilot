export const S = { Idle: 1, Error: 2, InProgress: 8, Input: 16, IsRead: 32, IsArchived: 64 };
export const has = (s, bit) => ((s || 0) & bit) === bit;

export function statusOf(status) {
  if (has(status, S.Input)) return { key: 'input', label: 'Needs you', tone: 'warn' };
  if (has(status, S.InProgress)) return { key: 'running', label: 'Working', tone: 'busy' };
  if (has(status, S.Error)) return { key: 'error', label: 'Error', tone: 'err' };
  return { key: 'idle', label: 'Idle', tone: 'idle' };
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

export function deviceDescription() {
  const ua = navigator.userAgent;
  const os = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /mac os/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : 'Device';
  const browser = /edg\//i.test(ua) ? 'Edge' : /crios|chrome/i.test(ua) ? 'Chrome' : /fxios|firefox/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Browser';
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
