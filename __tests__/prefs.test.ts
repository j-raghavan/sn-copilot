/**
 * Tests for src/storage/prefs. Pins:
 *   1. Missing file → DEFAULT_PREFS.
 *   2. Empty file → DEFAULT_PREFS.
 *   3. Malformed JSON → DEFAULT_PREFS (with warn).
 *   4. Valid file round-trips.
 *   5. Invalid encryptionMode / idleTimeoutMin sanitized to defaults.
 *   6. setEncryptionMode / setIdleTimeoutMin update + persist.
 */
import {DEFAULT_PREFS, type CopilotPrefs} from '../src/types';
import {
  readPrefs,
  setEncryptionMode,
  setHasSeenSettings,
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


describe('hasSeenSettings sanitization', () => {
  it('defaults to undefined when not present', async () => {
    const io = createInMemoryFileIo();
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.hasSeenSettings).toBeUndefined();
  });

  it('reads true when persisted as true', async () => {
    const io = createInMemoryFileIo({
      [PREFS_PATH]: utf8.encode(
        JSON.stringify({
          version: 1,
          encryptionMode: 'plaintext',
          idleTimeoutMin: 10,
          hasSeenSettings: true,
        }),
      ),
    });
    const r = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(r.hasSeenSettings).toBe(true);
  });

  it.each([false, 'true' as unknown, 1 as unknown, null, undefined])(
    'collapses non-true value %p to undefined',
    async (bad) => {
      const io = createInMemoryFileIo({
        [PREFS_PATH]: utf8.encode(
          JSON.stringify({
            version: 1,
            encryptionMode: 'plaintext',
            idleTimeoutMin: 10,
            hasSeenSettings: bad,
          }),
        ),
      });
      const r = await readPrefs({io, prefsPath: PREFS_PATH});
      expect(r.hasSeenSettings).toBeUndefined();
    },
  );

  it('setHasSeenSettings(true) persists; setHasSeenSettings(false) clears', async () => {
    const io = createInMemoryFileIo();
    const after = await setHasSeenSettings({io, prefsPath: PREFS_PATH}, true);
    expect(after.hasSeenSettings).toBe(true);
    const back = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(back.hasSeenSettings).toBe(true);
    const cleared = await setHasSeenSettings({io, prefsPath: PREFS_PATH}, false);
    expect(cleared.hasSeenSettings).toBeUndefined();
    const finalBack = await readPrefs({io, prefsPath: PREFS_PATH});
    expect(finalBack.hasSeenSettings).toBeUndefined();
  });
});
