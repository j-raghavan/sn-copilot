/**
 * Tests for src/scope/captureScreenshot — the page-context capture
 * primitive run on sidebar tap.
 *
 * Pins:
 *   1. Happy path: getCurrentFilePath + getCurrentPageNum unwrap →
 *      generateNotePng(success) → fetch(file://) → arrayBuffer →
 *      base64. Returns {notePath, page, screenshotPath, base64}.
 *   2. Non-.note file (e.g. PDF) → null with log.
 *   3. comm probe throws → null.
 *   4. comm probe returns null result → null.
 *   5. getPluginDirPath null/undefined → falls back to /sdcard/Android/data.
 *   6. getPluginDirPath throws → null.
 *   7. generateNotePng throws → null.
 *   8. generateNotePng returns success: false → null.
 *   9. fetch returns ok=false → null.
 *  10. fetch throws → null.
 */
import {
  captureCurrentPage,
  sweepScratchOrphans,
} from '../src/scope/captureScreenshot';

const silentLogger = {log: jest.fn(), warn: jest.fn()};

beforeEach(() => {
  silentLogger.log.mockClear();
  silentLogger.warn.mockClear();
});

const okComm = {
  getCurrentFilePath: jest.fn(async () => ({
    success: true,
    result: '/sd/notes/x.note',
  })),
  getCurrentPageNum: jest.fn(async () => ({success: true, result: 5})),
  recognizeElements: jest.fn(async () => ({
    success: true,
    result: 'recognized handwriting',
  })),
};

const okFile = {
  generateNotePng: jest.fn(async () => ({success: true, result: true})),
  getElements: jest.fn(async () => ({
    success: true,
    result: [
      {textBox: {textContentFull: 'typed line one'}},
      {textBox: {textContentFull: 'typed line two'}},
      {textBox: null},
      {/* stroke-like element with no textBox */},
    ],
  })),
  getPageSize: jest.fn(async () => ({
    success: true,
    result: {width: 1404, height: 1872},
  })),
};

const okManager = {
  getPluginDirPath: jest.fn(async () => '/data/user/0/com.sncopilot/files'),
};

// Doc API stub — used only when filePath is .pdf or .epub. The
// note-path tests still pass it in (cheap, keeps the call sites
// uniform) but never trigger it.
const okDoc = {
  generateCurrentDocImage: jest.fn(async () => ({success: true, result: true})),
  getCurrentDocText: jest.fn(async () => ({
    success: true,
    result: 'doc text content',
  })),
};

const okFetch = jest.fn(async () => ({
  ok: true,
  arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
})) as unknown as typeof fetch;

beforeEach(() => {
  okComm.getCurrentFilePath.mockClear();
  okComm.getCurrentPageNum.mockClear();
  okComm.recognizeElements.mockClear();
  okFile.generateNotePng.mockClear();
  okFile.getElements.mockClear();
  okFile.getPageSize.mockClear();
  okManager.getPluginDirPath.mockClear();
  okDoc.generateCurrentDocImage.mockClear();
  okDoc.getCurrentDocText.mockClear();
});

