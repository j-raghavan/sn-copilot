// PBKDF2-SHA256 key derivation for the encrypted vault.
//
// We use PBKDF2 (not Argon2) because:
//   - Argon2's memory-hardness is wasted on a 6-digit PIN (the brute-
//     force search space is the limit, not GPU vs CPU advantage).
//   - Pure-JS Argon2 with realistic memory cost is too slow on an
//     A6X-class CPU and uses tens of MB of RAM, which Hermes won't
//     thank us for on an e-ink device.
//   - PBKDF2 via @noble/hashes is well-audited, ~10–30KB bundle, and
//     tunable to ~300–500ms on the device.
//
// Iteration count is configurable so the on-device spike can land on
// a target unlock latency. The default is conservative; bump it after
// measuring on the actual hardware.

import {pbkdf2} from '@noble/hashes/pbkdf2.js';
import {sha256} from '@noble/hashes/sha2.js';

export const DEFAULT_PBKDF2_ITERATIONS = 200_000;
export const KEY_LENGTH_BYTES = 32; // AES-256
export const SALT_LENGTH_BYTES = 16;

export type KdfParams = {
  iterations: number;
};

export const DEFAULT_KDF_PARAMS: Readonly<KdfParams> = Object.freeze({
  iterations: DEFAULT_PBKDF2_ITERATIONS,
});

const utf8 = new TextEncoder();

export const deriveKey = (
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Uint8Array => {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new RangeError('deriveKey: passphrase must be a non-empty string');
  }
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_LENGTH_BYTES) {
    throw new RangeError(
      `deriveKey: salt must be a Uint8Array of length ${SALT_LENGTH_BYTES}`,
    );
  }
  if (!Number.isInteger(params.iterations) || params.iterations < 1) {
    throw new RangeError(
      `deriveKey: iterations must be a positive integer, got ${params.iterations}`,
    );
  }
  return pbkdf2(sha256, utf8.encode(passphrase), salt, {
    c: params.iterations,
    dkLen: KEY_LENGTH_BYTES,
  });
};
