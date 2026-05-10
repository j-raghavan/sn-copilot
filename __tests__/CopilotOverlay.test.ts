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
const mockWriteFileBase64 = jest.fn(async (..._args: unknown[]) => okResult);
const mockCryptoPbkdf2Sha256 = jest.fn(
  async (..._args: unknown[]) => ({
    success: true,
    code: 'OK',
    message: 'derived',
    bytesB64: 'AAAA',
  }),
);
const mockCryptoRandomBytes = jest.fn(
  async (..._args: unknown[]) => ({
    success: true,
    code: 'OK',
    message: 'random',
    bytesB64: 'AQID',
  }),
);

const fakeNative = {
  open: (...args: unknown[]) => mockOpen(...args),
  move: (...args: unknown[]) => mockMove(...args),
  redraw: () => mockRedraw(),
  close: () => mockClose(),
  getScreenSize: () => mockGetScreenSize(),
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
  writeFileBase64: (...args: unknown[]) => mockWriteFileBase64(...args),
  cryptoPbkdf2Sha256: (...args: unknown[]) => mockCryptoPbkdf2Sha256(...args),
  cryptoRandomBytes: (...args: unknown[]) => mockCryptoRandomBytes(...args),
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
  writeFileBase64,
  cryptoPbkdf2Sha256,
  cryptoRandomBytes,
} from '../src/native/CopilotOverlay';

beforeEach(() => {
  mockOpen.mockClear();
  mockMove.mockClear();
  mockRedraw.mockClear();
  mockClose.mockClear();
  mockGetScreenSize.mockClear();
  mockCopyToClipboard.mockClear();
  mockWriteFileBase64.mockClear();
  mockCryptoPbkdf2Sha256.mockClear();
  mockCryptoRandomBytes.mockClear();
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

  it('returns MODULE_MISSING from writeFileBase64()', async () => {
    const r = await writeFileBase64('/x', 'AAAA');
    expect(r.success).toBe(false);
    expect(r.code).toBe('MODULE_MISSING');
    expect(mockWriteFileBase64).not.toHaveBeenCalled();
  });

  it('returns MODULE_MISSING from cryptoPbkdf2Sha256()', async () => {
    const r = await cryptoPbkdf2Sha256('cHc=', 'c2x0', 1000, 32);
    expect(r.success).toBe(false);
    expect(r.code).toBe('MODULE_MISSING');
    expect(mockCryptoPbkdf2Sha256).not.toHaveBeenCalled();
  });

  it('returns MODULE_MISSING from cryptoRandomBytes()', async () => {
    const r = await cryptoRandomBytes(16);
    expect(r.success).toBe(false);
    expect(r.code).toBe('MODULE_MISSING');
    expect(mockCryptoRandomBytes).not.toHaveBeenCalled();
  });
});

describe('CopilotOverlay (crypto + write wrappers)', () => {
  it('forwards writeFileBase64 args verbatim', async () => {
    await writeFileBase64('/plugin/copilot-key.enc', 'YWJj');
    expect(mockWriteFileBase64).toHaveBeenCalledWith(
      '/plugin/copilot-key.enc',
      'YWJj',
    );
  });

  it('forwards cryptoPbkdf2Sha256 args verbatim and returns CryptoResult', async () => {
    const r = await cryptoPbkdf2Sha256('cHdkQjY0', 'c2FsdEI2NA==', 100_000, 32);
    expect(mockCryptoPbkdf2Sha256).toHaveBeenCalledWith(
      'cHdkQjY0',
      'c2FsdEI2NA==',
      100_000,
      32,
    );
    expect(r.success).toBe(true);
    expect(r.bytesB64).toBe('AAAA');
  });

  it('forwards cryptoRandomBytes args verbatim and returns CryptoResult', async () => {
    const r = await cryptoRandomBytes(12);
    expect(mockCryptoRandomBytes).toHaveBeenCalledWith(12);
    expect(r.bytesB64).toBe('AQID');
  });

  it('default-export bag exposes the new wrappers', () => {
    expect(CopilotOverlay.writeFileBase64).toBe(writeFileBase64);
    expect(CopilotOverlay.cryptoPbkdf2Sha256).toBe(cryptoPbkdf2Sha256);
    expect(CopilotOverlay.cryptoRandomBytes).toBe(cryptoRandomBytes);
  });
});

describe('CopilotOverlay (host without new crypto methods)', () => {
  it('returns MODULE_MISSING when cryptoPbkdf2Sha256 is missing on the native module', async () => {
    // Simulate a host that registers the overlay module but predates
    // the crypto methods (e.g. an older firmware).
    nativeModulesMock.CopilotOverlay = {
      ...fakeNative,
      cryptoPbkdf2Sha256: undefined as unknown as typeof fakeNative.cryptoPbkdf2Sha256,
    };
    const r = await cryptoPbkdf2Sha256('cHc=', 'c2x0', 1000, 32);
    expect(r.code).toBe('MODULE_MISSING');
  });

  it('returns MODULE_MISSING when cryptoRandomBytes is missing on the native module', async () => {
    nativeModulesMock.CopilotOverlay = {
      ...fakeNative,
      cryptoRandomBytes: undefined as unknown as typeof fakeNative.cryptoRandomBytes,
    };
    const r = await cryptoRandomBytes(16);
    expect(r.code).toBe('MODULE_MISSING');
  });
});
