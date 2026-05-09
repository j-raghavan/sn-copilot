// ArrayBuffer → base64 encoder.
//
// React Native polyfills `btoa`/`atob` on the global object, but those
// only handle binary strings (one char per byte). The chunked
// String.fromCharCode + btoa pattern below is the standard portable
// approach — keeps memory bounded for large PNGs (the alternative,
// String.fromCharCode(...bytes), blows the call-stack on 200K+ byte
// arrays).
//
// Chunk size of 0x8000 (32768) is a long-standing safe upper bound
// for `String.fromCharCode.apply` arg-list length on Hermes/V8/JSC.

const CHUNK = 0x8000;

export const arrayBufferToBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    // String.fromCharCode.apply is the chunked equivalent of the
    // (unsafe-for-large-arrays) spread `String.fromCharCode(...slice)`.
    binary += String.fromCharCode.apply(
      null,
      slice as unknown as number[],
    );
  }
  return globalThis.btoa(binary);
};
