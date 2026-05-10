// Inactivity timer that wipes the in-memory derived key after N
// minutes without user interaction.
//
// Why this exists: `PluginLifeListener.onStop` is best-effort —
// the host fires it on explicit close, but a plugin process that
// stays alive in the background can leak the unlocked key until the
// OS reclaims memory. The idle timer guarantees an upper bound
// regardless of what the host does.
//
// Public surface:
//   - start(): arm the timer (idempotent — re-arms with the configured
//     timeout each call).
//   - touch(): user did something; reset the countdown.
//   - stop(): cancel a running timer, e.g. on lock or unmount.
//   - configure({minutes}): update the timeout (also re-arms if running).
//
// `setTimeout` is module-globally scoped so the timer survives across
// React mounts; tests use jest fake timers + `__testing__.reset()`.

import {DEFAULT_IDLE_TIMEOUT_MIN} from '../types';

export type IdleTimerConfig = {
  minutes: number;
  // Called when the countdown elapses. Typically sessionKey.clear.
  onExpire: () => void;
};

let handle: ReturnType<typeof setTimeout> | null = null;
let activeMinutes: number = DEFAULT_IDLE_TIMEOUT_MIN;
let activeOnExpire: (() => void) | null = null;

const minutesToMs = (m: number): number => Math.floor(m * 60 * 1000);

const cancel = (): void => {
  if (handle !== null) {
    clearTimeout(handle);
    handle = null;
  }
};

const arm = (): void => {
  cancel();
  if (activeOnExpire === null) {
    return;
  }
  if (activeMinutes <= 0) {
    return;
  }
  const cb = activeOnExpire;
  handle = setTimeout(() => {
    handle = null;
    cb();
  }, minutesToMs(activeMinutes));
};

export const start = (config: IdleTimerConfig): void => {
  if (typeof config.onExpire !== 'function') {
    throw new TypeError('idleTimer.start: onExpire must be a function');
  }
  if (!Number.isFinite(config.minutes)) {
    throw new RangeError('idleTimer.start: minutes must be a finite number');
  }
  activeMinutes = config.minutes;
  activeOnExpire = config.onExpire;
  arm();
};

export const touch = (): void => {
  if (handle !== null) {
    arm();
  }
};

export const stop = (): void => {
  cancel();
  activeOnExpire = null;
};

export const configure = (next: {minutes: number}): void => {
  if (!Number.isFinite(next.minutes)) {
    throw new RangeError('idleTimer.configure: minutes must be a finite number');
  }
  activeMinutes = next.minutes;
  if (handle !== null) {
    arm();
  }
};

export const isRunning = (): boolean => handle !== null;

export const __testing__ = {
  reset(): void {
    cancel();
    activeMinutes = DEFAULT_IDLE_TIMEOUT_MIN;
    activeOnExpire = null;
  },
};
