// Persisted chat history — last-5 FIFO retention (Req 1+2 from
// feat/rel3). Single on-disk file `<plugin-dir>/copilot-conversations.json`
// holds either:
//
//   - plaintext shape: `{version, conversations: Conversation[]}`
//   - encrypted envelope: `{version, kdf, ctB64}` (same shape as
//     vault.ts, plaintext payload is the plaintext store JSON).
//
// Which encoding is on disk is auto-detected on read by shape — the
// envelope carries a `ctB64` field, the plaintext store carries a
// `conversations` field. The write path picks based on:
//
//   - encryptionMode === 'encrypted' AND derived key in memory → encrypt
//   - otherwise → plaintext
//
// When encrypted-mode is on but the vault is locked (no derived
// key), reads return EMPTY_CONVERSATION_STORE and writes are a
// no-op. The UI gates conversation persistence behind the unlock
// flow so this branch is only hit on a race during lock/unlock
// transitions.
//
// Atomic write: encode → write .tmp → verify (read-back +
// shape-match, or decrypt for the encrypted path) → rename. Same
// dance as vault.ts. Plaintext history isn't security-critical but
// torn-write safety still matters — losing 5 conversations to a
// partial write would erase the entire feature.

import {decrypt, encrypt} from '../crypto/aesGcm';
import {DEFAULT_KDF_PARAMS, SALT_LENGTH_BYTES} from '../crypto/kdf';
import {randomBytes} from '../crypto/randomBytes';
import {
  CONVERSATION_HISTORY_LIMIT,
  CONVERSATION_SCHEMA_VERSION,
  EMPTY_CONVERSATION_STORE,
  type Conversation,
  type ConversationMessage,
  type ConversationStore,
  type EncryptionMode,
  type ProviderId,
} from '../types';
import {PROVIDER_IDS} from '../types';
import {decodeUtf8, encodeUtf8} from '../sdk/utf8';
import type {FileIo} from './fileIo';
import type {Logger} from '../sdk/types';

const TAG = '[conversations]';
const TMP_SUFFIX = '.tmp';
const SUPPORTED_KDF = 'pbkdf2-sha256';

const NOOP = (): void => undefined;
const noopLogger: Logger = {log: NOOP, warn: NOOP, error: NOOP};

type SerializedEncryptedEnvelope = {
  version: typeof CONVERSATION_SCHEMA_VERSION;
  kdf: {algo: 'pbkdf2-sha256'; iterations: number; saltB64: string};
  ctB64: string;
};

// Caller supplies the current encryption mode and the in-memory
// derived key getter. These come from prefs + derivedKey holder in
// production; tests inject fakes. Passphrase is needed only when an
// encrypted-mode write happens but no derived key is in memory yet
// (rare — first-time encryption setup); in normal flows we have the
// derived key and skip the 5-10s PBKDF2.
export type ConversationsDeps = {
  io: FileIo;
  conversationsPath: string;
  encryptionMode: () => EncryptionMode | Promise<EncryptionMode>;
  derivedKey: () => Uint8Array | null;
  logger?: Logger;
};

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

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const looksLikeMessage = (v: unknown): v is ConversationMessage => {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (!isStr(o.id) || o.id.length === 0) {
    return false;
  }
  if (o.role !== 'user' && o.role !== 'assistant') {
    return false;
  }
  if (!isStr(o.text)) {
    return false;
  }
  if (!isNum(o.createdAt)) {
    return false;
  }
  if (o.modelId !== undefined && !isStr(o.modelId)) {
    return false;
  }
  if (o.latencyMs !== undefined && !isNum(o.latencyMs)) {
    return false;
  }
  return true;
};

const looksLikeConversation = (v: unknown): v is Conversation => {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (!isStr(o.id) || o.id.length === 0) {
    return false;
  }
  if (!isNum(o.createdAt) || !isNum(o.updatedAt)) {
    return false;
  }
  if (
    o.providerId !== undefined &&
    !PROVIDER_IDS.includes(o.providerId as ProviderId)
  ) {
    return false;
  }
  if (!Array.isArray(o.messages) || !o.messages.every(looksLikeMessage)) {
    return false;
  }
  return true;
};

const parsePlaintextStore = (parsed: unknown): ConversationStore | null => {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  if (o.version !== CONVERSATION_SCHEMA_VERSION) {
    return null;
  }
  if (!Array.isArray(o.conversations)) {
    return null;
  }
  if (!o.conversations.every(looksLikeConversation)) {
    return null;
  }
  return {
    version: CONVERSATION_SCHEMA_VERSION,
    conversations: o.conversations as Conversation[],
  };
};

