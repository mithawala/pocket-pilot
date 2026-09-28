'use strict';
// Minimal WebAuthn relying-party verification (ES256 / P-256 only), done locally by the extension.
// The PWA registers a platform passkey (Face ID / Touch ID / fingerprint / Windows Hello) during
// pairing; later connections can be required to present a fresh user-verified assertion.
const crypto = require('crypto');

const unb64u = (s) => Buffer.from(String(s), 'base64url');
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_AT = 0x40;

class WebAuthnError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

function fail(msg) {
  throw new WebAuthnError(msg);
}

function parseClientData(b64) {
  const raw = unb64u(b64);
  let json;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('clientDataJSON is not valid JSON');
  }
  return { raw, json };
}

function parseAuthData(b64) {
  const buf = unb64u(b64);
  if (buf.length < 37) fail('authenticatorData too short');
  const out = {
    rpIdHash: buf.subarray(0, 32),
    flags: buf[32],
    signCount: buf.readUInt32BE(33),
    raw: buf,
  };
  if (out.flags & FLAG_AT) {
    if (buf.length < 55) fail('attested credential data truncated');
    const len = buf.readUInt16BE(53);
    if (buf.length < 55 + len) fail('credential id truncated');
    out.aaguid = buf.subarray(37, 53).toString('hex');
    out.credentialId = buf.subarray(55, 55 + len);
  }
  return out;
}

function checkCommon(clientData, type, challenge, allowedOrigins) {
  if (clientData.json.type !== type) fail(`unexpected clientData.type ${clientData.json.type}`);
  if (clientData.json.challenge !== challenge) fail('challenge mismatch');
  if (!allowedOrigins.includes(clientData.json.origin)) fail(`origin not allowed: ${clientData.json.origin}`);
  if (clientData.json.crossOrigin === true) fail('cross-origin ceremony not allowed');
  return new URL(clientData.json.origin).hostname;
}

function checkFlags(authData, requireUserVerification) {
  if (!(authData.flags & FLAG_UP)) fail('user presence flag not set');
  if (requireUserVerification && !(authData.flags & FLAG_UV)) fail('user verification (biometric/PIN) was not performed');
}

/**
 * @param {{id:string, clientDataJSON:string, authenticatorData:string, publicKey:string, publicKeyAlgorithm:number}} resp
 * @param {{challenge:string, allowedOrigins:string[], requireUserVerification?:boolean}} opts
 */
function verifyRegistration(resp, { challenge, allowedOrigins, requireUserVerification = true }) {
  if (!resp || typeof resp !== 'object') fail('missing registration response');
  const clientData = parseClientData(resp.clientDataJSON);
  const rpId = checkCommon(clientData, 'webauthn.create', challenge, allowedOrigins);
  const authData = parseAuthData(resp.authenticatorData);
  if (!authData.rpIdHash.equals(sha256(rpId))) fail('rpId hash mismatch');
  checkFlags(authData, requireUserVerification);
  if (!authData.credentialId) fail('no attested credential data');
  if (!authData.credentialId.equals(unb64u(resp.id))) fail('credential id mismatch');
  if (resp.publicKeyAlgorithm !== -7 && resp.publicKeyAlgorithm !== -257) fail('only ES256 and RS256 passkeys are supported');
  let key;
  try {
    key = crypto.createPublicKey({ key: unb64u(resp.publicKey), format: 'der', type: 'spki' });
  } catch {
    fail('invalid public key');
  }
  const isEc = resp.publicKeyAlgorithm === -7;
  if (isEc && (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')) fail('public key is not P-256');
  if (!isEc && (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048)) fail('RSA key must be at least 2048 bits');
  return {
    credentialId: resp.id,
    publicKey: resp.publicKey,
    algorithm: resp.publicKeyAlgorithm,
    rpId,
    origin: clientData.json.origin,
    signCount: authData.signCount,
    backupEligible: !!(authData.flags & FLAG_BE),
    aaguid: authData.aaguid,
  };
}

/**
 * @param {{id:string, clientDataJSON:string, authenticatorData:string, signature:string}} resp
 * @param {{challenge:string, allowedOrigins:string[], credential:{credentialId:string, publicKey:string, rpId:string, signCount:number}, requireUserVerification?:boolean}} opts
 */
function verifyAssertion(resp, { challenge, allowedOrigins, credential, requireUserVerification = true }) {
  if (!resp || typeof resp !== 'object') fail('missing assertion');
  if (!credential) fail('no passkey registered for this device');
  if (resp.id !== credential.credentialId) fail('unknown credential');
  const clientData = parseClientData(resp.clientDataJSON);
  const rpId = checkCommon(clientData, 'webauthn.get', challenge, allowedOrigins);
  if (rpId !== credential.rpId) fail('passkey was registered for a different site');
  const authData = parseAuthData(resp.authenticatorData);
  if (!authData.rpIdHash.equals(sha256(rpId))) fail('rpId hash mismatch');
  checkFlags(authData, requireUserVerification);
  const key = crypto.createPublicKey({ key: unb64u(credential.publicKey), format: 'der', type: 'spki' });
  const signed = Buffer.concat([authData.raw, sha256(clientData.raw)]);
  const ok = key.asymmetricKeyType === 'rsa'
    ? crypto.verify('sha256', signed, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, unb64u(resp.signature))
    : crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, unb64u(resp.signature));
  if (!ok) fail('signature verification failed');
  const prev = credential.signCount || 0;
  if ((authData.signCount !== 0 || prev !== 0) && authData.signCount <= prev) fail('signature counter did not increase (possible cloned authenticator)');
  return { signCount: authData.signCount };
}

module.exports = { verifyRegistration, verifyAssertion, WebAuthnError };
