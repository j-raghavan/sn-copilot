// Wires the secure-key-store lifecycle to the host plugin runtime.
//
// Two responsibilities:
//   1. Subscribe to PluginManager.addPluginLifeListener — when the
//      host fires onStop (explicit close), wipe the in-memory key
//      and stop the idle timer.
//   2. Subscribe to sessionKey changes — when the user unlocks,
//      arm the idle timer; when they lock, stop it.
//
// The idle timeout in minutes is read from prefs at unlock time. If
// the user changes the timeout while unlocked, the SettingsView
// action also re-arms via idleTimer.configure() — see the
// `onIdleTimeoutChange` handler.

import {PluginManager} from 'sn-plugin-lib';
import {DEFAULT_IDLE_TIMEOUT_MIN} from '../types';
import {clear as clearSessionKey, subscribe} from './sessionKey';
import {clearDerivedKey} from './derivedKey';
import * as idleTimer from './idleTimer';
import {readPrefs, type PrefsDeps} from './prefs';

export type LifecycleDeps = {
  prefsDeps: PrefsDeps;
};

let installed = false;

export const installSecureLifecycle = (deps: LifecycleDeps): void => {
  if (installed) {
    return;
  }
  installed = true;

  // Plugin stop → wipe + cancel.
  try {
    PluginManager.addPluginLifeListener({
      onStart: () => {},
      onStop: () => {
        idleTimer.stop();
        clearSessionKey();
        clearDerivedKey();
      },
    });
  } catch (e) {
    // Older firmware may not surface this listener; non-fatal.
    console.log(
      '[lifecycleWiring] addPluginLifeListener failed:',
      (e as Error).message,
    );
  }

  // Unlock → start idle timer; lock → stop.
  subscribe((files) => {
    if (files === null) {
      idleTimer.stop();
      return;
    }
    (async () => {
      const prefs = await readPrefs(deps.prefsDeps).catch(() => ({
        version: 1 as const,
        encryptionMode: 'undecided' as const,
        idleTimeoutMin: DEFAULT_IDLE_TIMEOUT_MIN,
      }));
      idleTimer.start({
        minutes: prefs.idleTimeoutMin,
        onExpire: () => {
          clearSessionKey();
          clearDerivedKey();
        },
      });
    })();
  });
};

// Test hook: reset the install flag so the wiring can be re-installed
// in a fresh test scope.
export const __testing__ = {
  reset(): void {
    installed = false;
  },
};
