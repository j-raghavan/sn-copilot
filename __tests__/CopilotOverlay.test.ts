/**
 * Tests for src/native/CopilotOverlay. Three contracts to pin:
 *   1. When NativeModules.CopilotOverlay is registered, the wrapper
 *      forwards arguments verbatim and returns the native result.
 *   2. When the native module is missing (jest by default — no native
 *      modules registered), the wrapper short-circuits to
 *      MODULE_MISSING instead of throwing.
 *   3. The wrapper never rejects; every code path resolves with a
 *      structured OverlayResult.
 *
 * The wrapper reads `NativeModules.CopilotOverlay` on every call, so
 * we can swap its presence per-test by mutating the mock directly —
 * cleaner than juggling jest.isolateModules.
 */
type ResultShape = {success: boolean; code: string; message: string};

const okResult: ResultShape = {success: true, code: 'OK', message: 'fixture'};

const mockOpen = jest.fn(async (..._args: unknown[]) => okResult);
const mockMove = jest.fn(async (..._args: unknown[]) => okResult);
const mockRedraw = jest.fn(async () => okResult);
const mockClose = jest.fn(async () => okResult);
const mockGetScreenSize = jest.fn(async () => ({
  success: true,
  width: 1404,
  height: 1872,
  message: 'OK',
}));
const mockCopyToClipboard = jest.fn(async (..._args: unknown[]) => okResult);

const fakeNative = {
  open: (...args: unknown[]) => mockOpen(...args),
  move: (...args: unknown[]) => mockMove(...args),
  redraw: () => mockRedraw(),
  close: () => mockClose(),
  getScreenSize: () => mockGetScreenSize(),
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
};

const nativeModulesMock: {CopilotOverlay?: typeof fakeNative} = {
  CopilotOverlay: fakeNative,
};

jest.mock('react-native', () => ({
  // Returning the mutable object lets each test toggle
  // `nativeModulesMock.CopilotOverlay` between defined/undefined and
  // have the wrapper see the change.
  get NativeModules() {
    return nativeModulesMock;
  },
}));

import CopilotOverlay, {
  open,
  move,
  redraw,
  close,
  getScreenSize,
  copyToClipboard,
} from '../src/native/CopilotOverlay';

beforeEach(() => {
  mockOpen.mockClear();
  mockMove.mockClear();
  mockRedraw.mockClear();
  mockClose.mockClear();
  mockGetScreenSize.mockClear();
  mockCopyToClipboard.mockClear();
  nativeModulesMock.CopilotOverlay = fakeNative;
});

describe('CopilotOverlay (wrapper)', () => {
  it('forwards open() args to the native module verbatim', async () => {
    const r = await open(720, 900, 200, 100);
    expect(mockOpen).toHaveBeenCalledWith(720, 900, 200, 100);
    expect(r).toEqual(okResult);
  });

  it('forwards move() args verbatim', async () => {
    const r = await move(50, 75);
    expect(mockMove).toHaveBeenCalledWith(50, 75);
    expect(r).toEqual(okResult);
  });

  it('calls redraw() with no args', async () => {
    const r = await redraw();
    expect(mockRedraw).toHaveBeenCalledWith();
    expect(r).toEqual(okResult);
  });

  it('calls close() with no args', async () => {
    const r = await close();
    expect(mockClose).toHaveBeenCalledWith();
    expect(r).toEqual(okResult);
  });

  it('exposes a default-export object with the same surface', () => {
    expect(CopilotOverlay.open).toBe(open);
    expect(CopilotOverlay.move).toBe(move);
    expect(CopilotOverlay.redraw).toBe(redraw);
    expect(CopilotOverlay.close).toBe(close);
    expect(CopilotOverlay.getScreenSize).toBe(getScreenSize);
    expect(CopilotOverlay.copyToClipboard).toBe(copyToClipboard);
  });

  it('forwards copyToClipboard(text, label) verbatim', async () => {
    const r = await copyToClipboard('hello world', 'Copilot Summary');
    expect(mockCopyToClipboard).toHaveBeenCalledWith(
      'hello world',
      'Copilot Summary',
    );
    expect(r).toEqual(okResult);
  });

  it('copyToClipboard defaults label to null when omitted', async () => {
    await copyToClipboard('payload');
    expect(mockCopyToClipboard).toHaveBeenCalledWith('payload', null);
  });

  it('forwards getScreenSize() and returns the native ScreenSize verbatim', async () => {
    const r = await getScreenSize();
    expect(mockGetScreenSize).toHaveBeenCalledWith();
    expect(r).toEqual({success: true, width: 1404, height: 1872, message: 'OK'});
  });

  it('propagates a native failure result without throwing', async () => {
    mockOpen.mockResolvedValueOnce({
      success: false,
      code: 'NO_ACTIVITY',
      message: 'No foreground Activity',
    });
    const r = await open(1, 2, 3, 4);
    expect(r.success).toBe(false);
    expect(r.code).toBe('NO_ACTIVITY');
  });
});

describe('CopilotOverlay (no native module)', () => {
  beforeEach(() => {
    nativeModulesMock.CopilotOverlay = undefined;
  });

  it('returns MODULE_MISSING from open()', async () => {
    const r = await open(1, 2, 3, 4);
    expect(r.success).toBe(false);
    expect(r.code).toBe('MODULE_MISSING');
    // Native mock is bypassed — the spy must NOT have been called.
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('returns MODULE_MISSING from move()', async () => {
    const r = await move(1, 2);
    expect(r.success).toBe(false);
    expect(r.code).toBe('MODULE_MISSING');
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('returns MODULE_MISSING from redraw()', async () => {
    const r = await redraw();
    expect(r.success).toBe(false);
    expect(r.code).toBe('MODULE_MISSING');
    expect(mockRedraw).not.toHaveBeenCalled();
  });

  it('returns MODULE_MISSING from close()', async () => {
    const r = await close();
    expect(r.success).toBe(false);
    expect(r.code).toBe('MODULE_MISSING');
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('returns a zero-size ScreenSize result from getScreenSize()', async () => {
    const r = await getScreenSize();
    expect(r.success).toBe(false);
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
    expect(r.message).toContain('NativeModules.CopilotOverlay is undefined');
    expect(mockGetScreenSize).not.toHaveBeenCalled();
  });

  it('returns MODULE_MISSING from copyToClipboard()', async () => {
    const r = await copyToClipboard('payload', 'label');
    expect(r.success).toBe(false);
    expect(r.code).toBe('MODULE_MISSING');
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });
});
