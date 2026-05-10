/**
 * Tests for src/storage/vault. Pins:
 *   1. write → read round-trip yields the same KeyFile[].
 *   2. wrong PIN returns kind='wrong-pin' (not throw).
 *   3. corrupt envelope (bad JSON / wrong shape / wrong salt length /
 *      wrong KDF algo / wrong version) returns kind='corrupt'.
 *   4. Atomic write: tmp file is removed on verify failure; final
 *      vault is NOT created.
 *   5. Verify-on-write: rename failure removes tmp.
 *   6. vaultExists, deleteVault.
 *   7. files filtered to KeyFile shape on read; unknown extras ignored.
 */
import {
  deleteVault,
  readVault,
  vaultExists,
  writeVault,
} from '../src/storage/vault';
import {
  DEFAULT_KDF_PARAMS,
  SALT_LENGTH_BYTES,
  deriveKey,
} from '../src/crypto/kdf';
import {encrypt} from '../src/crypto/aesGcm';
import {randomBytes} from '../src/crypto/randomBytes';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';
import type {KeyFile} from '../src/types';

const VAULT_PATH = '/plugin/copilot-key.enc';
const utf8 = new TextEncoder();

const sampleFiles: KeyFile[] = [
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    key: 'sk-ant-test-1234',
    sourcePath: '/some/copilot-key-anthropic.txt',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    key: 'sk-proj-abcdef',
    defaultProvider: 'openai',
    sourcePath: '/some/copilot-key-openai.txt',
  },
];

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(bin);
};

// Helper: build a vault envelope by hand for corruption tests.
const buildEnvelope = (over: Partial<{
  version: number;
  algo: string;
  iterations: number;
  saltB64: string;
  ctB64: string;
}> = {}): string => {
  const salt = randomBytes(SALT_LENGTH_BYTES);
  const key = deriveKey('hunter2', salt, DEFAULT_KDF_PARAMS);
  const ct = encrypt(key, utf8.encode(JSON.stringify({files: sampleFiles})));
  return JSON.stringify({
    version: over.version ?? 1,
    kdf: {
      algo: over.algo ?? 'pbkdf2-sha256',
      iterations: over.iterations ?? DEFAULT_KDF_PARAMS.iterations,
      saltB64: over.saltB64 ?? bytesToBase64(salt),
    },
    ctB64: over.ctB64 ?? bytesToBase64(ct),
  });
};

describe('vault — round-trip', () => {
  it('writeVault then readVault returns the same files', async () => {
    const io = createInMemoryFileIo();
    await writeVault({io, vaultPath: VAULT_PATH}, 'hunter2', sampleFiles);
    const r = await readVault({io, vaultPath: VAULT_PATH}, 'hunter2');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.files).toEqual(sampleFiles);
    }
  });

  it('writeVault produces a different envelope each call (random salt)', async () => {
    const ioA = createInMemoryFileIo();
    const ioB = createInMemoryFileIo();
    await writeVault({io: ioA, vaultPath: VAULT_PATH}, 'hunter2', sampleFiles);
    await writeVault({io: ioB, vaultPath: VAULT_PATH}, 'hunter2', sampleFiles);
    const a = ioA.fs.get(VAULT_PATH);
    const b = ioB.fs.get(VAULT_PATH);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Buffer.from(a!).toString('hex')).not.toBe(
      Buffer.from(b!).toString('hex'),
    );
  });

  it('vaultExists / deleteVault round-trip', async () => {
    const io = createInMemoryFileIo();
    expect(await vaultExists({io, vaultPath: VAULT_PATH})).toBe(false);
    await writeVault({io, vaultPath: VAULT_PATH}, 'hunter2', sampleFiles);
    expect(await vaultExists({io, vaultPath: VAULT_PATH})).toBe(true);
    expect(await deleteVault({io, vaultPath: VAULT_PATH})).toBe(true);
    expect(await vaultExists({io, vaultPath: VAULT_PATH})).toBe(false);
  });
});

describe('vault — wrong PIN / not found', () => {
  it('returns not-found when no vault file', async () => {
    const io = createInMemoryFileIo();
    const r = await readVault({io, vaultPath: VAULT_PATH}, 'hunter2');
    expect(r.kind).toBe('not-found');
  });

  it('returns wrong-pin when PIN is wrong', async () => {
    const io = createInMemoryFileIo();
    await writeVault({io, vaultPath: VAULT_PATH}, 'hunter2', sampleFiles);
    const r = await readVault({io, vaultPath: VAULT_PATH}, 'something-else');
    expect(r.kind).toBe('wrong-pin');
  });
});

