/**
 * Tests for src/storage/customActionsFile. Pins:
 *   1. Empty / missing file → empty array.
 *   2. One action per line; numbered icons starting at 1.
 *   3. First colon is the separator (prompts may contain colons).
 *   4. Blank lines + `#` comment lines are skipped.
 *   5. Lines without a `:` are skipped with a warn log.
 *   6. Caps at CUSTOM_ACTION_LIMIT with a single overflow warn.
 *   7. Over-cap label / prompt → skipped with a warn.
 *   8. CRLF + LF line endings both work.
 *   9. UTF-8 decode failure swallowed → empty list.
 */
import {
  parseCustomActionsText,
  readCustomActions,
} from '../src/storage/customActionsFile';
import {
  CUSTOM_ACTION_LABEL_MAX,
  CUSTOM_ACTION_LIMIT,
  CUSTOM_ACTION_PROMPT_MAX,
} from '../src/types';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';

const PATH = '/plugin/custom_actions.txt';
const utf8 = new TextEncoder();
const silent = {log: jest.fn(), warn: jest.fn(), error: jest.fn()};

beforeEach(() => {
  silent.log.mockClear();
  silent.warn.mockClear();
  silent.error.mockClear();
});

describe('parseCustomActionsText — pure parsing', () => {
  it('parses one valid action per line', () => {
    const actions = parseCustomActionsText(
      'Glossary: Define key terms\nRisks: List the risks',
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      id: 'file-0',
      icon: '1',
      label: 'Glossary',
      prompt: 'Define key terms',
    });
    expect(actions[1]).toEqual({
      id: 'file-1',
      icon: '2',
      label: 'Risks',
      prompt: 'List the risks',
    });
  });

  it('uses the FIRST colon as the separator so prompts may contain colons', () => {
    const actions = parseCustomActionsText(
      'Compare: List differences: A vs B (with rationale)',
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].prompt).toBe('List differences: A vs B (with rationale)');
  });

  it('skips blank lines and comment lines', () => {
    const actions = parseCustomActionsText(
      [
        '# comment 1',
        '',
        '   ',
        '# another comment',
        'Glossary: Define terms',
        '',
      ].join('\n'),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('Glossary');
  });

  it('skips lines without a `:` with a warn', () => {
    const actions = parseCustomActionsText(
      'no colon here\nValid: works',
      silent,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('Valid');
    expect(silent.warn).toHaveBeenCalled();
  });

  it('skips lines with blank label or prompt', () => {
    const actions = parseCustomActionsText(
      ['  : prompt with no label', 'label only:', 'OK: this is fine'].join(
        '\n',
      ),
      silent,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('OK');
  });

  it('caps the list at CUSTOM_ACTION_LIMIT with a single overflow warn', () => {
    const lines: string[] = [];
    for (let i = 0; i < CUSTOM_ACTION_LIMIT + 3; i++) {
      lines.push(`Act${i}: prompt ${i}`);
    }
    const actions = parseCustomActionsText(lines.join('\n'), silent);
    expect(actions).toHaveLength(CUSTOM_ACTION_LIMIT);
    // Exactly ONE overflow warn — not one per skipped line.
    const overflowWarns = silent.warn.mock.calls.filter((c) =>
      String(c[0]).includes('extras ignored'),
    );
    expect(overflowWarns).toHaveLength(1);
  });

  it('skips lines whose label exceeds the cap', () => {
    const long = 'x'.repeat(CUSTOM_ACTION_LABEL_MAX + 1);
    const actions = parseCustomActionsText(
      `${long}: prompt\nOK: valid`,
      silent,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('OK');
  });

  it('skips lines whose prompt exceeds the cap', () => {
    const longPrompt = 'x'.repeat(CUSTOM_ACTION_PROMPT_MAX + 1);
    const actions = parseCustomActionsText(
      `Label: ${longPrompt}\nOK: short`,
      silent,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('OK');
  });

  it('handles CRLF line endings', () => {
    const actions = parseCustomActionsText('A: 1\r\nB: 2\r\nC: 3');
    expect(actions.map((a) => a.label)).toEqual(['A', 'B', 'C']);
  });

  it('returns empty list when given empty string', () => {
    expect(parseCustomActionsText('')).toEqual([]);
  });
});

describe('readCustomActions — IO', () => {
  it('returns [] when the file is missing', async () => {
    const io = createInMemoryFileIo();
    const r = await readCustomActions({io, customActionsPath: PATH});
    expect(r).toEqual([]);
  });

  it('returns [] when the file is zero bytes', async () => {
    const io = createInMemoryFileIo({[PATH]: new Uint8Array(0)});
    const r = await readCustomActions({io, customActionsPath: PATH});
    expect(r).toEqual([]);
  });

  it('returns [] when readBytes throws', async () => {
    const io = createInMemoryFileIo();
    io.readBytes = async () => {
      throw new Error('disk gone');
    };
    const r = await readCustomActions({
      io,
      customActionsPath: PATH,
      logger: silent,
    });
    expect(r).toEqual([]);
    expect(silent.warn).toHaveBeenCalled();
  });

  it('parses a real file end-to-end', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode(
        '# my actions\nGlossary: Define key terms\nRisks: List the risks\n',
      ),
    });
    const r = await readCustomActions({io, customActionsPath: PATH});
    expect(r.map((a) => a.label)).toEqual(['Glossary', 'Risks']);
    expect(r.map((a) => a.icon)).toEqual(['1', '2']);
  });

  it('uses the default path when customActionsPath is omitted', async () => {
    const io = createInMemoryFileIo();
    const r = await readCustomActions({io});
    expect(r).toEqual([]);
  });
});
