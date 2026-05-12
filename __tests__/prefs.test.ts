/**
 * Tests for src/storage/prefs. Pins:
 *   1. Missing file → DEFAULT_PREFS.
 *   2. Empty file → DEFAULT_PREFS.
 *   3. Malformed JSON → DEFAULT_PREFS (with warn).
 *   4. Valid file round-trips.
 *   5. Invalid encryptionMode / idleTimeoutMin sanitized to defaults.
 *   6. setEncryptionMode / setIdleTimeoutMin update + persist.
 */
import {
  CUSTOM_ACTION_LIMIT,
  CUSTOM_SYSTEM_PROMPT_MAX,
  DEFAULT_PREFS,
  type CopilotPrefs,
  type CustomAction,
} from '../src/types';
import {
  readPrefs,
  setCustomActions,
  setCustomSystemPrompt,
  setEncryptionMode,
  setIdleTimeoutMin,
  writePrefs,
} from '../src/storage/prefs';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';

const PREFS_PATH = '/plugin/copilot-prefs.json';
const utf8 = new TextEncoder();

const silentLogger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

beforeEach(() => {
  silentLogger.log.mockClear();
  silentLogger.warn.mockClear();
  silentLogger.error.mockClear();
});

describe('readPrefs — missing / empty / malformed', () => {
  it('returns defaults when no file exists', async () => {
    const io = createInMemoryFileIo();
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r).toEqual(DEFAULT_PREFS);
  });

  it('returns defaults when file is empty', async () => {
    const io = createInMemoryFileIo({[PREFS_PATH]: new Uint8Array(0)});
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r).toEqual(DEFAULT_PREFS);
  });

  it('returns defaults and warns when JSON is malformed', async () => {
    const io = createInMemoryFileIo({[PREFS_PATH]: utf8.encode('{ not json')});
    const r = await readPrefs({io, prefsPath: PREFS_PATH, logger: silentLogger});
    expect(r).toEqual(DEFAULT_PREFS);
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it('returns defaults when JSON parses to a non-object', async () => {
    const io = createInMemoryFileIo({[PREFS_PATH]: utf8.encode('"a string"')});
    const r = await readPrefs({io, prefsPath: PREFS_PATH, logger: silentLogger});
    expect(r).toEqual(DEFAULT_PREFS);
  });

  it('returns defaults when readBytes throws', async () => {
    const io = createInMemoryFileIo();
    io.readBytes = async () => {
      throw new Error('IO died');
    };
    const r = await readPrefs({io, prefsPath: PREFS_PATH, logger: silentLogger});
    expect(r).toEqual(DEFAULT_PREFS);
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});

describe('readPrefs — sanitization', () => {
  it('sanitizes invalid encryptionMode to default', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({version: 1, encryptionMode: 'rot13', idleTimeoutMin: 7}),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.encryptionMode).toBe(DEFAULT_PREFS.encryptionMode);
    expect(r.idleTimeoutMin).toBe(7);
  });

  it('sanitizes negative idleTimeoutMin to default', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({version: 1, encryptionMode: 'plaintext', idleTimeoutMin: -1}),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.idleTimeoutMin).toBe(DEFAULT_PREFS.idleTimeoutMin);
  });

  it('sanitizes non-number idleTimeoutMin to default', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({version: 1, encryptionMode: 'plaintext', idleTimeoutMin: 'ten'}),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.idleTimeoutMin).toBe(DEFAULT_PREFS.idleTimeoutMin);
  });
});