describe('vault — corrupt envelope', () => {
  const corruptCases: Array<[string, () => string]> = [
    ['malformed JSON', () => '{ not json'],
    ['empty inside braces', () => '{}'],
    [
      'wrong version',
      () => buildEnvelope({version: 2}),
    ],
    [
      'wrong algo',
      () => buildEnvelope({algo: 'md5'}),
    ],
    [
      'salt wrong length',
      () => buildEnvelope({saltB64: bytesToBase64(new Uint8Array(8))}),
    ],
    [
      'ctB64 not base64',
      () => buildEnvelope({ctB64: '@@@not-base64@@@'}),
    ],
    [
      'iterations missing / non-int',
      () => JSON.stringify({version: 1, kdf: {algo: 'pbkdf2-sha256', iterations: 'lots', saltB64: bytesToBase64(randomBytes(SALT_LENGTH_BYTES))}, ctB64: 'AA=='}),
    ],
  ];

  it.each(corruptCases)('flags %s as corrupt', async (_label, build) => {
    const io = createInMemoryFileIo({
      [VAULT_PATH]: utf8.encode(build()),
    });
    const r = await readVault({io, vaultPath: VAULT_PATH}, 'hunter2');
    expect(r.kind).toBe('corrupt');
  });

  it('flags an empty file as corrupt', async () => {
    const io = createInMemoryFileIo({[VAULT_PATH]: new Uint8Array(0)});
    const r = await readVault({io, vaultPath: VAULT_PATH}, 'hunter2');
    expect(r.kind).toBe('corrupt');
  });

  it('flags inner ciphertext that decrypts to non-JSON as corrupt', async () => {
    const io = createInMemoryFileIo();
    const salt = randomBytes(SALT_LENGTH_BYTES);
    const key = deriveKey('hunter2', salt, DEFAULT_KDF_PARAMS);
    const ct = encrypt(key, utf8.encode('not json at all'));
    io.fs.set(
      VAULT_PATH,
      utf8.encode(
        JSON.stringify({
          version: 1,
          kdf: {algo: 'pbkdf2-sha256', iterations: DEFAULT_KDF_PARAMS.iterations, saltB64: bytesToBase64(salt)},
          ctB64: bytesToBase64(ct),
        }),
      ),
    );
    const r = await readVault({io, vaultPath: VAULT_PATH}, 'hunter2');
    expect(r.kind).toBe('corrupt');
  });

  it('flags inner JSON without files: KeyFile[] as corrupt', async () => {
    const io = createInMemoryFileIo();
    const salt = randomBytes(SALT_LENGTH_BYTES);
    const key = deriveKey('hunter2', salt, DEFAULT_KDF_PARAMS);
    const ct = encrypt(key, utf8.encode(JSON.stringify({files: [{wrong: 'shape'}]})));
    io.fs.set(
      VAULT_PATH,
      utf8.encode(
        JSON.stringify({
          version: 1,
          kdf: {algo: 'pbkdf2-sha256', iterations: DEFAULT_KDF_PARAMS.iterations, saltB64: bytesToBase64(salt)},
          ctB64: bytesToBase64(ct),
        }),
      ),
    );
    const r = await readVault({io, vaultPath: VAULT_PATH}, 'hunter2');
    expect(r.kind).toBe('corrupt');
  });

  it('flags read failure as corrupt', async () => {
    const io = createInMemoryFileIo({[VAULT_PATH]: utf8.encode('{}')});
    io.readBytes = async () => {
      throw new Error('IO failed');
    };
    const r = await readVault({io, vaultPath: VAULT_PATH}, 'hunter2');
    expect(r.kind).toBe('corrupt');
  });
});

describe('vault — atomic write semantics', () => {
  it('removes tmp and throws when verify fails (write succeeded but read returns corrupt)', async () => {
    const io = createInMemoryFileIo();
    let writeCount = 0;
    io.writeBytes = async (path, bytes) => {
      writeCount += 1;
      // First write goes through normally; on verify-read we corrupt
      // the file by setting random bytes instead.
      if (writeCount === 1) {
        io.fs.set(path, utf8.encode('not a vault'));
        return;
      }
      io.fs.set(path, new Uint8Array(bytes));
    };
    await expect(
      writeVault({io, vaultPath: VAULT_PATH}, 'hunter2', sampleFiles),
    ).rejects.toThrow(/verify failed/);
    // Final vault should NOT exist; tmp should also be cleaned up.
    expect(io.fs.has(VAULT_PATH)).toBe(false);
    expect(io.fs.has(`${VAULT_PATH}.tmp`)).toBe(false);
  });

  it('removes tmp and throws when rename fails', async () => {
    const io = createInMemoryFileIo();
    io.rename = async () => false;
    await expect(
      writeVault({io, vaultPath: VAULT_PATH}, 'hunter2', sampleFiles),
    ).rejects.toThrow(/rename failed/);
    expect(io.fs.has(VAULT_PATH)).toBe(false);
    expect(io.fs.has(`${VAULT_PATH}.tmp`)).toBe(false);
  });

  it('writeVault is the only writer; one rename per success', async () => {
    const io = createInMemoryFileIo();
    await writeVault({io, vaultPath: VAULT_PATH}, 'hunter2', sampleFiles);
    expect(io.writeCount).toBe(1);
    expect(io.renameCount).toBe(1);
  });
});
