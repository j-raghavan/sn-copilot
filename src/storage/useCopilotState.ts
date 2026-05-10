// Hook that wires the secure-key-store side effects into a single
// `AppState` computed via `computeAppState`. Keeps UI components
// focused on rendering by hiding all the IO + subscription dance.
//
// Inputs are dependency-injected so the hook can be tested with a
// fake io / fake key-discovery without RN/native bridges.

import {useCallback, useEffect, useState} from 'react';
import {DEFAULT_PREFS, type CopilotPrefs, type KeyFile} from '../types';
import {computeAppState, type AppState} from './appState';
import {readPrefs, type PrefsDeps} from './prefs';
import {vaultExists, type VaultDeps} from './vault';
import {discoverKeyFiles, type DiscoveryDeps} from './keyFiles';
import {getActiveKeys, subscribe} from './sessionKey';
import type {Logger} from '../sdk/types';

export type CopilotStateDeps = {
  prefsDeps: PrefsDeps;
  vaultDeps: VaultDeps;
  discoveryDeps: DiscoveryDeps;
  logger?: Logger;
};

export type CopilotStateBundle = {
  // Bootstrap snapshot — null while the initial load is in flight.
  state: AppState | null;
  prefs: CopilotPrefs;
  // Per-file parse errors surfaced from the most recent
  // discoverKeyFiles run. The UI shows these in the settings errors
  // block so the user can fix bad files in place.
  discoveryErrors: Array<{path: string; reason: string}>;
  // Refresh from disk after a flow that may have changed any of:
  // vault existence, plaintext files, prefs.
  refresh: () => Promise<void>;
};

const NOOP = (): void => undefined;
const noopLogger: Logger = {log: NOOP, warn: NOOP, error: NOOP};

export const useCopilotState = (deps: CopilotStateDeps): CopilotStateBundle => {
  const logger = deps.logger ?? noopLogger;

  const [state, setState] = useState<AppState | null>(null);
  const [prefs, setPrefs] = useState<CopilotPrefs>({...DEFAULT_PREFS});
  const [discoveryErrors, setDiscoveryErrors] = useState<
    Array<{path: string; reason: string}>
  >([]);
  const [unlockedFiles, setUnlockedFiles] = useState<KeyFile[] | null>(
    getActiveKeys(),
  );

  const refresh = useCallback(async () => {
    const [p, vExists, discovery] = await Promise.all([
      readPrefs(deps.prefsDeps),
      vaultExists(deps.vaultDeps),
      discoverKeyFiles(deps.discoveryDeps),
    ]);
    setPrefs(p);
    setDiscoveryErrors(
      discovery.errors.map((e) => ({path: e.path, reason: e.reason})),
    );
    const next = computeAppState({
      vaultExists: vExists,
      plaintextFiles: discovery.files,
      encryptionMode: p.encryptionMode,
      unlockedFiles: getActiveKeys(),
    });
    setState(next);
    logger.log(
      `[useCopilotState] refresh → kind=${next.kind} mode=${p.encryptionMode} ` +
        `vault=${vExists} plaintext=${discovery.files.length} unlocked=${
          getActiveKeys() !== null
        }`,
    );
  }, [deps.prefsDeps, deps.vaultDeps, deps.discoveryDeps, logger]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) {
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Track sessionKey changes so unlock/lock flips state without
  // requiring a manual refresh from each call site.
  useEffect(() => {
    const off = subscribe((files) => {
      setUnlockedFiles(files);
    });
    return off;
  }, []);

  // Recompute when unlocked changes — cheap, pure.
  useEffect(() => {
    if (state === null) {
      return;
    }
    const inputs = stateInputsOf(state, prefs, unlockedFiles);
    const next = computeAppState(inputs);
    if (next.kind !== state.kind) {
      setState(next);
    }
  }, [unlockedFiles, prefs, state]);

  return {state, prefs, discoveryErrors, refresh};
};

// Reverse: extract the inputs that were used to derive `state`. We
// stash them implicitly via the same source of truth (prefs +
// sessionKey) and the original snapshot of vaultExists / plaintext;
// for the unlocked → locked flip we don't strictly need fresh IO,
// just the sessionKey delta. To avoid hitting disk on every render
// we re-derive a usable inputs snapshot from `state`.
const stateInputsOf = (
  state: AppState,
  prefs: CopilotPrefs,
  unlockedFiles: KeyFile[] | null,
) => {
  // Default — covers 'unlocked' / 'locked' / 'no-key' (vault may or
  // may not exist; same shape works for the recompute-only path).
  let hasVault = state.kind === 'unlocked' || state.kind === 'locked';
  let plaintextFiles: KeyFile[] = [];
  if (state.kind === 'merge') {
    hasVault = state.vaultExists;
    plaintextFiles = state.plaintextFiles;
  } else if (state.kind === 'plaintext' || state.kind === 'migrate') {
    plaintextFiles = state.files;
  }
  return {
    vaultExists: hasVault,
    plaintextFiles,
    encryptionMode: prefs.encryptionMode,
    unlockedFiles,
  };
};
