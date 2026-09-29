'use strict';
// Host identity + long-lived secrets. Private keys live only in the injected secret store
// (VS Code SecretStorage => OS keychain / DPAPI). Nothing here is ever sent to the phone except
// public keys and the rendezvous key (which only decrypts the tunnel-URL note in the gist).
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const push = require('./push');

const PWA_CORE = path.join(__dirname, '..', '..', 'pwa', 'js', 'core');
let scPromise;
let totpPromise;

/** Loads the isomorphic secure-channel ES module shared with the PWA. */
function loadSecureChannel() {
  if (!scPromise) scPromise = import(pathToFileURL(path.join(PWA_CORE, 'secure-channel.js')).href);
  return scPromise;
}

/** Loads the authenticator-app code (TOTP) module shared with the PWA. */
function loadTotp() {
  if (!totpPromise) totpPromise = import(pathToFileURL(path.join(PWA_CORE, 'totp.js')).href);
  return totpPromise;
}

const KEYS = {
  host: 'pocketPilot.hostIdentity.v1',
  vapid: 'pocketPilot.vapid.v1',
  rendezvous: 'pocketPilot.rendezvousKey.v1',
};

async function loadHostIdentity(secrets, name) {
  const sc = await loadSecureChannel();
  let rec = null;
  try {
    const raw = await secrets.get(KEYS.host);
    rec = raw ? JSON.parse(raw) : null;
  } catch {
    rec = null;
  }
  if (!rec || !rec.jwk || !rec.hostId) {
    const kp = await sc.generateKeyPair(true);
    rec = { jwk: await sc.exportPrivateJwk(kp.privateKey), hostId: crypto.randomBytes(12).toString('base64url'), createdAt: new Date().toISOString() };
    await secrets.store(KEYS.host, JSON.stringify(rec));
  }
  const keys = await sc.keyPairFromJwk(rec.jwk);
  const publicRaw = await sc.exportPublicKey(keys.publicKey);
  const fingerprint = await sc.fingerprint(publicRaw);
  return { hostId: rec.hostId, name, keys, publicRaw, fingerprint, createdAt: rec.createdAt };
}

async function loadVapid(secrets) {
  const raw = await secrets.get(KEYS.vapid);
  if (raw) {
    try {
      const rec = JSON.parse(raw);
      return { privateJwk: rec.privateJwk, publicKey: push.vapidPublicKey(rec.privateJwk) };
    } catch {
      /* regenerate */
    }
  }
  const v = push.generateVapidKeys();
  await secrets.store(KEYS.vapid, JSON.stringify({ privateJwk: v.privateJwk }));
  return v;
}

async function loadRendezvousKey(secrets) {
  const raw = await secrets.get(KEYS.rendezvous);
  if (raw) return Buffer.from(raw, 'base64url');
  const key = crypto.randomBytes(32);
  await secrets.store(KEYS.rendezvous, key.toString('base64url'));
  return key;
}

/** Deletes every secret: all paired phones must pair again afterwards. */
async function resetIdentity(secrets) {
  for (const k of Object.values(KEYS)) await secrets.delete(k);
}

function fingerprintText(fp) {
  return Buffer.from(fp).toString('hex').toUpperCase().match(/.{4}/g).slice(0, 4).join('-');
}

module.exports = { loadSecureChannel, loadTotp, loadHostIdentity, loadVapid, loadRendezvousKey, resetIdentity, fingerprintText };