describe('captureCurrentPage — happy path', () => {
  it('captures + returns base64 screenshot AND transcribed text for a .note', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.notePath).toBe('/sd/notes/x.note');
    expect(ctx?.page).toBe(5);
    // Path is now dir + unique scratch filename (copilot-page-<ts>-<n>.png)
    expect(ctx?.screenshotPath).toMatch(
      /^\/data\/user\/0\/com\.sncopilot\/files\/copilot-page-\d+-\d+\.png$/,
    );
    expect(ctx?.screenshotBase64.length).toBeGreaterThan(0);
    // pageText: typed text first, then handwriting recognition
    expect(ctx?.pageText).toBe(
      'typed line one\ntyped line two\n\nrecognized handwriting',
    );
    // generateNotePng was called with the resolved scratch path
    expect(okFile.generateNotePng).toHaveBeenCalledWith({
      notePath: '/sd/notes/x.note',
      page: 5,
      times: 1,
      pngPath: ctx?.screenshotPath,
      type: 1,
    });
    // recognizeElements was called with the page size
    expect(okComm.recognizeElements).toHaveBeenCalledWith(
      expect.any(Array),
      {width: 1404, height: 1872},
    );
  });

  it('still returns the screenshot when pageText extraction fails', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        recognizeElements: jest.fn(async () => {
          throw new Error('OCR boom');
        }),
      },
      file: {
        ...okFile,
        getElements: jest.fn(async () => {
          throw new Error('elements boom');
        }),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    // Screenshot still succeeded; text path skipped → empty.
    expect(ctx).not.toBeNull();
    expect(ctx?.pageText).toBe('');
    expect(ctx?.screenshotBase64.length).toBeGreaterThan(0);
  });

  it('skips recognizeElements when there are no elements', async () => {
    const recognize = jest.fn();
    const ctx = await captureCurrentPage({
      comm: {...okComm, recognizeElements: recognize},
      file: {
        ...okFile,
        getElements: jest.fn(async () => ({success: true, result: []})),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx?.pageText).toBe('');
    expect(recognize).not.toHaveBeenCalled();
  });

  it('skips OCR when getPageSize returns invalid shape', async () => {
    const recognize = jest.fn();
    const ctx = await captureCurrentPage({
      comm: {...okComm, recognizeElements: recognize},
      file: {
        ...okFile,
        getPageSize: jest.fn(async () => ({success: false, result: null})),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    // Typed text still extracted; OCR skipped because page size missing
    expect(ctx?.pageText).toBe('typed line one\ntyped line two');
    expect(recognize).not.toHaveBeenCalled();
  });

  it('handles recognizeElements returning non-string result', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        recognizeElements: jest.fn(async () => ({
          success: true,
          result: null,
        })),
      },
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    // Typed text only; recognized text discarded
    expect(ctx?.pageText).toBe('typed line one\ntyped line two');
  });

  it('handles recognizeElements returning whitespace-only string', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        recognizeElements: jest.fn(async () => ({
          success: true,
          result: '   \n  ',
        })),
      },
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx?.pageText).toBe('typed line one\ntyped line two');
  });

  it('handles getElements returning non-array result', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: {
        ...okFile,
        getElements: jest.fn(async () => ({success: true, result: null})),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    // No elements → no typed text, no OCR call → empty pageText
    expect(ctx?.pageText).toBe('');
  });

  it('handles getPageSize resolving to null (not wrapped envelope)', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: {
        ...okFile,
        getPageSize: jest.fn(async () => null),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    // Typed text still extracted; OCR skipped because pageSize null.
    expect(ctx?.pageText).toBe('typed line one\ntyped line two');
  });

  it('handles getPageSize result with non-numeric width/height', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: {
        ...okFile,
        getPageSize: jest.fn(async () => ({
          success: true,
          result: {width: 'oops', height: 1872},
        })),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx?.pageText).toBe('typed line one\ntyped line two');
  });

  it('handles getElements resolving to null (not wrapped envelope)', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: {
        ...okFile,
        getElements: jest.fn(async () => null),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx?.pageText).toBe('');
  });

  it('tolerates malformed element shapes (no textBox or non-string content)', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        recognizeElements: jest.fn(async () => ({
          success: true,
          result: 'rec',
        })),
      },
      file: {
        ...okFile,
        getElements: jest.fn(async () => ({
          success: true,
          result: [
            null,
            'string-element',
            {},
            {textBox: 'not-an-object'},
            {textBox: {textContentFull: 42}},
            {textBox: {textContentFull: ''}},
            {textBox: {textContentFull: 'real text'}},
          ],
        })),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx?.pageText).toBe('real text\n\nrec');
  });

  it('falls back to /sdcard/Android/data when getPluginDirPath returns null', async () => {
    const m = {getPluginDirPath: jest.fn(async () => null)};
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: m,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx?.screenshotPath).toMatch(
      /^\/sdcard\/Android\/data\/copilot-page-\d+-\d+\.png$/,
    );
  });

  it('falls back when getPluginDirPath returns empty string', async () => {
    const m = {getPluginDirPath: jest.fn(async () => '')};
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: m,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx?.screenshotPath).toMatch(
      /^\/sdcard\/Android\/data\/copilot-page-\d+-\d+\.png$/,
    );
  });

  it('two captures get distinct scratch paths', async () => {
    const a = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    const b = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(a?.screenshotPath).toBeDefined();
    expect(b?.screenshotPath).toBeDefined();
    expect(a?.screenshotPath).not.toBe(b?.screenshotPath);
  });

  it('uses default logger and globalThis.fetch when omitted', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const ctx = await captureCurrentPage({
        comm: okComm,
        file: okFile,
        doc: okDoc,
        manager: okManager,
      });
      expect(ctx).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('captureCurrentPage — early returns', () => {
  it('returns null when getCurrentFilePath throws', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        getCurrentFilePath: jest.fn(async () => {
          throw new Error('comm boom');
        }),
      },
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('comm probe threw'),
    );
  });

  it('returns null when getCurrentFilePath returns no result', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        getCurrentFilePath: jest.fn(async () => ({success: false})),
        getCurrentPageNum: jest.fn(async () => ({success: true, result: 0})),
      },
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
  });

  it('returns null when getCurrentPageNum returns no result', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        getCurrentFilePath: jest.fn(async () => ({
          success: true,
          result: '/sd/x.note',
        })),
        getCurrentPageNum: jest.fn(async () => ({success: false})),
      },
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
  });

  it('returns null for unsupported file types (e.g. .txt)', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        getCurrentFilePath: jest.fn(async () => ({
          success: true,
          result: '/sd/docs/notes.txt',
        })),
        getCurrentPageNum: jest.fn(async () => ({success: true, result: 1})),
      },
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('unsupported file type'),
    );
  });

  it('returns null when getPluginDirPath throws', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: {
        getPluginDirPath: jest.fn(async () => {
          throw new Error('dir lookup failed');
        }),
      },
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('getPluginDirPath threw'),
    );
  });

  it('returns null when generateNotePng throws', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: {
        ...okFile,
        generateNotePng: jest.fn(async () => {
          throw new Error('render boom');
        }),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('generateNotePng threw'),
    );
  });

  it('returns null when generateNotePng resolves with success=false', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: {
        ...okFile,
        generateNotePng: jest.fn(async () => ({success: false, error: {code: 9}})),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('generateNotePng failed'),
    );
  });

  it('returns null when generateNotePng resolves with non-object', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: {
        ...okFile,
        generateNotePng: jest.fn(async () => null),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
  });

  it('returns null when png fetch returns ok=false', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: (jest.fn(async () => ({
        ok: false,
        status: 404,
      })) as unknown) as typeof fetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('status 404'),
    );
  });

  it('returns null when png fetch throws', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: (jest.fn(async () => {
        throw new Error('IO');
      }) as unknown) as typeof fetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('png fetch threw'),
    );
  });
});

