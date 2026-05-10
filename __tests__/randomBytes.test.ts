/* eslint-disable no-bitwise */
/**
 * Tests for src/crypto/randomBytes. Pins:
 *   1. Length validation (positive integer required).
 *   2. WebCrypto path: when globalThis.crypto.getRandomValues exists,
 *      we use it.
 *   3. Fallback path: when WebCrypto is absent, output is unique per
 *      call within a process; warns once.
 *   4. Output length always matches request.
 */
import {randomBytes, __testing__} from '../src/crypto/randomBytes';

const originalCrypto = (globalThis as {crypto?: unknown}).crypto;

const setCrypto = (impl: unknown): void => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: impl,
  });
};

beforeEach(() => {
  __testing__.resetWarnedFlag();
});

afterEach(() => {
  setCrypto(originalCrypto);
  jest.restoreAllMocks();
});

describe('randomBytes — input validation', () => {
  it.each([0, -1, 1.5, NaN])('rejects non-positive-integer length %p', (n) => {
    expect(() => randomBytes(n as number)).toThrow(/positive integer/);
  });

  it('returns a Uint8Array of the requested length', () => {
    const out = randomBytes(12);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(12);
  });
});

describe('randomBytes — WebCrypto path', () => {
  it('delegates to globalThis.crypto.getRandomValues when available', () => {
    const spy = jest.fn((buf: Uint8Array) => {
      for (let i = 0; i < buf.length; i++) {
        buf[i] = (i * 7) & 0xff;
      }
      return buf;
    });
    setCrypto({getRandomValues: spy});
    const out = randomBytes(16);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(7);
    expect(out[2]).toBe(14);
  });

  it('chunks WebCrypto calls under the 65_536-byte quota', () => {
    const spy = jest.fn((buf: Uint8Array) => buf);
    setCrypto({getRandomValues: spy});
    randomBytes(70_000);
    // 70_000 = 65_536 + 4_464 → two calls.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('randomBytes — fallback path', () => {
  beforeEach(() => {
    setCrypto(undefined);
  });

  it('emits a one-time warning when WebCrypto is absent', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    randomBytes(16);
    randomBytes(16);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/crypto.getRandomValues is unavailable/);
  });

  it('returns unique output across consecutive calls', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const out = randomBytes(16);
      seen.add(Buffer.from(out).toString('hex'));
    }
    expect(seen.size).toBe(64);
  });

  it('produces output of any length, including non-block-aligned', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(randomBytes(1).length).toBe(1);
    expect(randomBytes(7).length).toBe(7);
    expect(randomBytes(20).length).toBe(20);
    expect(randomBytes(33).length).toBe(33);
  });

  it('rejects malformed crypto object (subtle present, getRandomValues missing)', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    setCrypto({subtle: {}});
    const out = randomBytes(16);
    expect(out.length).toBe(16);
  });
});
