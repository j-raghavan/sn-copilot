import {debugLog} from '../src/diagnostics/log';

describe('debugLog', () => {
  it('forwards to console.log when __DEV__ is true (default in tests)', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      debugLog('hello', 42);
      expect(spy).toHaveBeenCalledWith('hello', 42);
    } finally {
      spy.mockRestore();
    }
  });

  it('is a no-op when __DEV__ is false', () => {
    const original = (globalThis as {__DEV__?: boolean}).__DEV__;
    (globalThis as {__DEV__?: boolean}).__DEV__ = false;
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      debugLog('hello', 42);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      (globalThis as {__DEV__?: boolean}).__DEV__ = original;
    }
  });
});
