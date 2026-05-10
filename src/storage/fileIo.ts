// Minimal file IO surface used by the encrypted vault and the prefs
// store. Two reasons to abstract this rather than calling the
// sn-plugin-lib + CopilotOverlay APIs directly:
//
//   1. Testability — vault.ts and prefs.ts get an injectable IO so
//      tests use an in-memory map instead of mocking two native
//      bridges per assertion.
//
//   2. Symmetric read/write — sn-plugin-lib only exposes read via
//      `fetch('file://…')` and offers no `writeFile`. Our native
//      module fills that gap. Keeping the JS side ignorant of the
//      split makes the call sites cleaner.
//
// Path semantics: callers always pass an absolute filesystem path.

import {arrayBufferToBase64} from '../scope/base64';

export type FileIo = {
  readBytes: (path: string) => Promise<Uint8Array | null>;
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<boolean>;
  // Used for the .tmp → final rename in the atomic-write dance.
  rename: (sourcePath: string, destPath: string) => Promise<boolean>;
};

// Production deps — kept as an interface so tests inject mocks. The
// concrete wiring (FileUtils + CopilotOverlay) lives in fileIo.bridge.ts
// to keep this module free of native imports.

export type FileBridgeDeps = {
  exists: (path: string) => Promise<boolean>;
  deleteFile: (path: string) => Promise<boolean>;
  renameToFile: (source: string, dest: string) => Promise<boolean>;
  fetchFn: typeof fetch;
  writeFileBase64: (
    path: string,
    base64: string,
  ) => Promise<{success: boolean; code: string; message: string}>;
};

export const createBridgeFileIo = (deps: FileBridgeDeps): FileIo => ({
  async readBytes(path: string): Promise<Uint8Array | null> {
    const exists = await deps.exists(path);
    if (!exists) {
      return null;
    }
    const res = await deps.fetchFn(`file://${path}`);
    if (!res.ok) {
      return null;
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  },

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    // Detach from the underlying ArrayBuffer so subarray callers
    // don't accidentally encode the whole backing buffer.
    const sliced = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
    const b64 = arrayBufferToBase64(sliced);
    const r = await deps.writeFileBase64(path, b64);
    if (!r.success) {
      throw new Error(`writeBytes(${path}) failed: ${r.code} — ${r.message}`);
    }
  },

  async exists(path: string): Promise<boolean> {
    return deps.exists(path);
  },

  async remove(path: string): Promise<boolean> {
    return deps.deleteFile(path);
  },

  async rename(sourcePath: string, destPath: string): Promise<boolean> {
    return deps.renameToFile(sourcePath, destPath);
  },
});
