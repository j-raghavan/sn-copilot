// In-memory holder for the PBKDF2-derived 32-byte AES key.
//
// Parallels sessionKey.ts (which holds the unlocked KeyFile array)
// but lives separately because the *derived key* is a distinct
// concept from the *unlocked secrets*: re-deriving the same key per
// write is 5-10s on Hermes (see vault.ts header), so we cache it for
// the duration of the unlocked session. Encrypted conversation
// persistence reads/writes pay only the AES-GCM cost per save.
//
// Lifetime mirrors sessionKey: set on unlock, cleared on lock /
// idle / reset / lifecycle stop. Subscribers fire on transitions so
// consumers (the conversations store) can flush pending writes
// before the key disappears.
//
// SECURITY NOTE: the derived key sitting in JS heap has the same
// blast radius as the unlocked KeyFile array — anything that can
// reach this module already has the API keys. We're not extending
// the trust surface by caching the AES key here.

let derivedKey: Uint8Array | null = null;
const subscribers = new Set<(key: Uint8Array | null) => void>();

const notify = (): void => {
  for (const fn of Array.from(subscribers)) {
    try {
      fn(derivedKey);
    } catch {
      // A misbehaving subscriber should never take the rest down.
    }
  }
};

export const setDerivedKey = (key: Uint8Array): void => {
  if (!(key instanceof Uint8Array) || key.length === 0) {
    throw new TypeError('setDerivedKey: key must be a non-empty Uint8Array');
  }
  derivedKey = key;
  notify();
};

export const getDerivedKey = (): Uint8Array | null => derivedKey;

export const hasDerivedKey = (): boolean => derivedKey !== null;

export const clearDerivedKey = (): void => {
  if (derivedKey === null) {
    return;
  }
  derivedKey = null;
  notify();
};

export const subscribeDerivedKey = (
  fn: (key: Uint8Array | null) => void,
): (() => void) => {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
};

export const __testing__ = {
  reset(): void {
    derivedKey = null;
    subscribers.clear();
  },
  subscriberCount(): number {
    return subscribers.size;
  },
};
