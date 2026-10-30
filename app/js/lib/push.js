// Web Push subscription helpers. The PC sends pushes directly to the browser vendor's push service.
import { unb64u, b64u } from '../core/bytes.js';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** "iPad" or "iPhone", for wording (iPadOS reports itself as a Mac with touch). */
export function appleDevice() {
  return /ipad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : 'iPhone';
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

/**
 * Whether this is a browser whose Home Screen app keeps its own storage (iPhone and iPad): a pairing
 * made in the browser doesn't carry over to the app, so the app should be added before pairing.
 */
export function pairInHomeScreenApp() {
  return isIos() && !isStandalone();
}

/** iOS only delivers web push to apps added to the Home Screen. */
export function pushBlockedReason() {
  if (isIos() && !isStandalone()) return 'ios-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Subscribes (or re-uses a matching subscription) for the host's VAPID key. */
export async function subscribe(vapidPublicKey) {
  const reg = await navigator.serviceWorker.ready;
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed');
  const key = unb64u(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const existing = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (!existing || b64u(existing) !== vapidPublicKey) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}
