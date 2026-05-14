/**
 * Tests for src/storage/conversations. Pins:
 *   1. read on missing / empty file → EMPTY store.
 *   2. plaintext write → read round-trip.
 *   3. encrypted write (mode='encrypted' + key set) → read round-trip.
 *   4. encrypted write without key → throws (gated by UI normally).
 *   5. encrypted file + no key → read returns empty (locked vault).
 *   6. auto-detect on read: plaintext shape vs envelope shape.
 *   7. mode change between writes (plaintext → encrypted) flips encoding.
 *   8. FIFO cap: >5 conversations evicts oldest by updatedAt.
 *   9. saveConversation upserts by id and preserves the rest.
 *  10. clearConversations removes the file.
 *  11. corrupt JSON / wrong shape → empty store (defensive).
 *  12. atomic write: verify failure removes tmp, no final write.
 *  13. conversationPreview derives first-user-message preview.
 */
jest.mock('../src/native/CopilotOverlay', () => {
  const {
    cryptoPbkdf2Sha256MockImpl,
    cryptoRandomBytesMockImpl,
  } = require('./helpers/cryptoMockImpl');
  return {
    __esModule: true,
    default: {
      cryptoPbkdf2Sha256: jest.fn(cryptoPbkdf2Sha256MockImpl),
      cryptoRandomBytes: jest.fn(cryptoRandomBytesMockImpl),
    },
  };
});

import {
  clearConversations,
  evictToLimit,
  loadConversations,
  readConversations,
  saveConversation,
  writeConversations,
  type ConversationsDeps,
} from '../src/storage/conversations';
import {
  CONVERSATION_HISTORY_LIMIT,
  CONVERSATION_SCHEMA_VERSION,
  conversationPreview,
  type Conversation,
  type ConversationMessage,
  type EncryptionMode,
} from '../src/types';
import {createInMemoryFileIo, type InMemoryFileIo} from './helpers/inMemoryFileIo';

const PATH = '/plugin/copilot-conversations.json';
const utf8 = new TextEncoder();

const silentLogger = {log: jest.fn(), warn: jest.fn(), error: jest.fn()};
beforeEach(() => {
  silentLogger.log.mockClear();
  silentLogger.warn.mockClear();
  silentLogger.error.mockClear();
});

const msg = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  extras: Partial<ConversationMessage> = {},
): ConversationMessage => ({
  id,
  role,
  text,
  createdAt: extras.createdAt ?? 1_700_000_000_000,
  ...extras,
});

const conv = (
  id: string,
  updatedAt: number,
  messages: ConversationMessage[] = [msg(`${id}-m1`, 'user', `hello from ${id}`)],
): Conversation => ({
  id,
  createdAt: updatedAt - 1000,
  updatedAt,
  messages,
});

type Mode = EncryptionMode;
type Deps = ConversationsDeps;

const makeDeps = (
  io: InMemoryFileIo,
  mode: Mode,
  key: Uint8Array | null = null,
): Deps => ({
  io,
  conversationsPath: PATH,
  encryptionMode: () => mode,
  derivedKey: () => key,
  logger: silentLogger,
});

const fakeKey = (): Uint8Array => {
  // 32 bytes — AES-256-GCM. Deterministic so tests are reproducible.
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    // eslint-disable-next-line no-bitwise
    k[i] = (i * 7 + 3) & 0xff;
  }
  return k;
};

describe('readConversations — missing / empty', () => {
  it('returns empty store when no file', async () => {
    const io = createInMemoryFileIo();
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
    expect(r.version).toBe(CONVERSATION_SCHEMA_VERSION);
  });

  it('returns empty store when file is zero bytes', async () => {
    const io = createInMemoryFileIo({[PATH]: new Uint8Array(0)});
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });

  it('returns empty store when readBytes throws', async () => {
    const io = createInMemoryFileIo();
    io.readBytes = async () => {
      throw new Error('boom');
    };
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });
});

