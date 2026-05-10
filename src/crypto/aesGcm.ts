// AES-256-GCM authenticated encryption.
//
// Wire format (returned by `encrypt`, accepted by `decrypt`):
//
//   [0..11]   12-byte nonce (random / unique per encryption)
//   [12..]    AES-GCM ciphertext + 16-byte auth tag (concatenated by
//             @noble/ciphers' gcm())
//
// We prepend the nonce so the on-disk vault carries everything decrypt
// needs alongside the salt + KDF params. The nonce is not secret.
//
// `decrypt` distinguishes between "wrong key" (auth tag mismatch) and
// "malformed input" (length or shape) so the caller can show the right
// message ("wrong PIN" vs "vault file corrupt").

import {gcm} from '@noble/ciphers/aes.js';
// encrypt() stays sync to avoid cascading async through every caller.
// The native CSPRNG would require an async hop; for a vault that
// encrypts once per save with a fresh KDF salt, the uniqueness-only
// nonce path is acceptable (nonce reuse only matters when the same
// key is used many times — see module header).
import {randomBytesSync} from './randomBytes';

export const NONCE_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
export const KEY_LENGTH_BYTES = 32;
const MIN_PAYLOAD_BYTES = NONCE_LENGTH_BYTES + TAG_LENGTH_BYTES;

export type DecryptResult =
  | {ok: true; plaintext: Uint8Array}
  | {ok: false; reason: 'wrong-key' | 'malformed'};

const assertKey = (key: Uint8Array): void => {
  if (!(key instanceof Uint8Array) || key.length !== KEY_LENGTH_BYTES) {
    throw new RangeError(
      `aesGcm: key must be a Uint8Array of length ${KEY_LENGTH_BYTES}`,
    );
  }
};

export const encrypt = (key: Uint8Array, plaintext: Uint8Array): Uint8Array => {
  assertKey(key);
  if (!(plaintext instanceof Uint8Array)) {
    throw new TypeError('aesGcm.encrypt: plaintext must be a Uint8Array');
  }
  const nonce = randomBytesSync(NONCE_LENGTH_BYTES);
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(NONCE_LENGTH_BYTES + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, NONCE_LENGTH_BYTES);
  return out;
};

export const decrypt = (key: Uint8Array, payload: Uint8Array): DecryptResult => {
  assertKey(key);
  if (!(payload instanceof Uint8Array) || payload.length < MIN_PAYLOAD_BYTES) {
    return {ok: false, reason: 'malformed'};
  }
  const nonce = payload.subarray(0, NONCE_LENGTH_BYTES);
  const ciphertext = payload.subarray(NONCE_LENGTH_BYTES);
  try {
    const plaintext = gcm(key, nonce).decrypt(ciphertext);
    return {ok: true, plaintext};
  } catch {
    // @noble/ciphers throws on tag mismatch. We can't reliably tell
    // tag-mismatch from "ciphertext length not a multiple of block size"
    // here (both surface as Error from the same call site), so we
    // collapse them into "wrong-key" — caller treats both as "the user
    // typed the wrong PIN, prompt again."
    return {ok: false, reason: 'wrong-key'};
  }
};
