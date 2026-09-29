// Starts the app on the newest release. The service worker answers the app's files from its cache and only
// picks up a new release in the background, so a page could start on the previous release's code. index.html
// is always fetched fresh and loads this script with the release's name: if the service worker still serves an
// older release, switch to the new one first (once), then start.
const BUILD = 'pp-v1';

function askVersion(worker, ms) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ms);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data?.version || null);
    };
    try {
      worker.postMessage({ type: 'pp-version' }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function onNewestRelease() {
  const sw = navigator.serviceWorker;
  // Not stamped (local development), or no service worker in charge yet: this page came from the network.
  if (BUILD === 'pp-v1' || !sw?.controller) return true;
  // Service workers from before 0.6.3 don't answer at all.
  if ((await askVersion(sw.controller, 700)) === BUILD) return true;
  try {
    if (sessionStorage.getItem('pp:boot') === BUILD) return true; // tried once already: start rather than loop
    sessionStorage.setItem('pp:boot', BUILD);
  } catch {
    return true;
  }
  const reg = await sw.getRegistration();
  if (!reg) return true;
  const taken = new Promise((resolve) => sw.addEventListener('controllerchange', resolve, { once: true }));
  await reg.update().catch(() => {});
  await Promise.race([taken, new Promise((resolve) => setTimeout(resolve, 6000))]);
  location.reload();
  return false;
}

let start = true;
try {
  start = await onNewestRelease();
} catch (err) {
  console.warn('Release check failed', err);
}
if (start) await import('./main.js');
