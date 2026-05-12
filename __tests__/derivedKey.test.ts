/**
 * Tests for src/storage/derivedKey. Pins:
 *   1. starts cleared (null).
 *   2. set / get / has round-trip.
 *   3. clear flips back to null and notifies subscribers.
 *   4. clear is a no-op when already empty (no notify).
 *   5. subscribe / unsubscribe semantics.
 *   6. A throwing subscriber doesn't block the others.
 *   7. setDerivedKey validates input (Uint8Array, non-empty).
 */
import {
  __testing__,
  clearDerivedKey,
  getDerivedKey,
  hasDerivedKey,
  setDerivedKey,
  subscribeDerivedKey,
} from '../src/storage/derivedKey';

beforeEach(() => {
  __testing__.reset();
});

describe('derivedKey — basic state', () => {
  it('starts cleared', () => {
    expect(hasDerivedKey()).toBe(false);
    expect(getDerivedKey()).toBeNull();
  });

  it('setDerivedKey flips state and getDerivedKey reflects it', () => {
    const k = new Uint8Array([1, 2, 3, 4]);
    setDerivedKey(k);
    expect(hasDerivedKey()).toBe(true);
    expect(getDerivedKey()).toBe(k);
  });

  it('clearDerivedKey returns to null', () => {
    setDerivedKey(new Uint8Array([9, 9]));
    clearDerivedKey();
    expect(hasDerivedKey()).toBe(false);
    expect(getDerivedKey()).toBeNull();
  });

  it('clearDerivedKey is a no-op when already empty', () => {
    const fn = jest.fn();
    subscribeDerivedKey(fn);
    clearDerivedKey();
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'string', 42, new Uint8Array(0)])(
    'rejects %p',
    (bad) => {
      expect(() => setDerivedKey(bad as never)).toThrow(
        /non-empty Uint8Array/,
      );
    },
  );
});

describe('derivedKey — subscribers', () => {
  it('notifies subscribers on set + clear', () => {
    const fn = jest.fn();
    subscribeDerivedKey(fn);
    const k = new Uint8Array([1]);
    setDerivedKey(k);
    clearDerivedKey();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, k);
    expect(fn).toHaveBeenNthCalledWith(2, null);
  });

  it('unsubscribe stops further notifications', () => {
    const fn = jest.fn();
    const off = subscribeDerivedKey(fn);
    setDerivedKey(new Uint8Array([5]));
    off();
    clearDerivedKey();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not block others', () => {
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    subscribeDerivedKey(bad);
    subscribeDerivedKey(good);
    setDerivedKey(new Uint8Array([1]));
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('__testing__.subscriberCount tracks add/remove', () => {
    const a = subscribeDerivedKey(jest.fn());
    subscribeDerivedKey(jest.fn());
    expect(__testing__.subscriberCount()).toBe(2);
    a();
    expect(__testing__.subscriberCount()).toBe(1);
  });
});
