/**
 * Tests for src/storage/idleTimer. Pins:
 *   1. start arms a timer; expiry calls onExpire.
 *   2. touch resets the countdown.
 *   3. stop cancels and clears the callback.
 *   4. configure updates the timeout (re-arms if running).
 *   5. minutes <= 0 disables the timer.
 *   6. Argument validation.
 */
import {
  __testing__,
  configure,
  isRunning,
  start,
  stop,
  touch,
} from '../src/storage/idleTimer';

beforeEach(() => {
  jest.useFakeTimers();
  __testing__.reset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('idleTimer — basic lifecycle', () => {
  it('fires onExpire after the configured minutes elapse', () => {
    const onExpire = jest.fn();
    start({minutes: 5, onExpire});
    expect(isRunning()).toBe(true);
    jest.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(isRunning()).toBe(false);
  });

  it('touch resets the countdown', () => {
    const onExpire = jest.fn();
    start({minutes: 5, onExpire});
    jest.advanceTimersByTime(4 * 60 * 1000);
    touch();
    jest.advanceTimersByTime(4 * 60 * 1000);
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1 * 60 * 1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('stop cancels and clears the callback', () => {
    const onExpire = jest.fn();
    start({minutes: 5, onExpire});
    stop();
    expect(isRunning()).toBe(false);
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('start replaces the previous timer', () => {
    const a = jest.fn();
    const b = jest.fn();
    start({minutes: 5, onExpire: a});
    start({minutes: 1, onExpire: b});
    jest.advanceTimersByTime(1 * 60 * 1000);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('idleTimer — configure', () => {
  it('updates the timeout and re-arms when running', () => {
    const onExpire = jest.fn();
    start({minutes: 30, onExpire});
    configure({minutes: 1});
    jest.advanceTimersByTime(1 * 60 * 1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('updates the timeout but does not start a new timer if stopped', () => {
    configure({minutes: 5});
    expect(isRunning()).toBe(false);
  });
});

describe('idleTimer — disabled / edge cases', () => {
  it('minutes <= 0 disables the timer', () => {
    const onExpire = jest.fn();
    start({minutes: 0, onExpire});
    expect(isRunning()).toBe(false);
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('touch is a no-op when no timer is running', () => {
    touch();
    expect(isRunning()).toBe(false);
  });
});

describe('idleTimer — validation', () => {
  it('rejects non-function onExpire', () => {
    expect(() =>
      // @ts-expect-error — testing runtime guard
      start({minutes: 5, onExpire: 'not-a-fn'}),
    ).toThrow(/onExpire/);
  });

  it('rejects non-finite minutes', () => {
    expect(() =>
      start({minutes: NaN, onExpire: jest.fn()}),
    ).toThrow(/minutes/);
    expect(() => configure({minutes: Infinity})).toThrow(/minutes/);
  });
});
