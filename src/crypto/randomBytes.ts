// Entropy source for KDF salts and AES-GCM nonces.
//
// Three execution paths, in preference order:
//
//   1. **Native (preferred)**: CopilotOverlay.cryptoRandomBytes →
//      java.security.SecureRandom. Real entropy from the OS CSPRNG.
//
//   2. **WebCrypto**: globalThis.crypto.getRandomValues. Available on
//      modern Hermes / browsers / node — but Supernote firmware does
//      not provide it, so this branch is mostly for the Jest test
//      environment.
//
//   3. **Uniqueness-only fallback**: a counter + Date.now + a per-
//      process spread derived from Math.random at module init.
//      Acceptable for salts/nonces (they need uniqueness, not
//      secrecy) but NOT for any other security purpose. Documented
//      in the function header.
//
// The async `randomBytes` is the only export that should be used by
// new code. `randomBytesSync` is kept around for the rare case where
// a sync API is unavoidable (test fixtures, etc.) and falls through
// the WebCrypto + JS-only paths only.

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
        'for salts/nonces. This does not weaken vault confidentiality (see module header).',
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

// Async path — the production entrypoint. Tries the native bridge
// first (true CSPRNG), then falls through to WebCrypto, then to the
// JS-only uniqueness generator.
export const randomBytes = async (length: number): Promise<Uint8Array> => {
  validateLength(length);
  const native = await CopilotOverlay.cryptoRandomBytes(length);
  if (native.success && typeof native.bytesB64 === 'string') {
    const bytes = base64ToBytes(native.bytesB64);
    if (bytes.length === length) {
      return bytes;
    }
  }
  return randomBytesSync(length);
};

// Sync escape hatch — used by tests and by the JS-only paths above.
// Skips the native bridge (it's async) but otherwise mirrors the
// fallback chain.
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