describe('plaintext round-trip', () => {
  it('write → read returns the same conversations', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'plaintext');
    const c = conv('c1', 1_700_000_000_000);
    await writeConversations(deps, {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: [c],
    });
    const r = await readConversations(deps);
    expect(r.conversations).toEqual([c]);
  });

  it('round-trips a conversation with assistant metadata', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'plaintext');
    const messages: ConversationMessage[] = [
      msg('m1', 'user', 'Summarize this page'),
      msg('m2', 'assistant', '• Point A\n• Point B', {
        modelId: 'claude-haiku-4-5',
        latencyMs: 1234,
        createdAt: 1_700_000_001_000,
      }),
    ];
    const c: Conversation = {
      id: 'c-meta',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      providerId: 'anthropic',
      messages,
    };
    await writeConversations(deps, {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: [c],
    });
    const r = await readConversations(deps);
    expect(r.conversations).toEqual([c]);
  });

  it('undecided mode writes plaintext too', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'undecided');
    await writeConversations(deps, {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: [conv('c1', 1)],
    });
    const back = await readConversations(deps);
    expect(back.conversations).toHaveLength(1);
    // The on-disk bytes should NOT be an envelope.
    const bytes = io.fs.get(PATH);
    expect(bytes).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(bytes!));
    expect(parsed.ctB64).toBeUndefined();
    expect(parsed.conversations).toBeDefined();
  });
});

describe('encrypted round-trip', () => {
  it('write encrypted → read decrypts back', async () => {
    const io = createInMemoryFileIo();
    const key = fakeKey();
    const deps = makeDeps(io, 'encrypted', key);
    const c = conv('c1', 1_700_000_000_000);
    await writeConversations(deps, {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: [c],
    });
    // On-disk bytes should be an envelope (no `conversations` key at
    // the top level — that's hidden inside ctB64).
    const bytes = io.fs.get(PATH);
    const parsed = JSON.parse(new TextDecoder().decode(bytes!));
    expect(parsed.ctB64).toBeDefined();
    expect(parsed.conversations).toBeUndefined();
    expect(parsed.kdf?.algo).toBe('pbkdf2-sha256');
    const r = await readConversations(deps);
    expect(r.conversations).toEqual([c]);
  });

  it('throws when mode=encrypted but no derived key', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'encrypted', null);
    await expect(
      writeConversations(deps, {
        version: CONVERSATION_SCHEMA_VERSION,
        conversations: [conv('c1', 1)],
      }),
    ).rejects.toThrow(/encrypted mode but vault is locked/);
  });

  it('encrypted file + no key in memory → read returns empty store', async () => {
    const io = createInMemoryFileIo();
    // Write encrypted first.
    const key = fakeKey();
    await writeConversations(makeDeps(io, 'encrypted', key), {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: [conv('c1', 1)],
    });
    // Then attempt to read while locked.
    const r = await readConversations(makeDeps(io, 'encrypted', null));
    expect(r.conversations).toEqual([]);
  });

  it('encrypted file + wrong key in memory → read returns empty store', async () => {
    const io = createInMemoryFileIo();
    const key = fakeKey();
    await writeConversations(makeDeps(io, 'encrypted', key), {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: [conv('c1', 1)],
    });
    const wrong = new Uint8Array(32).fill(0xff);
    const r = await readConversations(makeDeps(io, 'encrypted', wrong));
    expect(r.conversations).toEqual([]);
  });
});

describe('auto-detect on read', () => {
  it('reads plaintext shape regardless of mode/key passed', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          conversations: [conv('c1', 1)],
        }),
      ),
    });
    // Caller claims encrypted but on-disk is plaintext — we read it.
    const r = await readConversations(makeDeps(io, 'encrypted', fakeKey()));
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0].id).toBe('c1');
  });

  it('rejects unknown top-level shape as empty', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(JSON.stringify({foo: 'bar'})),
    });
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });

  it('rejects bad JSON as empty', async () => {
    const io = createInMemoryFileIo({[PATH]: utf8.encode('{ not json')});
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });

  it('rejects shape with wrong version as empty', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({version: 99, conversations: [conv('c1', 1)]}),
      ),
    });
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });

  it('rejects conversation with bad message shape as empty', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          conversations: [
            {
              id: 'c1',
              createdAt: 1,
              updatedAt: 1,
              messages: [{id: '', role: 'banana', text: 5}],
            },
          ],
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });
});

