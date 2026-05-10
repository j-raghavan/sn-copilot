/* eslint-disable no-bitwise */
/**
 * Tests for src/crypto/kdf. Pins:
 *   1. Output is a 32-byte Uint8Array.
 *   2. Same (passphrase, salt, params) → same key (determinism).
 *   3. Different salt or different passphrase → different key.
 *   4. Argument validation: empty passphrase, wrong-size salt, bad
 *      iteration count.
 *   5. Native bridge path: when CopilotOverlay.cryptoPbkdf2Sha256
 *      returns success, deriveKey uses its bytes (no pure-JS run).
 *      When it fails, the JS fallback fires.
 *
 * `deriveKey` is async — production path delegates to the native
 * JDK PBKDF2; tests use the JS fallback by default.
 */
const mockCryptoPbkdf2 = jest.fn<
  Promise<{success: boolean; code: string; message: string; bytesB64?: string}>,
  [string, string, number, number]
>();
jest.mock('../src/native/CopilotOverlay', () => ({
  __esModule: true,
  default: {
    cryptoPbkdf2Sha256: (
      pwd: string,
      salt: string,
      iters: number,
      dkLen: number,
    ) => mockCryptoPbkdf2(pwd, salt, iters, dkLen),
  },
}));

import {DEFAULT_KDF_PARAMS, KEY_LENGTH_BYTES, SALT_LENGTH_BYTES, deriveKey} from '../src/crypto/kdf';

beforeEach(() => {
  mockCryptoPbkdf2.mockReset();
  // Default: native bridge fails so the JS fallback runs (matches
  // legacy test assertions about determinism / sensitivity).
  mockCryptoPbkdf2.mockResolvedValue({
    success: false,
    code: 'MODULE_MISSING',
    message: 'mock',
  });
});

// Use a tiny iteration count for tests so the suite stays fast. The
// real default exercises the production cost via the vault tests.
const FAST = {iterations: 1_000};

const sampleSalt = (seed: number): Uint8Array => {
  const out = new Uint8Array(SALT_LENGTH_BYTES);
  for (let i = 0; i < SALT_LENGTH_BYTES; i++) {
    out[i] = (seed + i) & 0xff;
  }
  return out;
};

describe('deriveKey — output shape', () => {
  it('returns a Uint8Array of length KEY_LENGTH_BYTES', async () => {
    const key = await deriveKey('hunter2', sampleSalt(1), FAST);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(KEY_LENGTH_BYTES);
  });
});

describe('deriveKey — determinism / sensitivity', () => {
  it('is deterministic for the same inputs', async () => {
    const a = await deriveKey('hunter2', sampleSalt(1), FAST);
    const b = await deriveKey('hunter2', sampleSalt(1), FAST);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('changes when passphrase changes', async () => {
    const a = await deriveKey('hunter2', sampleSalt(1), FAST);
    const b = await deriveKey('hunter3', sampleSalt(1), FAST);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('changes when salt changes', async () => {
    const a = await deriveKey('hunter2', sampleSalt(1), FAST);
    const b = await deriveKey('hunter2', sampleSalt(2), FAST);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('changes when iteration count changes', async () => {
    const a = await deriveKey('hunter2', sampleSalt(1), {iterations: 1_000});
    const b = await deriveKey('hunter2', sampleSalt(1), {iterations: 2_000});
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });
});

describe('deriveKey — argument validation', () => {
  it('rejects empty passphrase', async () => {
    await expect(deriveKey('', sampleSalt(1), FAST)).rejects.toThrow(/non-empty/);
  });

  it('rejects non-string passphrase', async () => {
    await expect(
      // @ts-expect-error — testing runtime guard
      deriveKey(undefined, sampleSalt(1), FAST),
    ).rejects.toThrow(/non-empty/);
  });

  it.each([0, 8, 32])('rejects salt of wrong length %d', async (len) => {
    await expect(deriveKey('hunter2', new Uint8Array(len), FAST)).rejects.toThrow(/salt/);
  });

  it('rejects non-Uint8Array salt', async () => {
    await expect(
      // @ts-expect-error — testing runtime guard
      deriveKey('hunter2', 'not-bytes', FAST),
    ).rejects.toThrow(/salt/);
  });

  it('rejects non-positive iterations', async () => {
    await expect(
      deriveKey('hunter2', sampleSalt(1), {iterations: 0}),
    ).rejects.toThrow(/iterations/);
    await expect(
      deriveKey('hunter2', sampleSalt(1), {iterations: -5}),
    ).rejects.toThrow(/iterations/);
    await expect(
      deriveKey('hunter2', sampleSalt(1), {iterations: 1.5}),
    ).rejects.toThrow(/iterations/);
  });

  it('exposes a frozen DEFAULT_KDF_PARAMS', () => {
    expect(Object.isFrozen(DEFAULT_KDF_PARAMS)).toBe(true);
    // Production default is 100k (native JDK path runs sub-100ms).
    // Vault.ts honours the iter count stored in each envelope, so old
    // vaults still decrypt at whatever iter count they were written.
    expect(DEFAULT_KDF_PARAMS.iterations).toBeGreaterThanOrEqual(10_000);
  });
});

describe('deriveKey — native bridge', () => {
  it('returns native bytes verbatim when cryptoPbkdf2Sha256 succeeds', async () => {
    // 32 zero bytes → base64 of 32 zero bytes
    const fakeKeyB64 = Buffer.alloc(KEY_LENGTH_BYTES, 0).toString('base64');
    mockCryptoPbkdf2.mockResolvedValueOnce({
      success: true,
      code: 'OK',
      message: '',
      bytesB64: fakeKeyB64,
    });
    const key = await deriveKey('hunter2', sampleSalt(1), FAST);
    expect(key.length).toBe(KEY_LENGTH_BYTES);
    expect(key.every((b) => b === 0)).toBe(true);
    // Native is called with the right shape.
    expect(mockCryptoPbkdf2).toHaveBeenCalledTimes(1);
    const [, , iters, dkLen] = mockCryptoPbkdf2.mock.calls[0];
    expect(iters).toBe(FAST.iterations);
    expect(dkLen).toBe(KEY_LENGTH_BYTES);
  });

  it('falls through to JS pbkdf2 when native fails', async () => {
    mockCryptoPbkdf2.mockResolvedValueOnce({
      success: false,
      code: 'PBKDF2_FAILED',
      message: 'mock',
    });
    const key = await deriveKey('hunter2', sampleSalt(1), FAST);
    expect(key.length).toBe(KEY_LENGTH_BYTES);
    // The JS path is deterministic, so two fallback runs match.
    mockCryptoPbkdf2.mockResolvedValueOnce({
      success: false,
      code: 'PBKDF2_FAILED',
      message: 'mock',
    });
    const key2 = await deriveKey('hunter2', sampleSalt(1), FAST);
    expect(Buffer.from(key).toString('hex')).toBe(Buffer.from(key2).toString('hex'));
  });
});
