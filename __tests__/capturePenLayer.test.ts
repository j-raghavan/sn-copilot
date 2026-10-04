/**
 * Tests for the pen-layer step of src/scope/captureScreenshot's doc
 * path: a PDF/EPUB page's handwriting lives in the document's mark
 * file, so it is rendered separately and laid over the page render.
 *
 * Pins:
 *   1. A page listed by getMarkPages gets its mark layer rendered to its
 *      own scratch file, at the page render's size, and composited over
 *      the page render before the bytes are read.
 *   2. The mark scratch file is always discarded, success or failure.
 *   3. Every failure (lookup, render, composite, scratch path) degrades
 *      to sending the page render alone — never to a failed capture.
 *   4. Without penLayer deps, and on .note pages, nothing changes.
 */
import {captureCurrentPage} from '../src/scope/captureScreenshot';

const SCRATCH_RE =
  /^\/data\/user\/0\/com\.sncopilot\/files\/copilot-page-\d+-\d+\.png$/;
const DOC_PATH = '/sd/docs/spec.pdf';
const PAGE = 3;

const logger = {log: jest.fn(), warn: jest.fn()};

const docComm = (path = DOC_PATH) => ({
  getCurrentFilePath: jest.fn(async () => ({success: true, result: path})),
  getCurrentPageNum: jest.fn(async () => ({success: true, result: PAGE})),
  recognizeElements: jest.fn(async () => ({success: true, result: ''})),
});

const file = {
  generateNotePng: jest.fn(async () => ({success: true, result: true})),
  getElements: jest.fn(async () => ({success: true, result: []})),
  getPageSize: jest.fn(async () => ({
    success: true,
    result: {width: 1404, height: 1872},
  })),
};

const doc = {
  generateCurrentDocImage: jest.fn(async () => ({success: true, result: true})),
  getCurrentDocText: jest.fn(async () => ({success: true, result: 'text'})),
};

const fetchFn = jest.fn(async () => ({
  ok: true,
  arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
})) as unknown as typeof fetch;

const makePenLayer = (overrides: Record<string, unknown> = {}) => ({
  getMarkPages: jest.fn(async () => ({success: true, result: [1, PAGE, 9]})),
  generateMarkThumbnails: jest.fn(async () => ({success: true, result: true})),
  overlayPng: jest.fn(async () => true),
  ...overrides,
});