describe('mode-change between writes', () => {
  it('flips encoding when mode changes from plaintext to encrypted', async () => {
    const io = createInMemoryFileIo();
    await writeConversations(makeDeps(io, 'plaintext'), {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: [conv('c1', 1)],
    });
    expect(
      JSON.parse(new TextDecoder().decode(io.fs.get(PATH)!)).conversations,
    ).toBeDefined();
    await writeConversations(makeDeps(io, 'encrypted', fakeKey()), {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: [conv('c1', 1)],
    });
    expect(
      JSON.parse(new TextDecoder().decode(io.fs.get(PATH)!)).ctB64,
    ).toBeDefined();
  });
});

describe('FIFO cap', () => {
  it('evictToLimit keeps the newest CONVERSATION_HISTORY_LIMIT by updatedAt', () => {
    const list: Conversation[] = [];
    for (let i = 0; i < CONVERSATION_HISTORY_LIMIT + 3; i++) {
      list.push(conv(`c${i}`, 1_000 + i));
    }
    const r = evictToLimit(list);
    expect(r).toHaveLength(CONVERSATION_HISTORY_LIMIT);
    // Newest first by updatedAt.
    expect(r[0].id).toBe(`c${CONVERSATION_HISTORY_LIMIT + 2}`);
    expect(r[r.length - 1].id).toBe(`c${3}`);
  });

  it('write clamps to FIFO limit even when caller passes more', async () => {
    const io = createInMemoryFileIo();
    const overflow: Conversation[] = [];
    for (let i = 0; i < CONVERSATION_HISTORY_LIMIT + 4; i++) {
      overflow.push(conv(`c${i}`, 1_000 + i));
    }
    await writeConversations(makeDeps(io, 'plaintext'), {
      version: CONVERSATION_SCHEMA_VERSION,
      conversations: overflow,
    });
    const back = await readConversations(makeDeps(io, 'plaintext'));
    expect(back.conversations).toHaveLength(CONVERSATION_HISTORY_LIMIT);
  });

  it('read clamps to FIFO limit even if disk has more', async () => {
    const io = createInMemoryFileIo();
    const overflow: Conversation[] = [];
    for (let i = 0; i < CONVERSATION_HISTORY_LIMIT + 2; i++) {
      overflow.push(conv(`c${i}`, 1_000 + i));
    }
    io.fs.set(
      PATH,
      utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          conversations: overflow,
        }),
      ),
    );
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toHaveLength(CONVERSATION_HISTORY_LIMIT);
  });
});

describe('saveConversation', () => {
  it('appends new conversation', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'plaintext');
    const r1 = await saveConversation(deps, conv('c1', 1));
    const r2 = await saveConversation(deps, conv('c2', 2));
    expect(r1.map((c) => c.id)).toEqual(['c1']);
    expect(r2.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('upserts existing conversation by id (preserves the rest)', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'plaintext');
    await saveConversation(deps, conv('c1', 1));
    await saveConversation(deps, conv('c2', 2));
    const updated = conv('c1', 5, [msg('m9', 'user', 'updated')]);
    const r = await saveConversation(deps, updated);
    expect(r.find((c) => c.id === 'c1')!.messages[0].text).toBe('updated');
    expect(r.find((c) => c.id === 'c2')).toBeDefined();
  });

  it('upsert + cap: a new conversation evicts the oldest', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'plaintext');
    for (let i = 0; i < CONVERSATION_HISTORY_LIMIT; i++) {
      await saveConversation(deps, conv(`c${i}`, 1_000 + i));
    }
    const r = await saveConversation(deps, conv('cN', 9_999));
    expect(r).toHaveLength(CONVERSATION_HISTORY_LIMIT);
    expect(r.map((c) => c.id)).toContain('cN');
    expect(r.map((c) => c.id)).not.toContain('c0');
  });
});

