// Encrypted vault for the user's KeyFile list.
//
// On-disk layout (JSON, base64 for binary fields):
//
//   {
//     "version": 1,
//     "kdf":     {"algo": "pbkdf2-sha256", "iterations": N,
//                 "saltB64": "..."},
//     "ctB64":   "...nonce(12) || aes-gcm-ciphertext-with-tag..."
//   }
//
// Plaintext payload is the same JSON envelope `discoverKeyFiles`
// produces today: `{ files: KeyFile[] }`. Keeping that shape lets the
// rest of the codebase (resolveActiveProvider) consume vault output
// indistinguishably from on-disk plaintext output.
//
// Atomic write strategy:
//   1. Encrypt + serialize to bytes.
//   2. Write to `<vaultPath>.tmp`.
//   3. **Verify** by reading + decrypting with the same key. If
//      verify fails we delete the tmp and throw — the caller is then
//      free to keep the original .txt around.
//   4. Rename tmp → final via FileUtils.renameToFile (atomic on the
//      same filesystem).
//
// Read distinguishes:
//   - 'not-found' (no vault file)
//   - 'wrong-pin' (file exists, decryption auth-tag failed)
//   - 'corrupt'   (file exists but JSON shape / KDF params are wrong)
//   - 'ok'        (decrypted KeyFile[] returned)

import {decrypt, encrypt} from '../crypto/aesGcm';
import {DEFAULT_KDF_PARAMS, SALT_LENGTH_BYTES, deriveKey} from '../crypto/kdf';
import {randomBytes} from '../crypto/randomBytes';
import type {KeyFile, ProviderId} from '../types';
import {PROVIDER_IDS} from '../types';
import type {FileIo} from './fileIo';
import type {Logger} from '../sdk/types';
import {decodeUtf8, encodeUtf8} from '../sdk/utf8';

const TAG = '[vault]';
const VAULT_VERSION = 1;
const SUPPORTED_KDF = 'pbkdf2-sha256';
const TMP_SUFFIX = '.tmp';

const NOOP = (): void => undefined;
const noopLogger: Logger = {log: NOOP, warn: NOOP, error: NOOP};

type SerializedVault = {
  version: 1;
  kdf: {algo: 'pbkdf2-sha256'; iterations: number; saltB64: string};
  ctB64: string;
};

export type VaultDeps = {
  io: FileIo;
  vaultPath: string;
  logger?: Logger;
};

export type ReadVaultResult =
  | {kind: 'ok'; files: KeyFile[]}
  | {kind: 'not-found'}
  | {kind: 'wrong-pin'}
  | {kind: 'corrupt'; reason: string};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return globalThis.btoa(binary);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};

const looksLikeKeyFile = (v: unknown): v is KeyFile => {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (!PROVIDER_IDS.includes(o.provider as ProviderId)) {
    return false;
  }
  if (typeof o.model !== 'string' || o.model.length === 0) {
    return false;
  }
  if (typeof o.key !== 'string' || o.key.length === 0) {
    return false;
  }
  if (typeof o.sourcePath !== 'string') {
    return false;
  }
  return true;
};

const parseFiles = (parsed: unknown): KeyFile[] | null => {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const files = (parsed as {files?: unknown}).files;
  if (!Array.isArray(files)) {
    return null;
  }
  if (!files.every(looksLikeKeyFile)) {
    return null;
  }
  return files as KeyFile[];
};

const isSerializedVault = (v: unknown): v is SerializedVault => {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (o.version !== VAULT_VERSION) {
    return false;
  }
  const kdf = o.kdf as Record<string, unknown> | undefined;
  if (
    !kdf ||
    kdf.algo !== SUPPORTED_KDF ||
    typeof kdf.iterations !== 'number' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < 1 ||
    typeof kdf.saltB64 !== 'string'
  ) {
    return false;
  }
  if (typeof o.ctB64 !== 'string' || o.ctB64.length === 0) {
    return false;
  }
  return true;
};

export const vaultExists = async (deps: VaultDeps): Promise<boolean> =>
  deps.io.exists(deps.vaultPath);

