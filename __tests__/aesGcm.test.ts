/* eslint-disable no-bitwise */
/**
 * Tests for src/crypto/aesGcm. Pins:
 *   1. Round-trip: encrypt → decrypt yields the original plaintext.
 *   2. Each encrypt with the same key produces a different output
 *      (random nonce).
 *   3. Tamper detection: flipping any byte after the nonce breaks
 *      decryption (auth-tag mismatch).
 *   4. Wrong-key rejection.
 *   5. Malformed input (too short / not Uint8Array) is rejected without
 *      throwing.
 *   6. Argument validation on key length.
 */
import {
  KEY_LENGTH_BYTES,
  NONCE_LENGTH_BYTES,
  decrypt,
  encrypt,
} from '../src/crypto/aesGcm';

const fixedKey = (seed: number): Uint8Array => {
  const out = new Uint8Array(KEY_LENGTH_BYTES);
  for (let i = 0; i < KEY_LENGTH_BYTES; i++) {
    out[i] = (seed * 31 + i) & 0xff;
  }
  return out;
};

const utf8 = new TextEncoder();

describe('aesGcm — round-trip', () => {
  it('decrypt(encrypt(plaintext)) === plaintext', () => {
    const k = fixedKey(1);
    const pt = utf8.encode('a real API key starts with sk-');
    const ct = encrypt(k, pt);
    const r = decrypt(k, ct);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Buffer.from(r.plaintext).toString('utf8')).toBe(
        'a real API key starts with sk-',
      );
    }
  });

  it('round-trips empty plaintext', () => {
    const k = fixedKey(2);
    const ct = encrypt(k, new Uint8Array(0));
    const r = decrypt(k, ct);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plaintext.length).toBe(0);
    }
  });

  it('round-trips a multi-KB payload', () => {
    const k = fixedKey(3);
    const pt = new Uint8Array(8_192);
    for (let i = 0; i < pt.length; i++) {
      pt[i] = i & 0xff;
    }
    const ct = encrypt(k, pt);
    const r = decrypt(k, ct);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plaintext.length).toBe(8_192);
      expect(Buffer.from(r.plaintext).toString('hex')).toBe(
        Buffer.from(pt).toString('hex'),
      );
    }
  });
});

describe('aesGcm — nonce is fresh per encryption', () => {
  it('produces different ciphertexts for the same plaintext + key', () => {
    const k = fixedKey(4);
    const pt = utf8.encode('same plaintext');
    const a = encrypt(k, pt);
    const b = encrypt(k, pt);
    expect(Buffer.from(a).toString('hex')).not.toBe(
      Buffer.from(b).toString('hex'),
    );
    // The first 12 bytes are the nonce; assert they differ.
    expect(Buffer.from(a.slice(0, NONCE_LENGTH_BYTES)).toString('hex')).not.toBe(
      Buffer.from(b.slice(0, NONCE_LENGTH_BYTES)).toString('hex'),
    );
  });
});

describe('aesGcm — tamper detection', () => {
  it('rejects ciphertext with a flipped tag byte', () => {
    const k = fixedKey(5);
    const ct = encrypt(k, utf8.encode('payload'));
    // Flip the last byte (inside the auth tag).
    ct[ct.length - 1] ^= 0xff;
    const r = decrypt(k, ct);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('wrong-key');
    }
  });

  it('rejects ciphertext with a flipped middle byte', () => {
    const k = fixedKey(6);
    const ct = encrypt(k, utf8.encode('a payload long enough to flip mid'));
    ct[NONCE_LENGTH_BYTES + 5] ^= 0x01;
    const r = decrypt(k, ct);
    expect(r.ok).toBe(false);
  });
});

describe('aesGcm — wrong key', () => {
  it('rejects decryption with a different key', () => {
    const ct = encrypt(fixedKey(7), utf8.encode('secret'));
    const r = decrypt(fixedKey(8), ct);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('wrong-key');
    }
  });
});

describe('aesGcm — malformed input', () => {
  it.each([0, 5, NONCE_LENGTH_BYTES, NONCE_LENGTH_BYTES + 15])(
    'rejects payload of length %d as malformed',
    (len) => {
      const r = decrypt(fixedKey(9), new Uint8Array(len));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('malformed');
      }
    },
  );

  it('rejects non-Uint8Array payload as malformed', () => {
    // @ts-expect-error — testing runtime guard
    const r = decrypt(fixedKey(10), 'not bytes');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('malformed');
    }
  });
});

describe('aesGcm — key validation', () => {
  it.each([0, 16, 24, 64])('rejects key of length %d', (len) => {
    expect(() => encrypt(new Uint8Array(len), utf8.encode('x'))).toThrow(/key/);
    expect(() => decrypt(new Uint8Array(len), new Uint8Array(50))).toThrow(/key/);
  });

  it('rejects non-Uint8Array key', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => encrypt('not bytes', utf8.encode('x'))).toThrow(/key/);
  });

  it('rejects non-Uint8Array plaintext on encrypt', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => encrypt(fixedKey(11), 'not bytes')).toThrow(/plaintext/);
  });
});