describe('writePrefs / round-trip', () => {
  it('writePrefs followed by readPrefs returns the same shape', async () => {
    const io = createInMemoryFileIo();
    const next: CopilotPrefs = {
      version: 1,
      encryptionMode: 'encrypted',
      idleTimeoutMin: 30,
    };
    await writePrefs({io, prefsPath: PREFS_PATH}, next);
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r).toEqual(next);
  });

  it('writePrefs sanitizes a sloppy-input shape', async () => {
    const io = createInMemoryFileIo();
    await writePrefs({io, prefsPath: PREFS_PATH}, {
      version: 1,
      encryptionMode: 'rot13' as never,
      idleTimeoutMin: -5,
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.encryptionMode).toBe(DEFAULT_PREFS.encryptionMode);
    expect(r.idleTimeoutMin).toBe(DEFAULT_PREFS.idleTimeoutMin);
  });
});

describe('default (noop) logger', () => {
  it('uses the noop logger when caller omits it (warn paths swallowed)', async () => {
    const io = createInMemoryFileIo({[PREFS_PATH]: utf8.encode('{ broken')});
    // No `logger` field → noopLogger is used internally and the
    // call must not throw and must still return defaults.
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r).toEqual(DEFAULT_PREFS);
  });
});

describe('setEncryptionMode / setIdleTimeoutMin', () => {
  it('setEncryptionMode merges into existing prefs', async () => {
    const io = createInMemoryFileIo();
    await writePrefs({io, prefsPath: PREFS_PATH}, {
      version: 1,
      encryptionMode: 'plaintext',
      idleTimeoutMin: 22,
    });
    const r = await setEncryptionMode({io, prefsPath: PREFS_PATH}, 'encrypted');
    expect(r).toEqual({version: 1, encryptionMode: 'encrypted', idleTimeoutMin: 22});
  });

  it('setIdleTimeoutMin merges into existing prefs', async () => {
    const io = createInMemoryFileIo();
    await writePrefs({io, prefsPath: PREFS_PATH}, {
      version: 1,
      encryptionMode: 'encrypted',
      idleTimeoutMin: 5,
    });
    const r = await setIdleTimeoutMin({io, prefsPath: PREFS_PATH}, 30);
    expect(r.idleTimeoutMin).toBe(30);
    expect(r.encryptionMode).toBe('encrypted');
  });
});

describe('customSystemPrompt sanitization', () => {
  it('round-trips a valid custom prompt', async () => {
    const io = createInMemoryFileIo();
    const next: CopilotPrefs = {
      version: 1,
      encryptionMode: 'plaintext',
      idleTimeoutMin: 5,
      customSystemPrompt: 'You are a careful tutor.',
    };
    await writePrefs({io, prefsPath: PREFS_PATH}, next);
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customSystemPrompt).toBe('You are a careful tutor.');
  });

  it('drops a non-string customSystemPrompt', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({
          version: 1,
          encryptionMode: 'plaintext',
          idleTimeoutMin: 5,
          customSystemPrompt: 42,
        }),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customSystemPrompt).toBeUndefined();
  });

  it('drops a customSystemPrompt over the length cap', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({
          version: 1,
          encryptionMode: 'plaintext',
          idleTimeoutMin: 5,
          customSystemPrompt: 'x'.repeat(CUSTOM_SYSTEM_PROMPT_MAX + 1),
        }),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customSystemPrompt).toBeUndefined();
  });

  it('drops a whitespace-only customSystemPrompt', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({
          version: 1,
          encryptionMode: 'plaintext',
          idleTimeoutMin: 5,
          customSystemPrompt: '   \n   ',
        }),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customSystemPrompt).toBeUndefined();
  });

  it('setCustomSystemPrompt with null clears the field', async () => {
    const io = createInMemoryFileIo();
    await writePrefs({io, prefsPath: PREFS_PATH}, {
      version: 1,
      encryptionMode: 'plaintext',
      idleTimeoutMin: 5,
      customSystemPrompt: 'an override',
    });
    const r = await setCustomSystemPrompt({io, prefsPath: PREFS_PATH}, null);
    expect(r.customSystemPrompt).toBeUndefined();
  });

  it('setCustomSystemPrompt with empty string clears the field', async () => {
    const io = createInMemoryFileIo();
    await writePrefs({io, prefsPath: PREFS_PATH}, {
      version: 1,
      encryptionMode: 'plaintext',
      idleTimeoutMin: 5,
      customSystemPrompt: 'an override',
    });
    const r = await setCustomSystemPrompt({io, prefsPath: PREFS_PATH}, '');
    expect(r.customSystemPrompt).toBeUndefined();
  });

  it('setCustomSystemPrompt with content persists it', async () => {
    const io = createInMemoryFileIo();
    const r = await setCustomSystemPrompt(
      {io, prefsPath: PREFS_PATH},
      'a fresh persona',
    );
    expect(r.customSystemPrompt).toBe('a fresh persona');
    const back = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(back.customSystemPrompt).toBe('a fresh persona');
  });
});

