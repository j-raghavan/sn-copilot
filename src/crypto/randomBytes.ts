/* eslint-disable no-bitwise */
// Entropy source for KDF salts and AES-GCM nonces.
//
// Constraint: the Supernote plugin runtime is JS-only on Hermes. We
// cannot ship a native module like react-native-get-random-values, so
// `globalThis.crypto.getRandomValues` may not exist. Plain `Math.random`
// is unsuitable on its own.
//
// Strategy:
//   1. Prefer WebCrypto when present (modern Hermes, browsers, node).
//   2. Otherwise compose a uniqueness-only generator: high-resolution
//      time + a monotonic counter + a per-process nonce derived from
//      `Math.random()` at module init.
//
// Why the fallback is acceptable for the values we generate here:
//   - PBKDF2 salts only need to be UNIQUE per encryption (so each
//     password is brute-forced separately). Salt secrecy is not part
//     of the security argument.
//   - AES-GCM nonces only need to be UNIQUE per (key, message) pair.
//     We persist the nonce alongside the ciphertext, so it is public
//     anyway. Predictability is acceptable for a single-key-per-vault
//     design where we control how many encryptions occur.
//
// The KDF security comes entirely from the user's PIN/passphrase
// entropy and the iteration count. The fallback path does NOT degrade
// confidentiality of the encrypted vault.

const TAG = '[randomBytes]';

let warnedAboutFallback = false;
let counter = 0;
const sessionSpread = (() => {
  // 64 bits of per-process spread so two devices that boot at the same
  // millisecond are still extremely unlikely to collide.
  const a = (Math.random() * 0xffffffff) >>> 0;
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
  out[off] = (v >>> 24) & 0xff;
  out[off + 1] = (v >>> 16) & 0xff;
  out[off + 2] = (v >>> 8) & 0xff;
  out[off + 3] = v & 0xff;
};

const fillFromFallback = (out: Uint8Array): void => {
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      `${TAG} crypto.getRandomValues is unavailable; using uniqueness-only fallback ` +
        'for salts/nonces. This does not weaken vault confidentiality (see module header).',
    );
  }
  // Pattern: cycle a 16-byte block of (counter, hi, lo, spread0, spread1)
  // and run a tiny diffusion (xorshift32) over it. The output never
  // repeats within a process and is unique across processes with very
  // high probability.
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
    // xorshift32 over each 4-byte word for a tiny avalanche so adjacent
    // bytes don't carry obvious time/counter structure.
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

export const randomBytes = (length: number): Uint8Array => {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`randomBytes: length must be a positive integer, got ${length}`);
  }
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