describe('captureCurrentPage — doc path (.pdf / .epub)', () => {
  const docComm = (path: string) => ({
    ...okComm,
    getCurrentFilePath: jest.fn(async () => ({success: true, result: path})),
    getCurrentPageNum: jest.fn(async () => ({success: true, result: 3})),
  });

  it('renders + reads text for a .pdf via PluginDocAPI', async () => {
    const ctx = await captureCurrentPage({
      comm: docComm('/sd/docs/spec.pdf'),
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.notePath).toBe('/sd/docs/spec.pdf');
    expect(ctx?.page).toBe(3);
    expect(ctx?.pageText).toBe('doc text content');
    expect(ctx?.screenshotBase64.length).toBeGreaterThan(0);
    // Note APIs must NOT be invoked on the doc path.
    expect(okFile.generateNotePng).not.toHaveBeenCalled();
    // Doc API was called with the resolved scratch path + default size.
    // generateCurrentDocImage renders the *current* doc, so it takes
    // no docPath; the trailing 1 asks for text-selection styles
    // (highlight/underline) to be included in the render.
    expect(okDoc.generateCurrentDocImage).toHaveBeenCalledWith(
      3,
      ctx?.screenshotPath,
      {width: 1404, height: 1872},
      1,
    );
    expect(okDoc.getCurrentDocText).toHaveBeenCalledWith(3);
  });

  it('also handles .epub (case-insensitive)', async () => {
    const ctx = await captureCurrentPage({
      comm: docComm('/sd/docs/Book.EPUB'),
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).not.toBeNull();
    expect(okDoc.generateCurrentDocImage).toHaveBeenCalled();
  });

  it('honours docImageSize override', async () => {
    await captureCurrentPage({
      comm: docComm('/sd/docs/spec.pdf'),
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
      docImageSize: {width: 800, height: 1000},
    });
    expect(okDoc.generateCurrentDocImage).toHaveBeenCalledWith(
      3,
      expect.any(String),
      {width: 800, height: 1000},
      1,
    );
  });

  it('returns null when generateCurrentDocImage rejects', async () => {
    const ctx = await captureCurrentPage({
      comm: docComm('/sd/docs/spec.pdf'),
      file: okFile,
      doc: {
        ...okDoc,
        generateCurrentDocImage: jest.fn(async () => {
          throw new Error('render boom');
        }),
      },
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('generateCurrentDocImage threw'),
    );
  });

  it('returns null when generateCurrentDocImage reports success: false', async () => {
    const ctx = await captureCurrentPage({
      comm: docComm('/sd/docs/spec.pdf'),
      file: okFile,
      doc: {
        ...okDoc,
        generateCurrentDocImage: jest.fn(async () => ({success: false})),
      },
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('generateCurrentDocImage failed'),
    );
  });

  it('still returns the screenshot when getCurrentDocText throws', async () => {
    const ctx = await captureCurrentPage({
      comm: docComm('/sd/docs/spec.pdf'),
      file: okFile,
      doc: {
        ...okDoc,
        getCurrentDocText: jest.fn(async () => {
          throw new Error('text boom');
        }),
      },
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.pageText).toBe('');
    expect(ctx?.screenshotBase64.length).toBeGreaterThan(0);
  });

  it('falls back to empty pageText when getCurrentDocText returns non-string', async () => {
    const ctx = await captureCurrentPage({
      comm: docComm('/sd/docs/spec.pdf'),
      file: okFile,
      doc: {
        ...okDoc,
        getCurrentDocText: jest.fn(async () => ({success: true, result: null})),
      },
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx?.pageText).toBe('');
  });
});

describe('captureCurrentPage — scratch PNG deletion', () => {
  // Same shape as the doc-path describe's helper — scoped there, so
  // redeclared here for the one doc-path deletion test.
  const docComm = (path: string) => ({
    ...okComm,
    getCurrentFilePath: jest.fn(async () => ({success: true, result: path})),
    getCurrentPageNum: jest.fn(async () => ({success: true, result: 3})),
  });

  it('deletes the scratch PNG after a successful .note capture', async () => {
    const deleteFile = jest.fn(async () => true);
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
      deleteFile,
    });
    expect(ctx).not.toBeNull();
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(ctx?.screenshotPath);
    // The base64 was read BEFORE deletion — still fully usable.
    expect(ctx?.screenshotBase64.length).toBeGreaterThan(0);
  });

  it('deletes the scratch PNG after a successful doc capture', async () => {
    const deleteFile = jest.fn(async () => true);
    const ctx = await captureCurrentPage({
      comm: docComm('/sd/docs/spec.pdf'),
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
      deleteFile,
    });
    expect(ctx).not.toBeNull();
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(ctx?.screenshotPath);
  });

  it('deletes the scratch PNG even when the file:// read fails', async () => {
    const deleteFile = jest.fn(async () => true);
    const failFetch = jest.fn(async () => ({
      ok: false,
      status: 404,
    })) as unknown as typeof fetch;
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: failFetch,
      logger: silentLogger,
      deleteFile,
    });
    expect(ctx).toBeNull();
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it('attempts deletion of a partial file when generateNotePng fails', async () => {
    const deleteFile = jest.fn(async () => true);
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: {
        ...okFile,
        generateNotePng: jest.fn(async () => ({success: false})),
      },
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
      deleteFile,
    });
    expect(ctx).toBeNull();
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it('capture still succeeds when deleteFile throws', async () => {
    const deleteFile = jest.fn(async () => {
      throw new Error('delete boom');
    });
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
      deleteFile,
    });
    expect(ctx).not.toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('scratch delete threw'),
    );
  });

  it('warns (but succeeds) when deleteFile returns false', async () => {
    const deleteFile = jest.fn(async () => false);
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
      deleteFile,
    });
    expect(ctx).not.toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('scratch delete returned false'),
    );
  });

  it('does not attempt deletion when deleteFile is not provided (legacy deps)', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).not.toBeNull();
    // No warn about scratch deletion in the no-deleteFile mode.
    expect(silentLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('scratch delete'),
    );
  });
});