describe('customActions sanitization', () => {
  const validAction = (over: Partial<CustomAction> = {}): CustomAction => ({
    id: 'id-1',
    label: 'Glossary',
    icon: '📖',
    prompt: 'Define key terms on this page in plain language.',
    ...over,
  });

  it('round-trips a valid action list', async () => {
    const io = createInMemoryFileIo();
    const actions = [validAction(), validAction({id: 'id-2', label: 'Risks'})];
    await writePrefs({io, prefsPath: PREFS_PATH}, {
      version: 1,
      encryptionMode: 'plaintext',
      idleTimeoutMin: 5,
      customActions: actions,
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customActions).toEqual(actions);
  });

  it('drops a non-array customActions', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({
          version: 1,
          encryptionMode: 'plaintext',
          idleTimeoutMin: 5,
          customActions: 'not an array',
        }),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customActions).toBeUndefined();
  });

  it.each([
    ['empty id', {id: ''}],
    ['blank label', {label: ''}],
    ['blank icon', {icon: ''}],
    ['blank prompt', {prompt: ''}],
    ['label over cap', {label: 'x'.repeat(100)}],
    ['icon over cap', {icon: 'too-long'}],
    ['prompt over cap', {prompt: 'x'.repeat(1000)}],
  ])('filters out an action with %s', async (_label, patch) => {
    const bad = {...validAction(), ...(patch as Partial<CustomAction>)};
    const good = validAction({id: 'id-keep'});
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({
          version: 1,
          encryptionMode: 'plaintext',
          idleTimeoutMin: 5,
          customActions: [bad, good],
        }),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customActions).toEqual([good]);
  });

  it('drops entirely non-object entries', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({
          version: 1,
          encryptionMode: 'plaintext',
          idleTimeoutMin: 5,
          customActions: [null, 7, 'str', validAction({id: 'survivor'})],
        }),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customActions).toHaveLength(1);
    expect(r.customActions?.[0].id).toBe('survivor');
  });

  it('caps the persisted list to CUSTOM_ACTION_LIMIT', async () => {
    const overflow = Array.from({length: CUSTOM_ACTION_LIMIT + 3}, (_, i) =>
      validAction({id: `id-${i}`}),
    );
    const io = createInMemoryFileIo();
    await writePrefs({io, prefsPath: PREFS_PATH}, {
      version: 1,
      encryptionMode: 'plaintext',
      idleTimeoutMin: 5,
      customActions: overflow,
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.customActions).toHaveLength(CUSTOM_ACTION_LIMIT);
  });

  it('setCustomActions writes through prefs', async () => {
    const io = createInMemoryFileIo();
    const list = [validAction()];
    const r = await setCustomActions({io, prefsPath: PREFS_PATH}, list);
    expect(r.customActions).toEqual(list);
    const back = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(back.customActions).toEqual(list);
  });

  it('an empty action list is dropped on disk (sanitizer collapses)', async () => {
    const io = createInMemoryFileIo();
    await setCustomActions({io, prefsPath: PREFS_PATH}, []);
    const back = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(back.customActions).toBeUndefined();
  });
});