describe('loadConversations / clearConversations', () => {
  it('loadConversations returns just the array', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'plaintext');
    await saveConversation(deps, conv('c1', 1));
    const list = await loadConversations(deps);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('c1');
  });

  it('clearConversations removes the file', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, 'plaintext');
    await saveConversation(deps, conv('c1', 1));
    expect(io.fs.has(PATH)).toBe(true);
    await clearConversations(deps);
    expect(io.fs.has(PATH)).toBe(false);
  });
});

describe('atomic write semantics', () => {
  it('removes tmp and throws when verify fails (plaintext)', async () => {
    const io = createInMemoryFileIo();
    let writeCount = 0;
    io.writeBytes = async (path, bytes) => {
      writeCount += 1;
      if (writeCount === 1) {
        io.fs.set(path, utf8.encode('not a conversations file'));
        return;
      }
      io.fs.set(path, new Uint8Array(bytes));
    };
    await expect(
      writeConversations(makeDeps(io, 'plaintext'), {
        version: CONVERSATION_SCHEMA_VERSION,
        conversations: [conv('c1', 1)],
      }),
    ).rejects.toThrow(/verify failed/);
    expect(io.fs.has(PATH)).toBe(false);
    expect(io.fs.has(`${PATH}.tmp`)).toBe(false);
  });

  it('removes tmp and throws when rename fails (encrypted)', async () => {
    const io = createInMemoryFileIo();
    io.rename = async () => false;
    await expect(
      writeConversations(makeDeps(io, 'encrypted', fakeKey()), {
        version: CONVERSATION_SCHEMA_VERSION,
        conversations: [conv('c1', 1)],
      }),
    ).rejects.toThrow(/rename failed/);
    expect(io.fs.has(PATH)).toBe(false);
    expect(io.fs.has(`${PATH}.tmp`)).toBe(false);
  });

  it('removes tmp and throws when the verify read throws', async () => {
    const io = createInMemoryFileIo();
    io.readBytes = async () => {
      throw new Error('disk read failed');
    };
    await expect(
      writeConversations(makeDeps(io, 'plaintext'), {
        version: CONVERSATION_SCHEMA_VERSION,
        conversations: [conv('c1', 1)],
      }),
    ).rejects.toThrow(/verify read failed/);
    expect(io.fs.has(PATH)).toBe(false);
    expect(io.fs.has(`${PATH}.tmp`)).toBe(false);
  });

  it('removes tmp and throws when the verify read returns null', async () => {
    const io = createInMemoryFileIo();
    io.readBytes = async () => null;
    await expect(
      writeConversations(makeDeps(io, 'plaintext'), {
        version: CONVERSATION_SCHEMA_VERSION,
        conversations: [conv('c1', 1)],
      }),
    ).rejects.toThrow(/verify read returned null/);
    expect(io.fs.has(PATH)).toBe(false);
    expect(io.fs.has(`${PATH}.tmp`)).toBe(false);
  });

  it('encrypted write: verify fails when read-back bytes are non-JSON', async () => {
    const io = createInMemoryFileIo();
    let writeCount = 0;
    io.writeBytes = async (path, bytes) => {
      writeCount += 1;
      if (writeCount === 1) {
        io.fs.set(path, utf8.encode('not json at all'));
        return;
      }
      io.fs.set(path, new Uint8Array(bytes));
    };
    await expect(
      writeConversations(makeDeps(io, 'encrypted', fakeKey()), {
        version: CONVERSATION_SCHEMA_VERSION,
        conversations: [conv('c1', 1)],
      }),
    ).rejects.toThrow(/verify failed/);
    expect(io.fs.has(PATH)).toBe(false);
    expect(io.fs.has(`${PATH}.tmp`)).toBe(false);
  });

  it('encrypted write: verify fails when read-back bytes have wrong envelope shape', async () => {
    const io = createInMemoryFileIo();
    let writeCount = 0;
    io.writeBytes = async (path, bytes) => {
      writeCount += 1;
      if (writeCount === 1) {
        io.fs.set(path, utf8.encode('{}'));
        return;
      }
      io.fs.set(path, new Uint8Array(bytes));
    };
    await expect(
      writeConversations(makeDeps(io, 'encrypted', fakeKey()), {
        version: CONVERSATION_SCHEMA_VERSION,
        conversations: [conv('c1', 1)],
      }),
    ).rejects.toThrow(/verify failed/);
  });

  it('default (noop) logger does not throw on warn paths', async () => {
    // Same flow as 'returns empty store when no file' but without
    // injecting a logger — exercises the noopLogger branch.
    const io = createInMemoryFileIo();
    const deps: ConversationsDeps = {
      io,
      conversationsPath: PATH,
      encryptionMode: () => 'plaintext',
      derivedKey: () => null,
    };
    const r = await readConversations(deps);
    expect(r.conversations).toEqual([]);
  });
});