describe('sweepScratchOrphans', () => {
  const scratchDir = '/data/user/0/com.sncopilot/files';

  const entry = (name: string, type = 1) => ({
    path: `${scratchDir}/${name}`,
    type,
  });

  it('removes only files matching the scratch pattern', async () => {
    const deleteFile = jest.fn(async () => true);
    const removed = await sweepScratchOrphans({
      manager: okManager,
      listFiles: jest.fn(async () => [
        entry('copilot-page-1748000000000-0.png'),
        entry('copilot-page-1748000000001-3.png'),
        entry('copilot-conversations.json'),
        entry('copilot-page-not-numeric.png'),
        entry('user-photo copilot-page-1-1.png'),
        entry('copilot-page-1748000000002-4.png', 0), // directory — skipped
      ]),
      deleteFile,
      logger: silentLogger,
    });
    expect(removed).toBe(2);
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith(
      `${scratchDir}/copilot-page-1748000000000-0.png`,
    );
    expect(deleteFile).toHaveBeenCalledWith(
      `${scratchDir}/copilot-page-1748000000001-3.png`,
    );
  });

  it('returns 0 when the directory is empty or unlistable', async () => {
    const deleteFile = jest.fn(async () => true);
    expect(
      await sweepScratchOrphans({
        manager: okManager,
        listFiles: jest.fn(async () => []),
        deleteFile,
        logger: silentLogger,
      }),
    ).toBe(0);
    expect(
      await sweepScratchOrphans({
        manager: okManager,
        listFiles: jest.fn(async () => {
          throw new Error('list boom');
        }),
        deleteFile,
        logger: silentLogger,
      }),
    ).toBe(0);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('keeps sweeping when one deletion throws', async () => {
    const deleteFile = jest
      .fn(async () => true)
      .mockRejectedValueOnce(new Error('delete boom'));
    const removed = await sweepScratchOrphans({
      manager: okManager,
      listFiles: jest.fn(async () => [
        entry('copilot-page-1748000000000-0.png'),
        entry('copilot-page-1748000000001-1.png'),
      ]),
      deleteFile,
      logger: silentLogger,
    });
    expect(removed).toBe(1);
    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it('counts only deletions the bridge confirms (false return not counted)', async () => {
    const deleteFile = jest
      .fn(async () => true)
      .mockResolvedValueOnce(false);
    const removed = await sweepScratchOrphans({
      manager: okManager,
      listFiles: jest.fn(async () => [
        entry('copilot-page-1748000000000-0.png'),
        entry('copilot-page-1748000000001-1.png'),
      ]),
      deleteFile,
      logger: silentLogger,
    });
    expect(removed).toBe(1);
  });

  it('works without a logger (index.js wires none)', async () => {
    // The bootstrap call site passes only manager/listFiles/deleteFile,
    // so the internal no-op logger default has to hold.
    const deleteFile = jest.fn(async () => true);
    const removed = await sweepScratchOrphans({
      manager: okManager,
      listFiles: jest.fn(async () => [
        entry('copilot-page-1748000000000-0.png'),
      ]),
      deleteFile,
    });
    expect(removed).toBe(1);

    // And the no-op logger must absorb the failure paths too, which is
    // where a missing default would actually throw.
    await expect(
      sweepScratchOrphans({
        manager: okManager,
        listFiles: jest.fn(async () => [
          entry('copilot-page-1748000000000-1.png'),
        ]),
        deleteFile: jest.fn(async () => {
          throw new Error('delete boom');
        }),
      }),
    ).resolves.toBe(0);
    await expect(
      sweepScratchOrphans({
        manager: {getPluginDirPath: jest.fn(async () => null)},
        listFiles: jest.fn(async () => []),
        deleteFile: jest.fn(async () => true),
      }),
    ).resolves.toBe(0);
  });

  it('refuses to sweep when there is no plugin dir (shared storage is out of scope)', async () => {
    // Capture falls back to /sdcard/Android/data when the firmware
    // returns no plugin dir, but the unattended bootstrap sweep must
    // not: listing/deleting in shared storage needs FILE:READ +
    // FILE:WRITE, and on Chauvet the SecurityException is thrown from
    // inside RTNFileModule where no JS try/catch can catch it — the
    // host kills the plugin.
    const listFiles = jest.fn(async () => [
      entry('copilot-page-1748000000000-0.png'),
    ]);
    const deleteFile = jest.fn(async () => true);
    for (const dir of [null, undefined, '']) {
      const removed = await sweepScratchOrphans({
        manager: {getPluginDirPath: jest.fn(async () => dir)},
        listFiles,
        deleteFile,
        logger: silentLogger,
      });
      expect(removed).toBe(0);
    }
    expect(listFiles).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('normalises a trailing slash on the plugin dir', async () => {
    const listFiles = jest.fn(async () => []);
    await sweepScratchOrphans({
      manager: {getPluginDirPath: jest.fn(async () => `${scratchDir}/`)},
      listFiles,
      deleteFile: jest.fn(async () => true),
      logger: silentLogger,
    });
    expect(listFiles).toHaveBeenCalledWith(scratchDir);
  });

  it('skips a scratch file a capture is still holding', async () => {
    // The sweep is fired fire-and-forget at module load while the
    // button listener is registered moments later, so a tap can be
    // rendering into a scratch file the sweep then lists. Deleting it
    // makes the PNG read fail and the send loses its page context
    // entirely, with only a warn.
    let releaseRender: () => void = () => {};
    const blocked = new Promise<void>(res => {
      releaseRender = res;
    });
    const slowFile = {
      ...okFile,
      generateNotePng: jest.fn(async () => {
        await blocked;
        return {success: true, result: true};
      }),
    };

    // Start a capture and let it reach the render call, so its scratch
    // filename is registered but not yet discarded.
    const capturing = captureCurrentPage({
      comm: okComm,
      file: slowFile,
      doc: okDoc,
      manager: okManager,
      fetchFn: okFetch,
      deleteFile: jest.fn(async () => true),
      logger: silentLogger,
    });
    // Drain microtasks until capture reaches the render call — it
    // awaits several bridge round-trips first.
    for (let i = 0; i < 50 && !slowFile.generateNotePng.mock.calls.length; i++) {
      await Promise.resolve();
    }
    expect(slowFile.generateNotePng).toHaveBeenCalled();
    const renderCalls = slowFile.generateNotePng.mock
      .calls as unknown as Array<[{pngPath: string}]>;
    const inFlightPath = renderCalls[0][0].pngPath;
    const inFlightName = inFlightPath.slice(inFlightPath.lastIndexOf('/') + 1);

    const deleteFile = jest.fn(async () => true);
    const removed = await sweepScratchOrphans({
      manager: okManager,
      listFiles: jest.fn(async () => [
        entry(inFlightName),
        entry('copilot-page-1000000000000-9.png'), // a genuine orphan
      ]),
      deleteFile,
      logger: silentLogger,
    });

    expect(removed).toBe(1);
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(
      `${scratchDir}/copilot-page-1000000000000-9.png`,
    );
    expect(deleteFile).not.toHaveBeenCalledWith(inFlightPath);

    releaseRender();
    await capturing;

    // Once capture has finished with it, the name is released so a
    // later sweep can reclaim it if it was ever left behind.
    const secondDelete = jest.fn(async () => true);
    await sweepScratchOrphans({
      manager: okManager,
      listFiles: jest.fn(async () => [entry(inFlightName)]),
      deleteFile: secondDelete,
      logger: silentLogger,
    });
    expect(secondDelete).toHaveBeenCalledWith(inFlightPath);
  });

  it('returns 0 when getPluginDirPath throws (no directory to sweep)', async () => {
    const deleteFile = jest.fn(async () => true);
    const removed = await sweepScratchOrphans({
      manager: {
        getPluginDirPath: jest.fn(async () => {
          throw new Error('dir boom');
        }),
      },
      listFiles: jest.fn(async () => []),
      deleteFile,
      logger: silentLogger,
    });
    expect(removed).toBe(0);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
