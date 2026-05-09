/**
 * Tests for src/storage/keyFiles. Pins:
 *   1. matchKeyFilename — canonical names, tolerance map, case-
 *      insensitive, rejects non-key filenames.
 *   2. parseKeyFile — every row of the forgiving-parser table:
 *        - trailing/leading whitespace on values
 *        - whitespace around `=`
 *        - tabs vs spaces
 *        - LF / CRLF / mixed line endings
 *        - comment lines (`#`)
 *        - blank lines
 *        - trailing comments NOT stripped
 *        - quotes NOT stripped
 *        - duplicate keys (last wins, warning logged)
 *        - unknown keys (logged, ignored)
 *        - missing required field
 *        - filename suffix mismatch
 *        - mode validation
 *        - default_provider validation
 *        - clarify_redact validation
 *   3. discoverKeyFiles — listFiles failure, empty dir, mixed valid +
 *      invalid + non-key files, parse-error reporting.
 */
import {
  discoverKeyFiles,
  matchKeyFilename,
  parseKeyFile,
} from '../src/storage/keyFiles';

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

describe('matchKeyFilename — tolerance map', () => {
  it.each([
    ['copilot-key-anthropic.txt', 'anthropic'],
    ['copilot-key-claude.txt', 'anthropic'],
    ['copilot-key-claude-ai.txt', 'anthropic'],
    ['copilot-key-claude-anthropic.txt', 'anthropic'],
    ['copilot-key-openai.txt', 'openai'],
    ['copilot-key-gpt.txt', 'openai'],
    ['copilot-key-chatgpt.txt', 'openai'],
    ['copilot-key-gemini.txt', 'gemini'],
    ['copilot-key-google.txt', 'gemini'],
    ['copilot-key-google-gemini.txt', 'gemini'],
    ['copilot-key-deepseek.txt', 'deepseek'],
  ])('%s → %s', (filename, expected) => {
    expect(matchKeyFilename(filename)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(matchKeyFilename('Copilot-Key-OpenAI.txt')).toBe('openai');
    expect(matchKeyFilename('COPILOT-KEY-CLAUDE.TXT')).toBe('anthropic');
  });

  it('trims leading/trailing whitespace', () => {
    expect(matchKeyFilename('  copilot-key-gemini.txt  ')).toBe('gemini');
  });

  it.each([
    'random.txt',
    'copilot-key-grok.txt',
    'copilot-key-.txt',
    'key-anthropic.txt',
    'copilot-key-claude.json',
    '',
  ])('rejects non-matching filename %s', (filename) => {
    expect(matchKeyFilename(filename)).toBeNull();
  });
});

describe('parseKeyFile — required fields', () => {
  it('parses a minimal valid file', () => {
    const text = 'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-x\n';
    const r = parseKeyFile(
      text,
      '/tmp/copilot-key-anthropic.txt',
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.provider).toBe('anthropic');
      expect(r.file.model).toBe('claude-haiku-4-5');
      expect(r.file.key).toBe('sk-ant-x');
      expect(r.file.mode).toBe('text');
    }
  });

  it('rejects unrecognised filename', () => {
    const r = parseKeyFile('provider=anthropic\nmodel=x\nkey=y',
      '/tmp/random.txt',
      silentLogger,
    );
    expect(r.kind).toBe('parse-error');
  });

  it('rejects missing provider', () => {
    const r = parseKeyFile(
      'model=x\nkey=y',
      '/tmp/copilot-key-anthropic.txt',
      silentLogger,
    );
    expect(r.kind).toBe('parse-error');
    if (r.kind === 'parse-error') {
      expect(r.reason).toContain('provider');
    }
  });

  it('rejects missing key', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=x\n',
      '/tmp/copilot-key-anthropic.txt',
      silentLogger,
    );
    expect(r.kind).toBe('parse-error');
    if (r.kind === 'parse-error') {
      expect(r.reason).toContain('key');
    }
  });

  it('rejects missing model', () => {
    const r = parseKeyFile(
      'provider=anthropic\nkey=y\n',
      '/tmp/copilot-key-anthropic.txt',
      silentLogger,
    );
    expect(r.kind).toBe('parse-error');
    if (r.kind === 'parse-error') {
      expect(r.reason).toContain('model');
    }
  });

  it('rejects mismatch between filename suffix and provider= field', () => {
    // Filename says claude → expects anthropic; provider=openai
    const r = parseKeyFile(
      'provider=openai\nmodel=x\nkey=y\n',
      '/tmp/copilot-key-claude.txt',
      silentLogger,
    );
    expect(r.kind).toBe('parse-error');
    if (r.kind === 'parse-error') {
      expect(r.reason).toContain('mismatches');
    }
  });

  it('canonical-name file accepts canonical provider value', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=x\nkey=y\n',
      '/tmp/copilot-key-claude.txt',
      silentLogger,
    );
    expect(r.kind).toBe('ok');
  });
});

