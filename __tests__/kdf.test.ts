/* eslint-disable no-bitwise */
/**
 * Tests for src/crypto/kdf. Pins:
 *   1. Output is a 32-byte Uint8Array.
 *   2. Same (passphrase, salt, params) → same key (determinism).
 *   3. Different salt or different passphrase → different key.
 *   4. Argument validation: empty passphrase, wrong-size salt, bad
 *      iteration count.
 */
import {DEFAULT_KDF_PARAMS, KEY_LENGTH_BYTES, SALT_LENGTH_BYTES, deriveKey} from '../src/crypto/kdf';

// Use a tiny iteration count for tests so the suite stays fast. The
// real default (200k) is exercised end-to-end via the vault tests'
// faster-than-real fixture.
const FAST = {iterations: 1_000};

const sampleSalt = (seed: number): Uint8Array => {
  const out = new Uint8Array(SALT_LENGTH_BYTES);
  for (let i = 0; i < SALT_LENGTH_BYTES; i++) {
    out[i] = (seed + i) & 0xff;
  }
  return out;
};

describe('deriveKey — output shape', () => {
  it('returns a Uint8Array of length KEY_LENGTH_BYTES', () => {
    const key = deriveKey('hunter2', sampleSalt(1), FAST);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(KEY_LENGTH_BYTES);
  });
});

describe('deriveKey — determinism / sensitivity', () => {
  it('is deterministic for the same inputs', () => {
    const a = deriveKey('hunter2', sampleSalt(1), FAST);
    const b = deriveKey('hunter2', sampleSalt(1), FAST);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('changes when passphrase changes', () => {
    const a = deriveKey('hunter2', sampleSalt(1), FAST);
    const b = deriveKey('hunter3', sampleSalt(1), FAST);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('changes when salt changes', () => {
    const a = deriveKey('hunter2', sampleSalt(1), FAST);
    const b = deriveKey('hunter2', sampleSalt(2), FAST);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('changes when iteration count changes', () => {
    const a = deriveKey('hunter2', sampleSalt(1), {iterations: 1_000});
    const b = deriveKey('hunter2', sampleSalt(1), {iterations: 2_000});
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });
});

describe('deriveKey — argument validation', () => {
  it('rejects empty passphrase', () => {
    expect(() => deriveKey('', sampleSalt(1), FAST)).toThrow(/non-empty/);
  });

  it('rejects non-string passphrase', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => deriveKey(undefined, sampleSalt(1), FAST)).toThrow(/non-empty/);
  });

  it.each([0, 8, 32])('rejects salt of wrong length %d', (len) => {
    expect(() => deriveKey('hunter2', new Uint8Array(len), FAST)).toThrow(/salt/);
  });

  it('rejects non-Uint8Array salt', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => deriveKey('hunter2', 'not-bytes', FAST)).toThrow(/salt/);
  });

  it('rejects non-positive iterations', () => {
    expect(() =>
      deriveKey('hunter2', sampleSalt(1), {iterations: 0}),
    ).toThrow(/iterations/);
    expect(() =>
      deriveKey('hunter2', sampleSalt(1), {iterations: -5}),
    ).toThrow(/iterations/);
    expect(() =>
      deriveKey('hunter2', sampleSalt(1), {iterations: 1.5}),
    ).toThrow(/iterations/);
  });

  it('exposes a frozen DEFAULT_KDF_PARAMS', () => {
    expect(Object.isFrozen(DEFAULT_KDF_PARAMS)).toBe(true);
    expect(DEFAULT_KDF_PARAMS.iterations).toBeGreaterThanOrEqual(100_000);
  });
});