export const deleteVault = async (deps: VaultDeps): Promise<boolean> =>
  deps.io.remove(deps.vaultPath);

export const readVault = async (
  deps: VaultDeps,
  passphrase: string,
): Promise<ReadVaultResult> => {
  const logger = deps.logger ?? noopLogger;
  const exists = await deps.io.exists(deps.vaultPath);
  if (!exists) {
    return {kind: 'not-found'};
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.io.readBytes(deps.vaultPath);
  } catch (e) {
    return {kind: 'corrupt', reason: `read failed: ${(e as Error).message}`};
  }
  if (bytes === null || bytes.length === 0) {
    return {kind: 'corrupt', reason: 'empty file'};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch (e) {
    return {kind: 'corrupt', reason: `JSON: ${(e as Error).message}`};
  }
  if (!isSerializedVault(parsed)) {
    return {kind: 'corrupt', reason: 'wrong envelope shape'};
  }
  const env = parsed;
  let salt: Uint8Array;
  let payload: Uint8Array;
  try {
    salt = base64ToBytes(env.kdf.saltB64);
    payload = base64ToBytes(env.ctB64);
  } catch (e) {
    return {kind: 'corrupt', reason: `base64: ${(e as Error).message}`};
  }
  if (salt.length !== SALT_LENGTH_BYTES) {
    return {
      kind: 'corrupt',
      reason: `salt length ${salt.length} (expected ${SALT_LENGTH_BYTES})`,
    };
  }
  const key = deriveKey(passphrase, salt, {iterations: env.kdf.iterations});
  const dec = decrypt(key, payload);
  if (!dec.ok) {
    if (dec.reason === 'wrong-key') {
      return {kind: 'wrong-pin'};
    }
    return {kind: 'corrupt', reason: 'aes-gcm payload malformed'};
  }
  let plain: unknown;
  try {
    plain = JSON.parse(decodeUtf8(dec.plaintext));
  } catch (e) {
    return {kind: 'corrupt', reason: `inner JSON: ${(e as Error).message}`};
  }
  const files = parseFiles(plain);
  if (files === null) {
    return {kind: 'corrupt', reason: 'inner shape != {files: KeyFile[]}'};
  }
  logger.log(`${TAG} unlocked ${files.length} key file(s)`);
  return {kind: 'ok', files};
};

export const writeVault = async (
  deps: VaultDeps,
  passphrase: string,
  files: KeyFile[],
): Promise<void> => {
  const logger = deps.logger ?? noopLogger;
  const salt = randomBytes(SALT_LENGTH_BYTES);
  const key = deriveKey(passphrase, salt, DEFAULT_KDF_PARAMS);
  const inner = encodeUtf8(JSON.stringify({files}));
  const payload = encrypt(key, inner);
  const envelope: SerializedVault = {
    version: VAULT_VERSION,
    kdf: {
      algo: SUPPORTED_KDF,
      iterations: DEFAULT_KDF_PARAMS.iterations,
      saltB64: bytesToBase64(salt),
    },
    ctB64: bytesToBase64(payload),
  };
  const tmpPath = `${deps.vaultPath}${TMP_SUFFIX}`;
  await deps.io.writeBytes(tmpPath, encodeUtf8(JSON.stringify(envelope)));

  // Verify: read tmp + decrypt and compare. Catches a host-side
  // "writeFileBase64 said success but didn't" or any base64
  // round-trip bug before we destroy the source.
  const verify = await readVault(
    {...deps, vaultPath: tmpPath},
    passphrase,
  );
  if (verify.kind !== 'ok') {
    await deps.io.remove(tmpPath);
    throw new Error(
      `vault verify failed (${verify.kind}); tmp removed, vault not committed`,
    );
  }

  const renamed = await deps.io.rename(tmpPath, deps.vaultPath);
  if (!renamed) {
    await deps.io.remove(tmpPath);
    throw new Error('vault rename failed; tmp removed, vault not committed');
  }
  logger.log(`${TAG} wrote vault with ${files.length} key file(s)`);
};