const isEncryptedEnvelope = (v: unknown): v is SerializedEncryptedEnvelope => {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (o.version !== CONVERSATION_SCHEMA_VERSION) {
    return false;
  }
  const kdf = o.kdf as Record<string, unknown> | undefined;
  if (
    !kdf ||
    kdf.algo !== SUPPORTED_KDF ||
    !Number.isInteger(kdf.iterations) ||
    (kdf.iterations as number) < 1 ||
    !isStr(kdf.saltB64)
  ) {
    return false;
  }
  if (!isStr(o.ctB64) || (o.ctB64 as string).length === 0) {
    return false;
  }
  return true;
};

// Sort newest-first by updatedAt and slice to the FIFO limit. Pure;
// callers use this both on read (defensive against legacy files
// containing >5) and on write (post-upsert).
export const evictToLimit = (
  conversations: Conversation[],
): Conversation[] => {
  const copy = conversations.slice();
  copy.sort((a, b) => b.updatedAt - a.updatedAt);
  return copy.slice(0, CONVERSATION_HISTORY_LIMIT);
};

const decryptEnvelopeBytes = (
  bytes: Uint8Array,
  key: Uint8Array,
): ConversationStore | null => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(decodeUtf8(bytes));
  } catch {
    return null;
  }
  if (!isEncryptedEnvelope(envelope)) {
    return null;
  }
  const env = envelope;
  let payload: Uint8Array;
  try {
    payload = base64ToBytes(env.ctB64);
  } catch {
    return null;
  }
  const dec = decrypt(key, payload);
  if (!dec.ok) {
    return null;
  }
  let plain: unknown;
  try {
    plain = JSON.parse(decodeUtf8(dec.plaintext));
  } catch {
    return null;
  }
  return parsePlaintextStore(plain);
};

// Reads the conversations file and returns the parsed store. On any
// kind of failure (missing file, bad JSON, wrong shape, locked vault)
// returns EMPTY_CONVERSATION_STORE so the UI is never blocked by a
// corrupt history file. The store is also clamped to the FIFO limit
// in case an older write left more than 5.
export const readConversations = async (
  deps: ConversationsDeps,
): Promise<ConversationStore> => {
  const logger = deps.logger ?? noopLogger;
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.io.readBytes(deps.conversationsPath);
  } catch (e) {
    logger.warn(`${TAG} read failed (${(e as Error).message}) — empty store`);
    return {...EMPTY_CONVERSATION_STORE, conversations: []};
  }
  if (bytes === null || bytes.length === 0) {
    return {...EMPTY_CONVERSATION_STORE, conversations: []};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    logger.warn(`${TAG} JSON parse failed — empty store`);
    return {...EMPTY_CONVERSATION_STORE, conversations: []};
  }
  // Plaintext shape — return directly.
  const plain = parsePlaintextStore(parsed);
  if (plain !== null) {
    return {...plain, conversations: evictToLimit(plain.conversations)};
  }
  // Encrypted envelope — need the derived key.
  if (isEncryptedEnvelope(parsed)) {
    const key = deps.derivedKey();
    if (key === null) {
      logger.log(`${TAG} encrypted store present but vault locked — empty`);
      return {...EMPTY_CONVERSATION_STORE, conversations: []};
    }
    const decrypted = decryptEnvelopeBytes(bytes, key);
    if (decrypted !== null) {
      return {
        ...decrypted,
        conversations: evictToLimit(decrypted.conversations),
      };
    }
    logger.warn(`${TAG} encrypted store decrypt/parse failed — empty`);
    return {...EMPTY_CONVERSATION_STORE, conversations: []};
  }
  logger.warn(`${TAG} unrecognised store shape — empty`);
  return {...EMPTY_CONVERSATION_STORE, conversations: []};
};

const sanitizeStore = (store: ConversationStore): ConversationStore => ({
  version: CONVERSATION_SCHEMA_VERSION,
  conversations: evictToLimit(store.conversations),
});

// Encodes the plaintext store to JSON bytes. Shared by both the
// plaintext-on-disk path and the inner payload for the encrypted
// path.
const encodePlaintext = (store: ConversationStore): Uint8Array =>
  encodeUtf8(JSON.stringify(sanitizeStore(store)));

const encodeEncrypted = async (
  store: ConversationStore,
  key: Uint8Array,
): Promise<Uint8Array> => {
  const salt = await randomBytes(SALT_LENGTH_BYTES);
  // The salt + iterations are stored alongside the ciphertext so a
  // future PIN-change flow can re-derive without recomputing. We use
  // the *in-memory* key for the actual encryption regardless — the
  // KDF block is informational + forward-compat.
  const inner = encodePlaintext(store);
  const payload = encrypt(key, inner);
  const envelope: SerializedEncryptedEnvelope = {
    version: CONVERSATION_SCHEMA_VERSION,
    kdf: {
      algo: SUPPORTED_KDF,
      iterations: DEFAULT_KDF_PARAMS.iterations,
      saltB64: bytesToBase64(salt),
    },
    ctB64: bytesToBase64(payload),
  };
  return encodeUtf8(JSON.stringify(envelope));
};

