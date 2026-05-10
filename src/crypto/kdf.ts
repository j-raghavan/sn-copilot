// PBKDF2-SHA256 key derivation for the encrypted vault.
//
// Two execution paths:
//
//   1. **Native (preferred)**: CopilotOverlay.cryptoPbkdf2Sha256 →
//      JDK SecretKeyFactory("PBKDF2WithHmacSHA256"). Sub-100ms even
//      at 200k iterations on Supernote A6X. This is the production
//      path.
//
//   2. **Pure-JS fallback**: @noble/hashes pbkdf2. Used when the
//      native module isn't registered (Jest tests, or if the host
//      ever stops bundling our overlay package). Brutally slow on
//      Hermes — measured ~400 iters/sec — so the pure-JS path uses
//      a dedicated, much lower iteration count to stay under ~10s.
//
// History: an earlier version used pure-JS at 200k iters and hung
// the bridge for ~130s on first-time PIN setup (logcat 2026-05-10).
// The native path eliminates the hang AND lets us run a security-
// reasonable iter count (100k → ~14h offline brute-force on a
// 6-digit PIN at 100M ops/sec on commodity hardware).
//
// We use PBKDF2 (not Argon2) because Argon2's memory-hardness is
// wasted on a 6-digit PIN (the small search space is the limit, not
// GPU advantage), pure-JS Argon2 is too slow on Hermes, and PBKDF2
// is mandatory in Android since API 26.

import {pbkdf2} from '@noble/hashes/pbkdf2.js';
import {sha256} from '@noble/hashes/sha2.js';
import {encodeUtf8} from '../sdk/utf8';
import CopilotOverlay from '../native/CopilotOverlay';

// Production iter count. Validated by the JDK PBKDF2 path running in
// well under 100ms; if you change this, also update the readVault
// path in `vault.ts` which honours the iter count stored in the
// envelope (so old vaults still decrypt).
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
// Fallback iter count for the pure-JS path. Picked to keep the
// bridge-blocked window under ~10s on the worst observed Hermes
// throughput (~400 iters/sec on Supernote A6X). Existing vaults
// written under this iter count would be weaker; documented.
export const FALLBACK_PBKDF2_ITERATIONS = 4_000;
export const KEY_LENGTH_BYTES = 32; // AES-256
export const SALT_LENGTH_BYTES = 16;

export type KdfParams = {
  iterations: number;
};

export const DEFAULT_KDF_PARAMS: Readonly<KdfParams> = Object.freeze({
  iterations: DEFAULT_PBKDF2_ITERATIONS,
});

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return globalThis.btoa(bin);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
};

const validate = (
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
): void => {
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
};

export const deriveKey = async (
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Uint8Array> => {
  validate(passphrase, salt, params);
  const passwordBytes = encodeUtf8(passphrase);
  // Try native first. The result.success === false branch falls
  // through to pure-JS so the unit suite (no native module) still
  // runs and we degrade gracefully on hosts that don't expose the
  // crypto bridge.
  const native = await CopilotOverlay.cryptoPbkdf2Sha256(
    bytesToBase64(passwordBytes),
    bytesToBase64(salt),
    params.iterations,
    KEY_LENGTH_BYTES,
  );
  if (native.success && typeof native.bytesB64 === 'string') {
    return base64ToBytes(native.bytesB64);
  }
  return pbkdf2(sha256, passwordBytes, salt, {
    c: params.iterations,
    dkLen: KEY_LENGTH_BYTES,
  });
};
