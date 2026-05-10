// Test mock implementations for the native crypto bridge.
//
// Production code calls `CopilotOverlay.cryptoPbkdf2Sha256` and
// `CopilotOverlay.cryptoRandomBytes` and treats failure as a hard
// error (no JS fallback — see kdf.ts / randomBytes.ts headers). Tests
// mock the bridge with these implementations so round-trips through
// the real key-derivation + AES path still work without dragging
// @noble/hashes into the production bundle.
//
// IMPORTANT: do NOT import from this file at the top of a test. The
// jest.mock() factory is hoisted before normal imports, so use
// require() inside the factory:
//
//   jest.mock('../src/native/CopilotOverlay', () => {
//     const {cryptoPbkdf2Sha256MockImpl, cryptoRandomBytesMockImpl} =
//       require('./helpers/cryptoMockImpl');
//     return {
//       __esModule: true,
//       default: {
//         // ...overlay mocks…
//         cryptoPbkdf2Sha256: jest.fn(cryptoPbkdf2Sha256MockImpl),
//         cryptoRandomBytes: jest.fn(cryptoRandomBytesMockImpl),
//       },
//     };
//   });

import {pbkdf2} from '@noble/hashes/pbkdf2.js';
import {sha256} from '@noble/hashes/sha2.js';
import {randomBytes as nodeRandomBytes} from 'crypto';

export type MockCryptoResult = {
  success: boolean;
  code: string;
  message: string;
  bytesB64?: string;
};

export const cryptoPbkdf2Sha256MockImpl = async (
  passwordUtf8B64: string,
  saltB64: string,
  iterations: number,
  keyLengthBytes: number,
): Promise<MockCryptoResult> => {
  const pwd = Buffer.from(passwordUtf8B64, 'base64');
  const salt = Buffer.from(saltB64, 'base64');
  const key = pbkdf2(sha256, pwd, salt, {c: iterations, dkLen: keyLengthBytes});
  return {
    success: true,
    code: 'OK',
    message: 'mock',
    bytesB64: Buffer.from(key).toString('base64'),
  };
};

export const cryptoRandomBytesMockImpl = async (
  length: number,
): Promise<MockCryptoResult> => {
  const bytes = nodeRandomBytes(length);
  return {
    success: true,
    code: 'OK',
    message: 'mock',
    bytesB64: bytes.toString('base64'),
  };
};
