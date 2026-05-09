/**
 * Tests for src/scope/base64 — ArrayBuffer → base64 encoder.
 *
 * Pins:
 *   1. Empty buffer → empty string.
 *   2. Round-trip via atob matches the original bytes.
 *   3. Chunk-boundary safety: a buffer larger than the 0x8000 chunk
 *      size encodes correctly (no truncation, no "max call stack").
 */
import {arrayBufferToBase64} from '../src/scope/base64';

const bytesOf = (b64: string): Uint8Array => {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};

describe('arrayBufferToBase64', () => {
  it('returns empty string for empty buffer', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
  });

  it('round-trips a small ASCII byte sequence', () => {
    const src = new Uint8Array([0x68, 0x69, 0x21]); // "hi!"
    const out = arrayBufferToBase64(src.buffer);
    expect(out).toBe('aGkh');
    expect(Array.from(bytesOf(out))).toEqual(Array.from(src));
  });

  it('round-trips 256 contiguous byte values', () => {
    const src = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      src[i] = i;
    }
    const out = arrayBufferToBase64(src.buffer);
    expect(Array.from(bytesOf(out))).toEqual(Array.from(src));
  });

  it('handles a buffer larger than the chunk size (>32768 bytes)', () => {
    // 0x8000 + 100 bytes — straddles the chunk boundary. The encoder
    // must concatenate chunks correctly without dropping bytes.
    const N = 0x8000 + 100;
    const src = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      src[i] = i % 256;
    }
    const out = arrayBufferToBase64(src.buffer);
    const round = bytesOf(out);
    expect(round.length).toBe(N);
    expect(round[0]).toBe(0);
    expect(round[N - 1]).toBe((N - 1) % 256);
  });
});
