/**
 * Tests for src/storage/sessionKey. Pins:
 *   1. setActiveKeys + getActiveKeys round-trip; isUnlocked reflects state.
 *   2. clear() returns to locked state and notifies subscribers.
 *   3. subscribe / unsubscribe semantics (no notify after unsubscribe).
 *   4. A throwing subscriber doesn't break the others.
 *   5. setActiveKeys validates input.
 */
import {
  __testing__,
  clear,
  getActiveKeys,
  isUnlocked,
  setActiveKeys,
  subscribe,
} from '../src/storage/sessionKey';
import type {KeyFile} from '../src/types';

const sampleFile = (provider: 'anthropic' | 'openai'): KeyFile => ({
  provider,
  model: provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini',
  key: 'sk-test',
  sourcePath: '/tmp/copilot-key.enc',
});

beforeEach(() => {
  __testing__.reset();
});

describe('sessionKey — basic state', () => {
  it('starts locked with null active keys', () => {
    expect(isUnlocked()).toBe(false);
    expect(getActiveKeys()).toBeNull();
  });

  it('setActiveKeys flips state to unlocked', () => {
    setActiveKeys([sampleFile('anthropic')]);
    expect(isUnlocked()).toBe(true);
    expect(getActiveKeys()).toEqual([sampleFile('anthropic')]);
  });

  it('clear returns to locked', () => {
    setActiveKeys([sampleFile('openai')]);
    clear();
    expect(isUnlocked()).toBe(false);
    expect(getActiveKeys()).toBeNull();
  });

  it('clear is a no-op when already locked (no notify)', () => {
    const fn = jest.fn();
    subscribe(fn);
    clear();
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'string', 42])(
    'rejects non-array %p',
    (bad) => {
      expect(() => setActiveKeys(bad as never)).toThrow(/array/);
    },
  );
});

describe('sessionKey — subscribers', () => {
  it('notifies subscribers on set + clear', () => {
    const fn = jest.fn();
    subscribe(fn);
    setActiveKeys([sampleFile('anthropic')]);
    clear();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, [sampleFile('anthropic')]);
    expect(fn).toHaveBeenNthCalledWith(2, null);
  });

  it('unsubscribe stops further notifications', () => {
    const fn = jest.fn();
    const off = subscribe(fn);
    setActiveKeys([sampleFile('openai')]);
    off();
    clear();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not block others', () => {
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    subscribe(bad);
    subscribe(good);
    setActiveKeys([sampleFile('anthropic')]);
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('__testing__.subscriberCount tracks add/remove', () => {
    const a = subscribe(jest.fn());
    subscribe(jest.fn());
    expect(__testing__.subscriberCount()).toBe(2);
    a();
    expect(__testing__.subscriberCount()).toBe(1);
  });
});
