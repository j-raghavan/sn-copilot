/* eslint-disable no-bitwise */
/**
 * Tests for src/crypto/kdf. Pins:
 *   1. Output is a 32-byte Uint8Array.
 *   2. Same (passphrase, salt, params) → same key (determinism).
 *   3. Different salt or different passphrase → different key.
 *   4. Argument validation: empty passphrase, wrong-size salt, bad
 *      iteration count.
 *
 * `deriveKey` returns a Promise (uses pbkdf2Async so it can yield to
 * the event loop on slow runtimes — see kdf.ts header for the
 * Hermes-block incident that drove this).
 */
import {DEFAULT_KDF_PARAMS, KEY_LENGTH_BYTES, SALT_LENGTH_BYTES, deriveKey} from '../src/crypto/kdf';

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
    // 50k is the production default — high enough for ~14h offline
    // brute-force on a 6-digit PIN, low enough to be bearable on
    // Hermes (sync 200k blocked the bridge for ~30s).
    expect(DEFAULT_KDF_PARAMS.iterations).toBeGreaterThanOrEqual(10_000);
  });
});
