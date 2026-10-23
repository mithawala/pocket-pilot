// Platform passkeys (Face ID / Touch ID / fingerprint / Windows Hello). The PC verifies them.
import { b64u, unb64u, utf8 } from '../core/bytes.js';

export async function passkeysAvailable() {
  try {
    return !!(window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()));
  } catch {
    return false;
  }
}

export const webauthn = {
  async register({ challenge, userId, userName, displayName }) {
    if (!window.PublicKeyCredential) throw new Error('Passkeys are not supported in this browser');
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Pocket Pilot', id: location.hostname },
        user: { id: utf8.encode(userId), name: userName, displayName: displayName || userName },
        challenge: unb64u(challenge),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
        timeout: 120000,
      },
    });
    const r = cred.response;
    const spki = typeof r.getPublicKey === 'function' ? r.getPublicKey() : null;
    if (!spki) throw new Error('This browser cannot export the passkey public key');
    return {
      id: b64u(new Uint8Array(cred.rawId)),
      clientDataJSON: b64u(new Uint8Array(r.clientDataJSON)),
      authenticatorData: b64u(new Uint8Array(r.getAuthenticatorData())),
      publicKey: b64u(new Uint8Array(spki)),
      publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
    };
  },

  async assert({ challenge, credentialId, rpId }) {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: unb64u(challenge),
        rpId: rpId || location.hostname,
        allowCredentials: [{ type: 'public-key', id: unb64u(credentialId) }],
        userVerification: 'required',
        timeout: 120000,
      },
    });
    const r = cred.response;
    return {
      id: b64u(new Uint8Array(cred.rawId)),
      clientDataJSON: b64u(new Uint8Array(r.clientDataJSON)),
      authenticatorData: b64u(new Uint8Array(r.authenticatorData)),
      signature: b64u(new Uint8Array(r.signature)),
    };
  },
};
