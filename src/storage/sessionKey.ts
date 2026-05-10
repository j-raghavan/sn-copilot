// In-memory holder for the user's decrypted KeyFile list.
//
// Lifetime: set on successful unlock; cleared by (a) the explicit
// "Lock now" action, (b) the idle timer firing, (c) the plugin
// lifecycle `onStop` callback, or (d) the OS killing the process
// (no code runs in that case — heap freed automatically).
//
// Module-scope `let` is intentional: the JS bundle runs in a single
// per-plugin RN runtime, so this is effectively per-plugin singleton
// state. Tests reset via `clear()` or the `__testing__` helper.
//
// We also keep a small subscriber set so the panel can react to
// lock/unlock without prop drilling.

import type {KeyFile} from '../types';

let unlockedFiles: KeyFile[] | null = null;
const subscribers = new Set<(files: KeyFile[] | null) => void>();

const notify = (): void => {
  // Snapshot so subscribers that mutate the set during iteration don't
  // skip or re-notify themselves.
  for (const fn of Array.from(subscribers)) {
    try {
      fn(unlockedFiles);
    } catch {
      // Swallowing here is intentional — a misbehaving subscriber
      // shouldn't take the rest down. Tests assert this directly.
    }
  }
};

export const setActiveKeys = (files: KeyFile[]): void => {
  if (!Array.isArray(files)) {
    throw new TypeError('setActiveKeys: files must be an array');
  }
  unlockedFiles = files;
  notify();
};

export const getActiveKeys = (): KeyFile[] | null => unlockedFiles;

export const isUnlocked = (): boolean => unlockedFiles !== null;

export const clear = (): void => {
  if (unlockedFiles === null) {
    return;
  }
  unlockedFiles = null;
  notify();
};

export const subscribe = (
  fn: (files: KeyFile[] | null) => void,
): (() => void) => {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
};

export const __testing__ = {
  reset(): void {
    unlockedFiles = null;
    subscribers.clear();
  },
  subscriberCount(): number {
    return subscribers.size;
  },
};
