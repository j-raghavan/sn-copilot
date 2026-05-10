// PBKDF2-SHA256 key derivation for the encrypted vault.
//
// We use PBKDF2 (not Argon2) because:
//   - Argon2's memory-hardness is wasted on a 6-digit PIN (the brute-
//     force search space is the limit, not GPU vs CPU advantage).
//   - Pure-JS Argon2 with realistic memory cost is too slow on an
//     A6X-class CPU and uses tens of MB of RAM, which Hermes won't
//     thank us for on an e-ink device.
//   - PBKDF2 via @noble/hashes is well-audited, ~10–30KB bundle.
//
// Iteration count: 50,000. On Supernote A6X-class hardware the
// pure-JS PBKDF2 runs at roughly 5–10k iters/sec, so an unlock takes
// 5–10 seconds — slow but bearable, with the UI thread kept
// responsive by `pbkdf2Async`'s periodic event-loop yields. Picking a
// higher count without measuring caused the 2026-05-10 "stuck on
// Continue" hang (sync `pbkdf2` blocked the bridge for ~30s; logcat
// showed 40s of JS silence after the randomBytes warning).
//
// For a 6-digit PIN (~10^6 search space) with 50k iters, an offline
// attacker who exfiltrates the .enc file still needs ~14 hours to
// brute-force it on commodity hardware — adequate for the threat
// model (a casual co-installed plugin reading the file). PIN entropy
// is the real bottleneck; cranking iters higher hurts UX without
// meaningfully improving safety.

import {pbkdf2Async} from '@noble/hashes/pbkdf2.js';
import {sha256} from '@noble/hashes/sha2.js';
import {encodeUtf8} from '../sdk/utf8';

export const DEFAULT_PBKDF2_ITERATIONS = 50_000;
export const KEY_LENGTH_BYTES = 32; // AES-256
export const SALT_LENGTH_BYTES = 16;
// How long pbkdf2Async runs synchronously between event-loop yields.
// 50ms is short enough to keep the UI responsive (one frame at 20fps)
// and long enough to amortize the yield overhead.
const ASYNC_TICK_MS = 50;

export type KdfParams = {
  iterations: number;
};

export const DEFAULT_KDF_PARAMS: Readonly<KdfParams> = Object.freeze({
  iterations: DEFAULT_PBKDF2_ITERATIONS,
});

export const deriveKey = async (
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Uint8Array> => {
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
  return pbkdf2Async(sha256, encodeUtf8(passphrase), salt, {
    c: params.iterations,
    dkLen: KEY_LENGTH_BYTES,
    asyncTick: ASYNC_TICK_MS,
  });
};
