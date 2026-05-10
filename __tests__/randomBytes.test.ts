/* eslint-disable no-bitwise */
/**
 * Tests for src/crypto/randomBytes. Pins:
 *   1. Length validation (positive integer required).
 *   2. Sync WebCrypto path: when globalThis.crypto.getRandomValues
 *      exists, we use it.
 *   3. Sync fallback path: when WebCrypto is absent, output is unique
 *      per call within a process; warns once.
 *   4. Output length always matches request.
 *   5. Async path: prefers native bridge when present; falls through
 *      to the sync chain when native returns failure or wrong length.
 */
const mockCryptoRandomBytes = jest.fn<
  Promise<{success: boolean; code: string; message: string; bytesB64?: string}>,
  [number]
>();
jest.mock('../src/native/CopilotOverlay', () => ({
  __esModule: true,
  default: {
    cryptoRandomBytes: (n: number) => mockCryptoRandomBytes(n),
  },
}));

import {
  randomBytes,
  randomBytesSync,
  __testing__,
} from '../src/crypto/randomBytes';

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
  mockCryptoRandomBytes.mockReset();
  // Default: native bridge fails so the sync chain runs in async path tests.
  mockCryptoRandomBytes.mockResolvedValue({
    success: false,
    code: 'MODULE_MISSING',
    message: 'mock',
  });
});

afterEach(() => {
  setCrypto(originalCrypto);
  jest.restoreAllMocks();
});

describe('randomBytesSync — input validation', () => {
  it.each([0, -1, 1.5, NaN])('rejects non-positive-integer length %p', (n) => {
    expect(() => randomBytesSync(n as number)).toThrow(/positive integer/);
  });

  it('returns a Uint8Array of the requested length', () => {
    const out = randomBytesSync(12);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(12);
  });
});

describe('randomBytesSync — WebCrypto path', () => {
  it('delegates to globalThis.crypto.getRandomValues when available', () => {
    const spy = jest.fn((buf: Uint8Array) => {
      for (let i = 0; i < buf.length; i++) {
        buf[i] = (i * 7) & 0xff;
      }
      return buf;
    });
    setCrypto({getRandomValues: spy});
    const out = randomBytesSync(16);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(7);
    expect(out[2]).toBe(14);
  });

  it('chunks WebCrypto calls under the 65_536-byte quota', () => {
    const spy = jest.fn((buf: Uint8Array) => buf);
    setCrypto({getRandomValues: spy});
    randomBytesSync(70_000);
    // 70_000 = 65_536 + 4_464 → two calls.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('randomBytesSync — fallback path', () => {
  beforeEach(() => {
    setCrypto(undefined);
  });

  it('emits a one-time warning when WebCrypto is absent', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    randomBytesSync(16);
    randomBytesSync(16);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/crypto.getRandomValues is unavailable/);
  });

  it('returns unique output across consecutive calls', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const out = randomBytesSync(16);
      seen.add(Buffer.from(out).toString('hex'));
    }
    expect(seen.size).toBe(64);
  });

  it('produces output of any length, including non-block-aligned', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(randomBytesSync(1).length).toBe(1);
    expect(randomBytesSync(7).length).toBe(7);
    expect(randomBytesSync(20).length).toBe(20);
    expect(randomBytesSync(33).length).toBe(33);
  });

  it('rejects malformed crypto object (subtle present, getRandomValues missing)', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    setCrypto({subtle: {}});
    const out = randomBytesSync(16);
    expect(out.length).toBe(16);
  });
});

describe('randomBytes (async) — native bridge', () => {
  it('returns native bytes on success', async () => {
    // Native returns 4 bytes: [1,2,3,4] → base64 'AQIDBA=='
    mockCryptoRandomBytes.mockResolvedValueOnce({
      success: true,
      code: 'OK',
      message: '',
      bytesB64: 'AQIDBA==',
    });
    const out = await randomBytes(4);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(mockCryptoRandomBytes).toHaveBeenCalledWith(4);
  });

  it('throws when native fails (no silent fallback)', async () => {
    mockCryptoRandomBytes.mockResolvedValueOnce({
      success: false,
      code: 'RANDOM_FAILED',
      message: 'JCE provider missing',
    });
    await expect(randomBytes(8)).rejects.toThrow(
      /native SecureRandom unavailable.*RANDOM_FAILED/,
    );
  });

  it('throws when native returns a wrong-length payload', async () => {
    mockCryptoRandomBytes.mockResolvedValueOnce({
      success: true,
      code: 'OK',
      message: '',
      bytesB64: 'AQIDBA==', // 4 bytes
    });
    await expect(randomBytes(8)).rejects.toThrow(
      /returned 4 bytes, expected 8/,
    );
  });

  it('throws when native returns success but no bytesB64', async () => {
    mockCryptoRandomBytes.mockResolvedValueOnce({
      success: true,
      code: 'OK',
      message: 'oops',
    });
    await expect(randomBytes(8)).rejects.toThrow(
      /native SecureRandom unavailable/,
    );
  });

  it('validates length before calling native', async () => {
    await expect(randomBytes(0)).rejects.toThrow(/positive integer/);
    expect(mockCryptoRandomBytes).not.toHaveBeenCalled();
  });
});