describe('shape validation — invalid messages rejected', () => {
  // Each case mutates a single field on an otherwise-valid persisted
  // conversation; reading the resulting file should collapse to an
  // empty store rather than expose a malformed shape to the UI.
  type Patch = (m: Record<string, unknown>) => Record<string, unknown>;

  const baseMessage = (): Record<string, unknown> => ({
    id: 'mA',
    role: 'user',
    text: 'hello',
    createdAt: 1,
  });

  const cases: Array<[string, Patch]> = [
    ['missing id', (m) => ({...m, id: ''})],
    ['non-string id', (m) => ({...m, id: 42})],
    ['bad role', (m) => ({...m, role: 'system'})],
    ['non-string text', (m) => ({...m, text: 99})],
    ['missing createdAt', (m) => ({...m, createdAt: 'soon'})],
    ['modelId non-string', (m) => ({...m, modelId: 7})],
    ['latencyMs non-number', (m) => ({...m, latencyMs: 'fast'})],
  ];

  it.each(cases)('rejects message with %s', async (_label, patch) => {
    const m = patch(baseMessage());
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          conversations: [
            {id: 'c1', createdAt: 1, updatedAt: 1, messages: [m]},
          ],
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });
});

describe('shape validation — invalid conversations rejected', () => {
  type Patch = (c: Record<string, unknown>) => Record<string, unknown>;

  const base = (): Record<string, unknown> => ({
    id: 'c1',
    createdAt: 1,
    updatedAt: 1,
    messages: [{id: 'mA', role: 'user', text: 'hello', createdAt: 1}],
  });

  const cases: Array<[string, Patch]> = [
    ['missing id', (c) => ({...c, id: ''})],
    ['non-string id', (c) => ({...c, id: 42})],
    ['non-number createdAt', (c) => ({...c, createdAt: 'now'})],
    ['non-number updatedAt', (c) => ({...c, updatedAt: 'now'})],
    ['bad providerId', (c) => ({...c, providerId: 'mistral'})],
    ['messages not array', (c) => ({...c, messages: 'nope'})],
    ['messages with one bad entry', (c) => ({...c, messages: [{nope: true}]})],
  ];

  it.each(cases)('rejects conversation with %s', async (_label, patch) => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          conversations: [patch(base())],
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });

  it('accepts a valid providerId', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          conversations: [{...base(), providerId: 'anthropic'}],
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0].providerId).toBe('anthropic');
  });
});

describe('null / non-object inputs at every validator', () => {
  it('top-level JSON literal null is treated as empty store', async () => {
    const io = createInMemoryFileIo({[PATH]: utf8.encode('null')});
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });

  it('top-level JSON array is treated as empty store', async () => {
    const io = createInMemoryFileIo({[PATH]: utf8.encode('[1,2,3]')});
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });

  it('conversations array containing null is rejected', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          conversations: [null],
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });

  it('messages array containing null is rejected', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          conversations: [
            {id: 'c1', createdAt: 1, updatedAt: 1, messages: [null]},
          ],
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'plaintext'));
    expect(r.conversations).toEqual([]);
  });
});