describe('parseKeyFile — forgiving parser quirks', () => {
  const path = '/tmp/copilot-key-anthropic.txt';

  it('trims whitespace around values', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=  haiku  \nkey=  sk-ant-x  \n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.model).toBe('haiku');
      expect(r.file.key).toBe('sk-ant-x');
    }
  });

  it('tolerates whitespace around =', () => {
    const r = parseKeyFile(
      'provider = anthropic\nmodel\t=\thaiku\nkey  =  sk-ant-x\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.provider).toBe('anthropic');
    }
  });

  it('accepts CRLF line endings', () => {
    const r = parseKeyFile(
      'provider=anthropic\r\nmodel=haiku\r\nkey=sk-ant-x\r\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
  });

  it('accepts mixed LF/CRLF line endings', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=haiku\r\nkey=sk-ant-x\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
  });

  it('ignores comment lines and blank lines', () => {
    const r = parseKeyFile(
      '# This is a comment\n\nprovider=anthropic\n\n# Another\nmodel=x\nkey=y\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
  });

  it('does NOT strip trailing comments (# is part of the value)', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=haiku\nkey=sk-ant-x # not stripped\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.key).toBe('sk-ant-x # not stripped');
    }
  });

  it('does NOT strip surrounding quotes', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=haiku\nkey="sk-ant-x"\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.key).toBe('"sk-ant-x"');
    }
  });

  it('on duplicate key: last value wins, warning logged', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=haiku\nkey=first\nkey=second\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.key).toBe('second');
    }
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it('logs and ignores unknown keys', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=haiku\nkey=y\ntemperature=0.7\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    expect(silentLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('unknown key "temperature"'),
    );
  });

  it('logs and ignores malformed lines (no =)', () => {
    const r = parseKeyFile(
      'provider=anthropic\nthis is not key=value\nmodel=haiku\nkey=y\n',
      path,
      silentLogger,
    );
    // The line `this is not key=value` HAS an `=`, so it's parsed as
    // key="this is not key", value="value". Adjust to a truly
    // malformed line.
    const r2 = parseKeyFile(
      'provider=anthropic\nthis_has_no_equals_at_all\nmodel=haiku\nkey=y\n',
      path,
      silentLogger,
    );
    expect(r2.kind).toBe('ok');
    expect(silentLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('malformed line'),
    );
    // suppress unused
    expect(r.kind).toBe('ok');
  });

  it('logs and ignores empty-key lines (=value)', () => {
    const r = parseKeyFile(
      'provider=anthropic\n=orphan\nmodel=haiku\nkey=y\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    expect(silentLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('empty key'),
    );
  });
});

describe('parseKeyFile — optional fields', () => {
  const path = '/tmp/copilot-key-anthropic.txt';

  it('mode=image is honoured', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=x\nkey=y\nmode=image\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.mode).toBe('image');
    }
  });

  it('invalid mode is logged and falls back to text', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=x\nkey=y\nmode=bogus\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.mode).toBe('text');
    }
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid mode'),
    );
  });

  it('default_provider is parsed', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=x\nkey=y\ndefault_provider=gemini\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.defaultProvider).toBe('gemini');
    }
  });

  it('invalid default_provider is logged and ignored', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=x\nkey=y\ndefault_provider=bogus\n',
      path,
      silentLogger,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.file.defaultProvider).toBeUndefined();
    }
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid default_provider'),
    );
  });

  it.each(['on', 'true'])('clarify_redact=%s → true', val => {
    const r = parseKeyFile(
      `provider=anthropic\nmodel=x\nkey=y\nclarify_redact=${val}\n`,
      path,
      silentLogger,
    );
    if (r.kind === 'ok') {
      expect(r.file.clarifyRedact).toBe(true);
    }
  });

  it.each(['off', 'false'])('clarify_redact=%s → false', val => {
    const r = parseKeyFile(
      `provider=anthropic\nmodel=x\nkey=y\nclarify_redact=${val}\n`,
      path,
      silentLogger,
    );
    if (r.kind === 'ok') {
      expect(r.file.clarifyRedact).toBe(false);
    }
  });

  it('invalid clarify_redact is logged and ignored', () => {
    const r = parseKeyFile(
      'provider=anthropic\nmodel=x\nkey=y\nclarify_redact=maybe\n',
      path,
      silentLogger,
    );
    if (r.kind === 'ok') {
      expect(r.file.clarifyRedact).toBeUndefined();
    }
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid clarify_redact'),
    );
  });
});

