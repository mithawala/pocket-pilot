// Whether a newer Pocket Pilot plugin is out. The GitHub Copilot app and CLI don't update this plugin
// by themselves, so `/pocket-pilot status` and the panel say so, with how to update.
import { FILES, readJson, writeJson } from './ipc.mjs';

const MARKETPLACE = 'https://raw.githubusercontent.com/mithawala/pocket-pilot/main/.github/plugin/marketplace.json';
const CHECK_EVERY = 12 * 3600 * 1000;

/** Whether version a is newer than b (major.minor.patch). */
export function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** The latest version known without asking GitHub ('' if none yet). */
export function cachedLatest() {
  return readJson(FILES.state, {})?.update?.version || '';
}

let checking = null;
/** The latest released version, asked of GitHub at most every 12 hours ('' when unknown). */
export function latestVersion({ fetchImpl = fetch } = {}) {
  const cached = readJson(FILES.state, {})?.update;
  if (process.env.POCKET_PILOT_UPDATE_CHECK === 'off') return Promise.resolve(cached?.version || '');
  if (cached?.version && Date.now() - cached.checkedAt < CHECK_EVERY) return Promise.resolve(cached.version);
  checking ??= (async () => {
    try {
      const res = await fetchImpl(MARKETPLACE, { signal: AbortSignal.timeout(5000) });
      const version = String((await res.json()).plugins?.find((p) => p.name === 'pocket-pilot')?.version || '');
      writeJson(FILES.state, { ...(readJson(FILES.state, {}) || {}), update: { checkedAt: Date.now(), version } });
      return version;
    } catch {
      return cached?.version || '';
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** { latest, current } when an update is available, else null. */
export function updateInfo(latest, current) {
  return latest && current && newer(latest, current) ? { latest, current } : null;
}

/** How to update, in words (for the chat and the panel). */
export function updateText({ latest, current }) {
  return `Pocket Pilot ${latest} is available (you have ${current}). Update it on the Plugins page of the GitHub Copilot app, or run \`copilot plugin update pocket-pilot@pocket-pilot\`. The new version takes over remote access by itself; paired devices reconnect within seconds.`;
}
