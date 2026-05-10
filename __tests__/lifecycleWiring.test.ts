/**
 * Tests for src/storage/lifecycleWiring. Pins:
 *   1. installSecureLifecycle subscribes to PluginLifeListener so
 *      onStop wipes sessionKey + stops the idle timer.
 *   2. setActiveKeys arms the idle timer using prefs.idleTimeoutMin.
 *   3. clear() / setActiveKeys(null path) stops the idle timer.
 *   4. Idempotent: install + install only registers one set of
 *      subscriptions.
 *   5. PluginManager.addPluginLifeListener throwing is non-fatal.
 */

const lifeListeners: Array<{onStart: () => void; onStop: () => void}> = [];
const mockAddPluginLifeListener = jest.fn(
  (listener: {onStart: () => void; onStop: () => void}) => {
    lifeListeners.push(listener);
    return {remove: () => {}};
  },
);

jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    addPluginLifeListener: (l: any) => mockAddPluginLifeListener(l),
  },
}));

import {
  __testing__ as lifecycleTesting,
  installSecureLifecycle,
} from '../src/storage/lifecycleWiring';
import {
  __testing__ as sessionTesting,
  clear as clearSessionKey,
  setActiveKeys,
} from '../src/storage/sessionKey';
import {__testing__ as idleTesting, isRunning} from '../src/storage/idleTimer';
import {writePrefs} from '../src/storage/prefs';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';
import type {KeyFile} from '../src/types';

const PREFS_PATH = '/plugin/copilot-prefs.json';

const f = (): KeyFile => ({
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  key: 'sk-ant-x',
  sourcePath: '/x.txt',
});

// Microtask-only flush — we mix this with jest.useFakeTimers, which
// would swallow setImmediate / setTimeout based pumps.
const flushPromises = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  jest.useFakeTimers();
  lifeListeners.length = 0;
  mockAddPluginLifeListener.mockClear();
  sessionTesting.reset();
  idleTesting.reset();
  lifecycleTesting.reset();
});

afterEach(() => {
  jest.useRealTimers();
});

const setupDeps = async (idleTimeoutMin = 5) => {
  const io = createInMemoryFileIo();
  const deps = {prefsDeps: {io, prefsPath: PREFS_PATH}};
  await writePrefs(deps.prefsDeps, {
    version: 1,
    encryptionMode: 'encrypted',
    idleTimeoutMin,
  });
  return deps;
};

describe('installSecureLifecycle', () => {
  it('subscribes to addPluginLifeListener exactly once', async () => {
    const deps = await setupDeps();
    installSecureLifecycle(deps);
    installSecureLifecycle(deps);
    expect(mockAddPluginLifeListener).toHaveBeenCalledTimes(1);
  });

  it('onStop wipes sessionKey and stops the idle timer', async () => {
    const deps = await setupDeps();
    installSecureLifecycle(deps);
    setActiveKeys([f()]);
    await flushPromises();
    expect(isRunning()).toBe(true);
    lifeListeners[0].onStop();
    expect(isRunning()).toBe(false);
  });

  it('arming the timer uses prefs.idleTimeoutMin', async () => {
    const deps = await setupDeps(2);
    installSecureLifecycle(deps);
    setActiveKeys([f()]);
    await flushPromises();
    // Just under 2 minutes: still active.
    jest.advanceTimersByTime(2 * 60 * 1000 - 1);
    // Some test runners require a microtask drain after fake-timer
    // advances for the underlying setTimeout callback to run.
    await flushPromises();
    expect(isRunning()).toBe(true);
    jest.advanceTimersByTime(2);
    await flushPromises();
    expect(isRunning()).toBe(false);
  });

  it('clearing sessionKey stops the timer (without onStop)', async () => {
    const deps = await setupDeps(5);
    installSecureLifecycle(deps);
    setActiveKeys([f()]);
    await flushPromises();
    expect(isRunning()).toBe(true);
    clearSessionKey();
    expect(isRunning()).toBe(false);
  });

  it('survives addPluginLifeListener throwing (no-throw)', async () => {
    mockAddPluginLifeListener.mockImplementationOnce(() => {
      throw new Error('legacy firmware');
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const deps = await setupDeps();
    expect(() => installSecureLifecycle(deps)).not.toThrow();
    log.mockRestore();
  });

  it('the registered listener exposes a no-op onStart callback', async () => {
    const deps = await setupDeps();
    installSecureLifecycle(deps);
    // onStart shouldn't throw and shouldn't change session state.
    expect(() => lifeListeners[0].onStart()).not.toThrow();
  });

  it('falls back to defaults when readPrefs throws on unlock', async () => {
    const deps = await setupDeps();
    // Sabotage the underlying IO so readPrefs hits the catch path.
    deps.prefsDeps.io.readBytes = async () => {
      throw new Error('disk corrupt');
    };
    installSecureLifecycle(deps);
    setActiveKeys([f()]);
    await flushPromises();
    expect(isRunning()).toBe(true);
  });
});