describe('discoverKeyFiles', () => {
  const root = '/storage/emulated/0/MyStyle/SnCopilot';

  type FileEntry = {path: string; type: number};
  const makeFs = (
    listResult: FileEntry[] | null | undefined | Error,
  ) => ({
    exists: jest.fn(async () => true),
    listFiles: jest.fn(
      async (): Promise<FileEntry[] | null | undefined> => {
        if (listResult instanceof Error) {
          throw listResult;
        }
        return listResult;
      },
    ),
  });

  const fileEntry = (path: string): FileEntry => ({path, type: 1});
  const dirEntry = (path: string): FileEntry => ({path, type: 0});

  // Default fetch mock used when a test doesn't override it.
  const buildFetchOk = (text: string): jest.Mock =>
    jest.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    })) as unknown as jest.Mock;

  it('returns empty when listFiles throws (dir does not exist)', async () => {
    const fs = makeFs(new Error('Dir not exists'));
    const r = await discoverKeyFiles({
      fileUtils: fs,
      fetchFn: jest.fn() as unknown as typeof fetch,
      logger: silentLogger,
    });
    expect(r.files).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });

  it('returns empty when listFiles returns null', async () => {
    const fs = makeFs(null);
    const r = await discoverKeyFiles({
      fileUtils: fs,
      fetchFn: jest.fn() as unknown as typeof fetch,
      logger: silentLogger,
    });
    expect(r.files).toHaveLength(0);
  });

  it('returns empty when listFiles returns []', async () => {
    const fs = makeFs([]);
    const r = await discoverKeyFiles({
      fileUtils: fs,
      fetchFn: jest.fn() as unknown as typeof fetch,
      logger: silentLogger,
    });
    expect(r.files).toHaveLength(0);
  });

  it('parses one valid key file', async () => {
    const fs = makeFs([fileEntry(`${root}/copilot-key-anthropic.txt`)]);
    const fetchFn = buildFetchOk('provider=anthropic\nmodel=x\nkey=y\n');
    const r = await discoverKeyFiles({
      fileUtils: fs,
      fetchFn: fetchFn as unknown as typeof fetch,
      logger: silentLogger,
    });
    expect(r.files).toHaveLength(1);
    expect(r.files[0].provider).toBe('anthropic');
    // Verify the file:// URL convention is used.
    expect(fetchFn.mock.calls[0][0]).toBe(
      `file://${root}/copilot-key-anthropic.txt`,
    );
  });

  it('skips non-key filenames and directories', async () => {
    const fs = makeFs([
      fileEntry(`${root}/random.txt`),
      fileEntry(`${root}/copilot-key-claude.txt`),
      fileEntry(`${root}/notes.md`),
      // A subdirectory whose name matches the key-file pattern but
      // type=0 must be ignored (defensive — type filter rejects it).
      dirEntry(`${root}/copilot-key-anthropic.txt`),
    ]);
    const fetchFn = buildFetchOk('provider=anthropic\nmodel=x\nkey=y\n');
    const r = await discoverKeyFiles({
      fileUtils: fs,
      fetchFn: fetchFn as unknown as typeof fetch,
      logger: silentLogger,
    });
    expect(r.files).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reports per-file fetch failure as parse-error', async () => {
    const fs = makeFs([fileEntry(`${root}/copilot-key-openai.txt`)]);
    const fetchFn = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '',
    })) as unknown as typeof fetch;
    const r = await discoverKeyFiles({
      fileUtils: fs,
      fetchFn,
      logger: silentLogger,
    });
    expect(r.files).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toContain('403');
  });

  it('reports per-file fetch throw as parse-error', async () => {
    const fs = makeFs([fileEntry(`${root}/copilot-key-openai.txt`)]);
    const fetchFn = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await discoverKeyFiles({
      fileUtils: fs,
      fetchFn,
      logger: silentLogger,
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toContain('network down');
  });

  it('uses default logger when none provided', async () => {
    const fs = makeFs(null);
    const r = await discoverKeyFiles({
      fileUtils: fs,
      fetchFn: jest.fn() as unknown as typeof fetch,
    });
    expect(r.files).toHaveLength(0);
  });
});
