/**
 * Tests for src/storage/personaFile. Pins:
 *   1. Missing / empty file → null (caller falls back to SYSTEM_PROMPT).
 *   2. Whitespace-only file → null.
 *   3. Trimmed file content is returned verbatim.
 *   4. Over-cap content → null + warn.
 *   5. writePersona(null/empty) deletes the file.
 *   6. writePersona(content) round-trips through readPersona.
 *   7. writePersona throws when content exceeds the cap.
 *   8. clearPersona removes the file.
 *   9. Read error swallowed → null (UI never blocked by a bad file).
 */
import {
  PERSONA_MAX_CHARS,
  clearPersona,
  readPersona,
  writePersona,
} from '../src/storage/personaFile';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';

const PATH = '/plugin/system_prompt.txt';
const utf8 = new TextEncoder();
const silent = {log: jest.fn(), warn: jest.fn(), error: jest.fn()};

beforeEach(() => {
  silent.log.mockClear();
  silent.warn.mockClear();
  silent.error.mockClear();
});

describe('readPersona', () => {
  it('returns null when no file exists', async () => {
    const io = createInMemoryFileIo();
    const r = await readPersona({io, personaPath: PATH});
    expect(r).toBeNull();
  });

  it('returns null on zero-byte file', async () => {
    const io = createInMemoryFileIo({[PATH]: new Uint8Array(0)});
    const r = await readPersona({io, personaPath: PATH});
    expect(r).toBeNull();
  });

  it('returns null on whitespace-only file', async () => {
    const io = createInMemoryFileIo({[PATH]: utf8.encode('   \n\t  ')});
    const r = await readPersona({io, personaPath: PATH});
    expect(r).toBeNull();
  });

  it('trims and returns valid content', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode('  You are a careful tutor.  \n'),
    });
    const r = await readPersona({io, personaPath: PATH});
    expect(r).toBe('You are a careful tutor.');
  });

  it('rejects content over the length cap with a warn', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode('x'.repeat(PERSONA_MAX_CHARS + 1)),
    });
    const r = await readPersona({io, personaPath: PATH, logger: silent});
    expect(r).toBeNull();
    expect(silent.warn).toHaveBeenCalled();
  });

  it('returns null when readBytes throws', async () => {
    const io = createInMemoryFileIo();
    io.readBytes = async () => {
      throw new Error('disk gone');
    };
    const r = await readPersona({io, personaPath: PATH, logger: silent});
    expect(r).toBeNull();
    expect(silent.warn).toHaveBeenCalled();
  });

  it('uses the default path when personaPath is omitted', async () => {
    // Smoke test: the default path constant is exported and the
    // reader uses it. Hard to inspect directly; we just verify the
    // call doesn't throw when no override is provided.
    const io = createInMemoryFileIo();
    const r = await readPersona({io});
    expect(r).toBeNull();
  });

  it('uses noopLogger when no logger is provided (no throw)', async () => {
    const io = createInMemoryFileIo({
      [PATH]: utf8.encode('x'.repeat(PERSONA_MAX_CHARS + 1)),
    });
    const r = await readPersona({io, personaPath: PATH});
    expect(r).toBeNull();
  });
});

describe('writePersona', () => {
  it('writes content and readPersona returns it', async () => {
    const io = createInMemoryFileIo();
    await writePersona({io, personaPath: PATH}, 'You are a precise tutor.');
    const r = await readPersona({io, personaPath: PATH});
    expect(r).toBe('You are a precise tutor.');
  });

  it('deletes the file when content is null', async () => {
    const io = createInMemoryFileIo({[PATH]: utf8.encode('something')});
    await writePersona({io, personaPath: PATH}, null);
    expect(io.fs.has(PATH)).toBe(false);
  });

  it('deletes the file when content is whitespace-only', async () => {
    const io = createInMemoryFileIo({[PATH]: utf8.encode('something')});
    await writePersona({io, personaPath: PATH}, '   ');
    expect(io.fs.has(PATH)).toBe(false);
  });

  it('throws when content exceeds the cap', async () => {
    const io = createInMemoryFileIo();
    await expect(
      writePersona(
        {io, personaPath: PATH},
        'x'.repeat(PERSONA_MAX_CHARS + 1),
      ),
    ).rejects.toThrow(/PERSONA_MAX|chars/);
  });

  it('clearPersona removes the file', async () => {
    const io = createInMemoryFileIo({[PATH]: utf8.encode('something')});
    await clearPersona({io, personaPath: PATH});
    expect(io.fs.has(PATH)).toBe(false);
  });
});