describe('encrypted envelope shape validation', () => {
  it('rejects envelope with wrong kdf algo as empty', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          kdf: {algo: 'md5', iterations: 1, saltB64: 'AA=='},
          ctB64: 'AA==',
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'encrypted', fakeKey()));
    expect(r.conversations).toEqual([]);
  });

  it('rejects envelope with non-integer iterations as empty', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          kdf: {algo: 'pbkdf2-sha256', iterations: 1.5, saltB64: 'AA=='},
          ctB64: 'AA==',
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'encrypted', fakeKey()));
    expect(r.conversations).toEqual([]);
  });

  it('rejects envelope with empty ctB64 as empty', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          kdf: {algo: 'pbkdf2-sha256', iterations: 1, saltB64: 'AA=='},
          ctB64: '',
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'encrypted', fakeKey()));
    expect(r.conversations).toEqual([]);
  });

  it('rejects envelope with non-base64 ctB64 as empty', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        JSON.stringify({
          version: CONVERSATION_SCHEMA_VERSION,
          kdf: {algo: 'pbkdf2-sha256', iterations: 1, saltB64: 'AA=='},
          ctB64: '@@@not-base64@@@',
        }),
      ),
    });
    const r = await readConversations(makeDeps(io, 'encrypted', fakeKey()));
    expect(r.conversations).toEqual([]);
  });

  it('rejects envelope whose inner plaintext is not JSON as empty', async () => {
    const io = createInMemoryFileIo();
    // Write encrypted bytes whose plaintext is "garbage not json".
    const {encrypt} = require('../src/crypto/aesGcm');
    const key = fakeKey();
    const ct = encrypt(key, utf8.encode('garbage not json'));
    // Build an envelope with that ciphertext.
    const envelope = {
      version: CONVERSATION_SCHEMA_VERSION,
      kdf: {algo: 'pbkdf2-sha256', iterations: 1, saltB64: 'AA=='},
      ctB64: Buffer.from(ct).toString('base64'),
    };
    io.fs.set(PATH, utf8.encode(JSON.stringify(envelope)));
    const r = await readConversations(makeDeps(io, 'encrypted', key));
    expect(r.conversations).toEqual([]);
  });
});

describe('id factories', () => {
  it('newMessageId returns unique strings on successive calls', () => {
    const {newMessageId} = require('../src/storage/conversations');
    const a = newMessageId();
    const b = newMessageId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^m_/);
  });

  it('newConversationId returns unique strings on successive calls', () => {
    const {newConversationId} = require('../src/storage/conversations');
    const a = newConversationId();
    const b = newConversationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^c_/);
  });

  it('__testing__.resetIdCounter restarts the message counter', () => {
    const {newMessageId, __testing__: t} = require('../src/storage/conversations');
    const a = newMessageId();
    t.resetIdCounter();
    const b = newMessageId();
    // Both should match the prefix; counter portion at the end resets.
    expect(a.split('_').pop()).not.toBe(b.split('_').pop());
  });
});

describe('conversationPreview helper', () => {
  it('returns the trimmed first user message', () => {
    const c = conv('x', 1, [
      msg('m1', 'assistant', 'I should not appear'),
      msg('m2', 'user', '  ask about page  '),
      msg('m3', 'user', 'second user msg'),
    ]);
    expect(conversationPreview(c)).toBe('ask about page');
  });

  it('truncates long previews to MAX − 1 chars + ellipsis', () => {
    const long = 'x'.repeat(200);
    const c = conv('x', 1, [msg('m1', 'user', long)]);
    const p = conversationPreview(c);
    expect(p.endsWith('…')).toBe(true);
    expect(p.length).toBeLessThanOrEqual(80);
  });

  it('returns empty string when there is no user message', () => {
    const c = conv('x', 1, [msg('m1', 'assistant', 'no user yet')]);
    expect(conversationPreview(c)).toBe('');
  });
});
