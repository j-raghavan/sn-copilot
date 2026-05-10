// PBKDF2-SHA256 key derivation for the encrypted vault.
//
// Single execution path: CopilotOverlay.cryptoPbkdf2Sha256 → JDK
// `SecretKeyFactory("PBKDF2WithHmacSHA256")`. Sub-100ms even at 200k
// iterations on Supernote A6X because the JDK delegates to the
// device's native crypto provider.
//
// We deliberately do NOT carry a pure-JS fallback. The earlier
// attempt (May 2026, commit eb5fa7e) had one — at the same iter
// count as the native path — which would have re-introduced a
// 4-minute UI freeze if the native bridge ever failed. Worse:
// silent. By throwing here we surface registration / packaging
// regressions immediately instead of papering over them with a
// trap. PBKDF2WithHmacSHA256 is mandatory in Android since API 26
// so the native call should never fail in production; if it does,
// fix the registration.
//
// In tests, the native bridge is mocked via
// __tests__/helpers/cryptoMockImpl.ts which delegates to noble's
// pbkdf2 — so test round-trips still work without dragging @noble
// into the production bundle.

import {encodeUtf8} from '../sdk/utf8';
import CopilotOverlay from '../native/CopilotOverlay';

// Production iter count. The JDK PBKDF2 path runs in well under
// 100ms even at 100k. vault.ts honours the iter count stored in
// each envelope, so old vaults written under different counts still
// decrypt at whatever they were written with.
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
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
  const native = await CopilotOverlay.cryptoPbkdf2Sha256(
    bytesToBase64(encodeUtf8(passphrase)),
    bytesToBase64(salt),
    params.iterations,
    KEY_LENGTH_BYTES,
  );
  if (!native.success || typeof native.bytesB64 !== 'string') {
    throw new Error(
      `deriveKey: native PBKDF2 unavailable (${native.code}: ${native.message}). ` +
        'CopilotOverlayModule must expose cryptoPbkdf2Sha256 — check the ' +
        'native build registration.',
    );
  }
  return base64ToBytes(native.bytesB64);
};
