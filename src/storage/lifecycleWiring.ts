// Wires the secure-key-store lifecycle to the host plugin runtime.
//
// Two responsibilities:
//   1. Subscribe to PluginManager.registerPluginLifeListener — when
//      the host reports the `stop` life state (explicit close), wipe
//      the in-memory key and stop the idle timer.
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

// sn-plugin-lib 0.1.65 replaced the demultiplexed
// `addPluginLifeListener({onStart, onStop})` with a raw
// `registerPluginLifeListener({onMsg})` that forwards the host's
// life-state payload verbatim, so the state code is ours to match.
// Value from sn-plugin-lib's internal `PluginLifeType` map
// (initialized:0, mounted:1, start:2, stop:3, unmounted:4,
// destroyed:5); the lib does not export it. The payload shape is
// the `msg.data` the lib passes through — see its `notifyPluginLife`.
const PLUGIN_LIFE_STATE_STOP = 3;

type PluginLifeMsg = {state?: number} | null | undefined;

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
    PluginManager.registerPluginLifeListener({
      onMsg: (msg: PluginLifeMsg) => {
        if (msg?.state !== PLUGIN_LIFE_STATE_STOP) {
          return;
        }
        idleTimer.stop();
        clearSessionKey();
        clearDerivedKey();
      },
    });
  } catch (e) {
    // Older firmware may not surface this listener; non-fatal.
    console.log(
      '[lifecycleWiring] registerPluginLifeListener failed:',
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
