// Test helper: an in-memory FileIo that vault.ts and prefs.ts use
// instead of going to disk. Tracks calls for atomic-write assertions.

import type {FileIo} from '../../src/storage/fileIo';

export type InMemoryFs = Map<string, Uint8Array>;

export type InMemoryFileIo = FileIo & {
  fs: InMemoryFs;
  writeCount: number;
  removeCount: number;
  renameCount: number;
};

export const createInMemoryFileIo = (
  initial: Record<string, Uint8Array> = {},
): InMemoryFileIo => {
  const fs: InMemoryFs = new Map(Object.entries(initial));
  let writeCount = 0;
  let removeCount = 0;
  let renameCount = 0;
  const io: InMemoryFileIo = {
    fs,
    get writeCount() {
      return writeCount;
    },
    get removeCount() {
      return removeCount;
    },
    get renameCount() {
      return renameCount;
    },
    async readBytes(path: string): Promise<Uint8Array | null> {
      const v = fs.get(path);
      return v ? new Uint8Array(v) : null;
    },
    async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
      fs.set(path, new Uint8Array(bytes));
      writeCount += 1;
    },
    async exists(path: string): Promise<boolean> {
      return fs.has(path);
    },
    async remove(path: string): Promise<boolean> {
      const had = fs.delete(path);
      if (had) {
        removeCount += 1;
      }
      return had;
    },
    async rename(sourcePath: string, destPath: string): Promise<boolean> {
      const v = fs.get(sourcePath);
      if (!v) {
        return false;
      }
      fs.set(destPath, v);
      fs.delete(sourcePath);
      renameCount += 1;
      return true;
    },
  };
  return io;
};
