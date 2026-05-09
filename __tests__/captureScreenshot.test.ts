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
import {captureCurrentPage} from '../src/scope/captureScreenshot';

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
});

describe('captureCurrentPage — happy path', () => {
  it('captures + returns base64 screenshot AND transcribed text for a .note', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
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
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    const b = await captureCurrentPage({
      comm: okComm,
      file: okFile,
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
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
  });

  it('returns null for non-.note file (e.g. .pdf)', async () => {
    const ctx = await captureCurrentPage({
      comm: {
        ...okComm,
        getCurrentFilePath: jest.fn(async () => ({
          success: true,
          result: '/sd/docs/spec.pdf',
        })),
        getCurrentPageNum: jest.fn(async () => ({success: true, result: 1})),
      },
      file: okFile,
      manager: okManager,
      fetchFn: okFetch,
      logger: silentLogger,
    });
    expect(ctx).toBeNull();
    expect(silentLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('not a .note'),
    );
  });

  it('returns null when getPluginDirPath throws', async () => {
    const ctx = await captureCurrentPage({
      comm: okComm,
      file: okFile,
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
