// Entropy source for KDF salts and AES-GCM nonces.
//
// Two functions, two policies:
//
//   - `randomBytes` (async): the production entrypoint for ANY caller
//     that wants real entropy (KDF salts). Calls
//     CopilotOverlay.cryptoRandomBytes → java.security.SecureRandom.
//     If the native bridge isn't available, throws — same reasoning
//     as kdf.ts: a silent fallback would mask a packaging regression
//     and downgrade us to the uniqueness-only generator without the
//     caller realizing it. SecureRandom is a JDK guarantee on every
//     Android API we support.
//
//   - `randomBytesSync`: kept for the rare site that genuinely cannot
//     await — currently only AES-GCM nonce generation in
//     `aesGcm.encrypt`, where the rest of the call chain is sync.
//     Tries WebCrypto, falls back to a uniqueness-only generator.
//     The fallback is acceptable for nonces (they need uniqueness,
//     not secrecy — they're stored alongside the ciphertext and the
//     PIN-derived key is what protects the payload). It's NOT
//     acceptable for KDF salts under serious attack, which is why
//     KDF salts go through the async path.
//
// Tests mock CopilotOverlay.cryptoRandomBytes via
// __tests__/helpers/cryptoMockImpl.ts so async randomBytes works
// under jest without dragging the JS-only chain through production.

import CopilotOverlay from '../native/CopilotOverlay';

const TAG = '[randomBytes]';

let warnedAboutFallback = false;
let counter = 0;
const sessionSpread = (() => {
  // 64 bits of per-process spread so two devices that boot at the same
  // millisecond are still extremely unlikely to collide.
  // eslint-disable-next-line no-bitwise
  const a = (Math.random() * 0xffffffff) >>> 0;
  // eslint-disable-next-line no-bitwise
  const b = (Math.random() * 0xffffffff) >>> 0;
  return [a, b] as const;
})();

const hasWebCrypto = (): boolean => {
  const cr =
    typeof globalThis === 'object'
      ? (globalThis as {crypto?: {getRandomValues?: unknown}}).crypto
      : undefined;
  return typeof cr?.getRandomValues === 'function';
};

const fillFromWebCrypto = (out: Uint8Array): void => {
  // Splitting at 65_536 keeps us within the WebCrypto Level-2 quota
  // (single-call limit). Our callers ask for 12–32 bytes, so the loop
  // runs once in practice; the chunking is defensive.
  const cr = (
    globalThis as {crypto: {getRandomValues: (buf: Uint8Array) => Uint8Array}}
  ).crypto;
  const CHUNK = 65_536;
  for (let off = 0; off < out.length; off += CHUNK) {
    const slice = out.subarray(off, Math.min(off + CHUNK, out.length));
    cr.getRandomValues(slice);
  }
};

const writeUint32BE = (out: Uint8Array, off: number, v: number): void => {
  // eslint-disable-next-line no-bitwise
  out[off] = (v >>> 24) & 0xff;
  // eslint-disable-next-line no-bitwise
  out[off + 1] = (v >>> 16) & 0xff;
  // eslint-disable-next-line no-bitwise
  out[off + 2] = (v >>> 8) & 0xff;
  // eslint-disable-next-line no-bitwise
  out[off + 3] = v & 0xff;
};

/* eslint-disable no-bitwise */
const fillFromFallback = (out: Uint8Array): void => {
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      `${TAG} crypto.getRandomValues is unavailable; using uniqueness-only fallback ` +
        'for sync random (AES-GCM nonces). This does not weaken vault confidentiality (see module header).',
    );
  }
  const now = Date.now();
  const hi = Math.floor(now / 0x100000000) >>> 0;
  const lo = (now >>> 0) >>> 0;
  let off = 0;
  while (off < out.length) {
    counter = (counter + 1) >>> 0;
    const block = new Uint8Array(20);
    writeUint32BE(block, 0, counter);
    writeUint32BE(block, 4, hi);
    writeUint32BE(block, 8, lo);
    writeUint32BE(block, 12, sessionSpread[0]);
    writeUint32BE(block, 16, sessionSpread[1]);
    for (let w = 0; w < 5; w++) {
      let x =
        ((block[w * 4] << 24) |
          (block[w * 4 + 1] << 16) |
          (block[w * 4 + 2] << 8) |
          block[w * 4 + 3]) >>>
        0;
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      writeUint32BE(block, w * 4, x);
    }
    const take = Math.min(20, out.length - off);
    out.set(block.subarray(0, take), off);
    off += take;
  }
};
/* eslint-enable no-bitwise */

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
};

const validateLength = (length: number): void => {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`randomBytes: length must be a positive integer, got ${length}`);
  }
};

// Async path — the production entrypoint for KDF salts. Hard-fails
// when the native bridge is unavailable so a packaging regression
// surfaces as an error the user can act on, rather than silently
// downgrading.
export const randomBytes = async (length: number): Promise<Uint8Array> => {
  validateLength(length);
  const native = await CopilotOverlay.cryptoRandomBytes(length);
  if (!native.success || typeof native.bytesB64 !== 'string') {
    throw new Error(
      `randomBytes: native SecureRandom unavailable (${native.code}: ${native.message}). ` +
        'CopilotOverlayModule must expose cryptoRandomBytes — check the native build registration.',
    );
  }
  const bytes = base64ToBytes(native.bytesB64);
  if (bytes.length !== length) {
    throw new Error(
      `randomBytes: native SecureRandom returned ${bytes.length} bytes, expected ${length}`,
    );
  }
  return bytes;
};

// Sync escape hatch — used by AES-GCM nonce generation only.
// WebCrypto when present (modern Hermes / browsers / node), falls
// back to a uniqueness-only generator on Hermes-without-WebCrypto.
// Acceptable for nonces; do not use for anything that needs real
// entropy.
export const randomBytesSync = (length: number): Uint8Array => {
  validateLength(length);
  const out = new Uint8Array(length);
  if (hasWebCrypto()) {
    fillFromWebCrypto(out);
  } else {
    fillFromFallback(out);
  }
  return out;
};

// Test-only — lets the suite reset the warn flag between cases so the
// first-call assertion fires deterministically.
export const __testing__ = {
  resetWarnedFlag: (): void => {
    warnedAboutFallback = false;
  },
};