const capture = (
  penLayer: ReturnType<typeof makePenLayer> | undefined,
  extra: Record<string, unknown> = {},
) => {
  const deleteFile = jest.fn(async () => true);
  const manager = {
    getPluginDirPath: jest.fn(async () => '/data/user/0/com.sncopilot/files'),
  };
  const result = captureCurrentPage({
    comm: docComm(),
    file,
    doc,
    manager,
    fetchFn,
    logger,
    deleteFile,
    penLayer,
    ...extra,
  });
  return {result, deleteFile, manager};
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('captureCurrentPage — doc pen layer', () => {
  it('renders the mark layer and composites it over the page render', async () => {
    const pen = makePenLayer();
    const {result, deleteFile} = capture(pen);
    const ctx = await result;

    expect(ctx).not.toBeNull();
    expect(pen.getMarkPages).toHaveBeenCalledWith(DOC_PATH);
    const [docPath, page, markPath, size] =
      pen.generateMarkThumbnails.mock.calls[0] as unknown as [
        string,
        number,
        string,
        {width: number; height: number},
      ];
    expect(docPath).toBe(DOC_PATH);
    expect(page).toBe(PAGE);
    expect(markPath).toMatch(SCRATCH_RE);
    expect(markPath).not.toBe(ctx?.screenshotPath);
    expect(size).toEqual({width: 1404, height: 1872});
    expect(pen.overlayPng).toHaveBeenCalledWith(ctx?.screenshotPath, markPath);
    // Composited before the page render is read for sending.
    expect(pen.overlayPng.mock.invocationCallOrder[0]).toBeLessThan(
      (fetchFn as jest.Mock).mock.invocationCallOrder[0],
    );
    // Both scratch renders are discarded.
    expect(deleteFile).toHaveBeenCalledWith(markPath);
    expect(deleteFile).toHaveBeenCalledWith(ctx?.screenshotPath);
  });

  it('renders the mark layer at an overridden docImageSize', async () => {
    const pen = makePenLayer();
    await capture(pen, {docImageSize: {width: 800, height: 1000}}).result;
    expect(pen.generateMarkThumbnails).toHaveBeenCalledWith(
      DOC_PATH,
      PAGE,
      expect.any(String),
      {width: 800, height: 1000},
    );
  });

  it('skips the mark render when the page has no handwriting', async () => {
    const pen = makePenLayer({
      getMarkPages: jest.fn(async () => ({success: true, result: [0, 7]})),
    });
    const {result, deleteFile} = capture(pen);
    const ctx = await result;
    expect(ctx).not.toBeNull();
    expect(pen.generateMarkThumbnails).not.toHaveBeenCalled();
    expect(pen.overlayPng).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null', null],
    ['a non-object', 'nope'],
    ['a non-array result', {success: true, result: 'x'}],
    ['a failed envelope', {success: false}],
  ])('treats getMarkPages resolving to %s as no handwriting', async (_l, raw) => {
    const pen = makePenLayer({getMarkPages: jest.fn(async () => raw)});
    const ctx = await capture(pen).result;
    expect(ctx).not.toBeNull();
    expect(pen.generateMarkThumbnails).not.toHaveBeenCalled();
  });

  it('sends the page render alone when getMarkPages throws', async () => {
    const pen = makePenLayer({
      getMarkPages: jest.fn(async () => {
        throw new Error('marks boom');
      }),
    });
    const ctx = await capture(pen).result;
    expect(ctx).not.toBeNull();
    expect(pen.generateMarkThumbnails).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('getMarkPages threw: marks boom'),
    );
  });

  it.each([
    ['success: false', {success: false}],
    ['null', null],
    ['a non-object', true],
  ])(
    'does not composite when generateMarkThumbnails resolves to %s',
    async (_l, raw) => {
      const pen = makePenLayer({
        generateMarkThumbnails: jest.fn(async () => raw),
      });
      const {result, deleteFile} = capture(pen);
      const ctx = await result;
      expect(ctx).not.toBeNull();
      expect(pen.overlayPng).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('generateMarkThumbnails failed'),
      );
      // The (possibly partial) mark render is still discarded.
      expect(deleteFile).toHaveBeenCalledTimes(2);
    },
  );

  it('discards the mark scratch when generateMarkThumbnails throws', async () => {
    const pen = makePenLayer({
      generateMarkThumbnails: jest.fn(async () => {
        throw new Error('thumb boom');
      }),
    });
    const {result, deleteFile} = capture(pen);
    const ctx = await result;
    expect(ctx).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pen layer threw: thumb boom'),
    );
    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it('sends the page render alone when the composite fails', async () => {
    const pen = makePenLayer({overlayPng: jest.fn(async () => false)});
    const {result, deleteFile} = capture(pen);
    const ctx = await result;
    expect(ctx).not.toBeNull();
    expect(ctx?.screenshotBase64.length).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('overlayPng failed'),
    );
    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it('skips the pen layer when no scratch path can be resolved for it', async () => {
    const pen = makePenLayer();
    const manager = {
      getPluginDirPath: jest
        .fn()
        .mockResolvedValueOnce('/data/user/0/com.sncopilot/files')
        .mockRejectedValueOnce(new Error('dir boom')),
    };
    const ctx = await captureCurrentPage({
      comm: docComm(),
      file,
      doc,
      manager,
      fetchFn,
      logger,
      penLayer: pen,
    });
    expect(ctx).not.toBeNull();
    expect(pen.generateMarkThumbnails).not.toHaveBeenCalled();
  });

  it('logs whether the pen layer was applied', async () => {
    await capture(makePenLayer()).result;
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('penLayer=true'),
    );
  });

  it('never consults the pen layer on a .note page', async () => {
    const pen = makePenLayer();
    const ctx = await capture(pen, {comm: docComm('/sd/notes/x.note')}).result;
    expect(ctx).not.toBeNull();
    expect(pen.getMarkPages).not.toHaveBeenCalled();
  });
});
