/**
 * Branch-coverage tests for the inner KeyFile validation in vault.ts.
 * Each case constructs a vault whose decrypted payload has exactly one
 * defect so the relevant rejection branch in `looksLikeKeyFile` /
 * `parseFiles` fires.
 */
import {readVault, writeVault} from '../src/storage/vault';
import {DEFAULT_KDF_PARAMS, SALT_LENGTH_BYTES, deriveKey} from '../src/crypto/kdf';
import {encrypt} from '../src/crypto/aesGcm';
import {randomBytes} from '../src/crypto/randomBytes';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';
import type {KeyFile} from '../src/types';

const VAULT_PATH = '/plugin/copilot-key.enc';
const utf8 = new TextEncoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(bin);
};

const seedEncryptedPayload = async (
  payloadJson: string,
): Promise<ReturnType<typeof createInMemoryFileIo>> => {
  const io = createInMemoryFileIo();
  const salt = randomBytes(SALT_LENGTH_BYTES);
  const key = await deriveKey('123456', salt, DEFAULT_KDF_PARAMS);
  const ct = encrypt(key, utf8.encode(payloadJson));
  io.fs.set(
    VAULT_PATH,
    utf8.encode(
      JSON.stringify({
        version: 1,
        kdf: {
          algo: 'pbkdf2-sha256',
          iterations: DEFAULT_KDF_PARAMS.iterations,
          saltB64: bytesToBase64(salt),
        },
        ctB64: bytesToBase64(ct),
      }),
    ),
  );
  return io;
};

describe('vault — inner KeyFile validation branches', () => {
  it.each<[string, unknown]>([
    ['provider missing', {model: 'm', key: 'k', sourcePath: '/x'}],
    [
      'provider not a known id',
      {provider: 'mistral', model: 'm', key: 'k', sourcePath: '/x'},
    ],
    [
      'model not string',
      {provider: 'anthropic', model: 42, key: 'k', sourcePath: '/x'},
    ],
    [
      'model empty',
      {provider: 'anthropic', model: '', key: 'k', sourcePath: '/x'},
    ],
    [
      'key not string',
      {provider: 'anthropic', model: 'm', key: 0, sourcePath: '/x'},
    ],
    [
      'key empty',
      {provider: 'anthropic', model: 'm', key: '', sourcePath: '/x'},
    ],
    [
      'sourcePath not string',
      {provider: 'anthropic', model: 'm', key: 'k', sourcePath: 7},
    ],
    ['inner item is null', null],
    ['inner item is a string', 'not-an-object'],
  ])(
    'rejects an inner KeyFile with %s as corrupt',
    async (_label, badItem) => {
      const io = await seedEncryptedPayload(JSON.stringify({files: [badItem]}));
      const r = await readVault({io, vaultPath: VAULT_PATH}, '123456');
      expect(r.kind).toBe('corrupt');
    },
  );

  it.each<[string, unknown]>([
    ['inner JSON is null', null],
    ['inner JSON is a string', 'hello'],
    ['inner JSON is a number', 42],
    ['inner JSON has files not-an-array', {files: 'oops'}],
    ['inner JSON missing files key', {other: 1}],
  ])('rejects when %s', async (_label, payload) => {
    const io = await seedEncryptedPayload(JSON.stringify(payload));
    const r = await readVault({io, vaultPath: VAULT_PATH}, '123456');
    expect(r.kind).toBe('corrupt');
  });

  it.each<[string, string]>([
    ['envelope JSON parses to null', 'null'],
    ['envelope JSON parses to a string', '"not-an-envelope"'],
    ['envelope has empty ctB64', JSON.stringify({
      version: 1,
      kdf: {algo: 'pbkdf2-sha256', iterations: 200_000, saltB64: bytesToBase64(new Uint8Array(16))},
      ctB64: '',
    })],
  ])('rejects when %s', async (_label, fileText) => {
    const io = createInMemoryFileIo({[VAULT_PATH]: utf8.encode(fileText)});
    const r = await readVault({io, vaultPath: VAULT_PATH}, '123456');
    expect(r.kind).toBe('corrupt');
  });

  it('flags ctB64 shorter than the AES-GCM minimum as corrupt (aes-gcm malformed)', async () => {
    // 5 bytes encoded as base64 → way under the 12-byte nonce + 16-byte
    // tag minimum, so decrypt reports 'malformed' instead of 'wrong-key'.
    const io = createInMemoryFileIo({
      [VAULT_PATH]: utf8.encode(
        JSON.stringify({
          version: 1,
          kdf: {
            algo: 'pbkdf2-sha256',
            iterations: 200_000,
            saltB64: bytesToBase64(new Uint8Array(16)),
          },
          ctB64: bytesToBase64(new Uint8Array([1, 2, 3, 4, 5])),
        }),
      ),
    });
    const r = await readVault({io, vaultPath: VAULT_PATH}, '123456');
    expect(r.kind).toBe('corrupt');
    if (r.kind === 'corrupt') {
      expect(r.reason).toContain('aes-gcm');
    }
  });

  it('accepts the optional defaultProvider / clarifyRedact fields', async () => {
    const io = createInMemoryFileIo();
    const files: KeyFile[] = [
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        key: 'sk-ant',
        sourcePath: '/x',
        defaultProvider: 'anthropic',
        clarifyRedact: true,
      },
    ];
    await writeVault({io, vaultPath: VAULT_PATH}, '123456', files);
    const r = await readVault({io, vaultPath: VAULT_PATH}, '123456');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.files[0].defaultProvider).toBe('anthropic');
      expect(r.files[0].clarifyRedact).toBe(true);
    }
  });
});