const writeAtomic = async (
  deps: ConversationsDeps,
  finalPath: string,
  bytes: Uint8Array,
  verify: (writtenBytes: Uint8Array) => boolean,
): Promise<void> => {
  const tmpPath = `${finalPath}${TMP_SUFFIX}`;
  await deps.io.writeBytes(tmpPath, bytes);
  let writtenBytes: Uint8Array | null = null;
  try {
    writtenBytes = await deps.io.readBytes(tmpPath);
  } catch (e) {
    await deps.io.remove(tmpPath);
    throw new Error(
      `conversations verify read failed (${(e as Error).message})`,
    );
  }
  if (writtenBytes === null) {
    await deps.io.remove(tmpPath);
    throw new Error('conversations verify read returned null');
  }
  if (!verify(writtenBytes)) {
    await deps.io.remove(tmpPath);
    throw new Error('conversations verify failed — shape mismatch');
  }
  const renamed = await deps.io.rename(tmpPath, finalPath);
  if (!renamed) {
    await deps.io.remove(tmpPath);
    throw new Error('conversations rename failed');
  }
};

// Writes the store using the encoding picked by the current
// encryption mode + derived-key availability. Returns the final
// sanitized store so callers can update their in-memory copy with
// the same eviction the disk now reflects.
export const writeConversations = async (
  deps: ConversationsDeps,
  store: ConversationStore,
): Promise<ConversationStore> => {
  const logger = deps.logger ?? noopLogger;
  const sanitized = sanitizeStore(store);
  const mode = await deps.encryptionMode();
  const key = deps.derivedKey();
  if (mode === 'encrypted') {
    if (key === null) {
      // Locked. Don't fall back to plaintext — that would leak. Skip
      // the write and tell the caller; UI gates this elsewhere so
      // this is a defensive guard.
      throw new Error(
        'conversations write skipped: encrypted mode but vault is locked',
      );
    }
    const bytes = await encodeEncrypted(sanitized, key);
    await writeAtomic(deps, deps.conversationsPath, bytes, (written) => {
      const back = decryptEnvelopeBytes(written, key);
      return back !== null;
    });
    logger.log(
      `${TAG} wrote ${sanitized.conversations.length} conversation(s), encrypted`,
    );
    return sanitized;
  }
  // Plaintext / undecided paths share the same encoding.
  const bytes = encodePlaintext(sanitized);
  await writeAtomic(deps, deps.conversationsPath, bytes, (written) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeUtf8(written));
    } catch {
      return false;
    }
    return parsePlaintextStore(parsed) !== null;
  });
  logger.log(
    `${TAG} wrote ${sanitized.conversations.length} conversation(s), plaintext`,
  );
  return sanitized;
};

// Upserts a single conversation by id (replacing if present, prepending
// if new), then evicts to the FIFO limit and persists. Returns the
// list as it is on disk after the write.
export const saveConversation = async (
  deps: ConversationsDeps,
  conv: Conversation,
): Promise<Conversation[]> => {
  const current = await readConversations(deps);
  const idx = current.conversations.findIndex((c) => c.id === conv.id);
  let next: Conversation[];
  if (idx === -1) {
    next = [conv, ...current.conversations];
  } else {
    next = current.conversations.slice();
    next[idx] = conv;
  }
  const written = await writeConversations(deps, {
    version: CONVERSATION_SCHEMA_VERSION,
    conversations: next,
  });
  return written.conversations;
};

export const loadConversations = async (
  deps: ConversationsDeps,
): Promise<Conversation[]> => {
  const r = await readConversations(deps);
  return r.conversations;
};

export const clearConversations = async (
  deps: ConversationsDeps,
): Promise<void> => {
  await deps.io.remove(deps.conversationsPath);
};

// ID factories. Both produce strings that are globally unique within
// the device's lifetime: a base-36 timestamp + a counter (messages)
// or 32-bit random hex (conversations). No native bridge needed —
// Math.random + Date.now is sufficient given the IDs are local to
// one user's chat history and the entropy bar is "no two messages
// minted in the same call".
let messageIdCounter = 0;

export const newMessageId = (): string => {
  messageIdCounter += 1;
  return `m_${Date.now().toString(36)}_${messageIdCounter.toString(36)}`;
};

export const newConversationId = (): string => {
  const ts = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `c_${ts}_${r}`;
};

export const __testing__ = {
  resetIdCounter: (): void => {
    messageIdCounter = 0;
  },
};
