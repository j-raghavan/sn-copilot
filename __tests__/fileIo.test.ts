/**
 * Tests for src/storage/fileIo (the bridge factory). Pins:
 *   1. readBytes returns null when exists=false (skips fetch).
 *   2. readBytes returns null when fetch.ok=false.
 *   3. readBytes returns Uint8Array on success.
 *   4. writeBytes base64-encodes and routes through writeFileBase64.
 *   5. writeBytes throws on writeFileBase64 failure.
 *   6. exists / remove / rename pass through.
 *   7. writeBytes detaches subarray-style inputs so we encode only the
 *      requested slice (regression — earlier we accidentally encoded
 *      the full backing buffer).
 */
import {createBridgeFileIo} from '../src/storage/fileIo';

const okFetch = (text: string) => ({
  ok: true,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});

describe('createBridgeFileIo — readBytes', () => {
  it('returns null when exists is false (skips fetch)', async () => {
    const fetchFn = jest.fn();
    const io = createBridgeFileIo({
      exists: async () => false,
      deleteFile: jest.fn(),
      renameToFile: jest.fn(),
      fetchFn: fetchFn as unknown as typeof fetch,
      writeFileBase64: jest.fn(),
    });
    const r = await io.readBytes('/x');
    expect(r).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns null when fetch resolves with ok=false', async () => {
    const io = createBridgeFileIo({
      exists: async () => true,
      deleteFile: jest.fn(),
      renameToFile: jest.fn(),
      fetchFn: (async () => ({ok: false, arrayBuffer: async () => new ArrayBuffer(0)})) as unknown as typeof fetch,
      writeFileBase64: jest.fn(),
    });
    expect(await io.readBytes('/x')).toBeNull();
  });

  it('returns Uint8Array on successful fetch', async () => {
    const io = createBridgeFileIo({
      exists: async () => true,
      deleteFile: jest.fn(),
      renameToFile: jest.fn(),
      fetchFn: (async () => okFetch('hello')) as unknown as typeof fetch,
      writeFileBase64: jest.fn(),
    });
    const r = await io.readBytes('/x');
    expect(Buffer.from(r!).toString('utf8')).toBe('hello');
  });
});

describe('createBridgeFileIo — writeBytes', () => {
  it('encodes bytes as base64 and calls writeFileBase64', async () => {
    const writeFileBase64 = jest.fn(async () => ({
      success: true,
      code: 'OK',
      message: 'wrote',
    }));
    const io = createBridgeFileIo({
      exists: jest.fn(),
      deleteFile: jest.fn(),
      renameToFile: jest.fn(),
      fetchFn: jest.fn() as unknown as typeof fetch,
      writeFileBase64,
    });
    await io.writeBytes('/x', new TextEncoder().encode('abc'));
    expect(writeFileBase64).toHaveBeenCalledWith('/x', 'YWJj');
  });

  it('throws when writeFileBase64 returns success=false', async () => {
    const writeFileBase64 = jest.fn(async () => ({
      success: false,
      code: 'WRITE_FAILED',
      message: 'disk full',
    }));
    const io = createBridgeFileIo({
      exists: jest.fn(),
      deleteFile: jest.fn(),
      renameToFile: jest.fn(),
      fetchFn: jest.fn() as unknown as typeof fetch,
      writeFileBase64,
    });
    await expect(io.writeBytes('/x', new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /WRITE_FAILED/,
    );
  });

  it('encodes only the requested slice when given a subarray', async () => {
    const captured: string[] = [];
    const writeFileBase64 = jest.fn(async (_p, b64) => {
      captured.push(b64);
      return {success: true, code: 'OK', message: ''};
    });
    const io = createBridgeFileIo({
      exists: jest.fn(),
      deleteFile: jest.fn(),
      renameToFile: jest.fn(),
      fetchFn: jest.fn() as unknown as typeof fetch,
      writeFileBase64,
    });
    const big = new Uint8Array([1, 2, 3, 4, 5, 6]);
    await io.writeBytes('/x', big.subarray(2, 5)); // 3,4,5
    // 3,4,5 → AwQF
    expect(captured[0]).toBe('AwQF');
  });
});

describe('createBridgeFileIo — passthrough methods', () => {
  it('exists / remove / rename forward', async () => {
    const exists = jest.fn(async () => true);
    const deleteFile = jest.fn(async () => true);
    const renameToFile = jest.fn(async () => true);
    const io = createBridgeFileIo({
      exists,
      deleteFile,
      renameToFile,
      fetchFn: jest.fn() as unknown as typeof fetch,
      writeFileBase64: jest.fn(),
    });
    await io.exists('/x');
    await io.remove('/y');
    await io.rename('/y', '/z');
    expect(exists).toHaveBeenCalledWith('/x');
    expect(deleteFile).toHaveBeenCalledWith('/y');
    expect(renameToFile).toHaveBeenCalledWith('/y', '/z');
  });
});
