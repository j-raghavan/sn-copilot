// Higher-level operations the UI calls during the secure-key flows.
// Each flow is one async function with explicit deps so it can be
// unit-tested without a React tree.
//
// Migration / unlock / merge / change-pin / disable / reset all live
// here. Each returns a structured result so the UI can decide what
// to render next.

import type {KeyFile, EncryptionMode} from '../types';
import {readVault, writeVault, deleteVault, type VaultDeps} from './vault';
import {setEncryptionMode, type PrefsDeps} from './prefs';
import {clear as clearSessionKey, setActiveKeys} from './sessionKey';

export type Deps = {
  vault: VaultDeps;
  prefs: PrefsDeps;
};

export type FlowResult<T = void> =
  | {ok: true; value: T}
  | {ok: false; reason: string};

// First-time encrypt: take the user's plaintext KeyFile[] + chosen
// PIN, write the vault, set prefs.encryptionMode='encrypted',
// promote keys into sessionKey. Caller is responsible for then
// prompting the user to delete the source .txt(s).
export const encryptInitial = async (
  deps: Deps,
  pin: string,
  files: KeyFile[],
): Promise<FlowResult> => {
  if (files.length === 0) {
    return {ok: false, reason: 'no key files to encrypt'};
  }
  try {
    await writeVault(deps.vault, pin, files);
    await setEncryptionMode(deps.prefs, 'encrypted');
    setActiveKeys(files);
    return {ok: true, value: undefined};
  } catch (e) {
    return {ok: false, reason: (e as Error).message};
  }
};

// Read the encrypted vault with the supplied PIN. On success, also
// promotes into sessionKey.
export const unlock = async (
  deps: Deps,
  pin: string,
): Promise<
  | {kind: 'ok'; files: KeyFile[]}
  | {kind: 'wrong-pin'}
  | {kind: 'corrupt'; reason: string}
  | {kind: 'not-found'}
> => {
  const r = await readVault(deps.vault, pin);
  if (r.kind === 'ok') {
    setActiveKeys(r.files);
  }
  return r;
};

// Re-encrypt with a new PIN. Caller passes the in-memory files
// (already unlocked) so we don't ask twice.
export const changePin = async (
  deps: Deps,
  newPin: string,
  currentFiles: KeyFile[],
): Promise<FlowResult> => {
  try {
    await writeVault(deps.vault, newPin, currentFiles);
    return {ok: true, value: undefined};
  } catch (e) {
    return {ok: false, reason: (e as Error).message};
  }
};

// Merge a new plaintext .txt into the existing vault. Same-provider
// entries are replaced; new providers append. Re-encrypts under the
// SAME pin (caller has already unlocked and provides it back).
export const mergeIntoVault = async (
  deps: Deps,
  pin: string,
  currentFiles: KeyFile[],
  incoming: KeyFile[],
): Promise<FlowResult<KeyFile[]>> => {
  if (incoming.length === 0) {
    return {ok: false, reason: 'nothing to merge'};
  }
  const byProvider = new Map<string, KeyFile>();
  for (const f of currentFiles) {
    byProvider.set(f.provider, f);
  }
  for (const f of incoming) {
    byProvider.set(f.provider, f);
  }
  const merged = Array.from(byProvider.values());
  try {
    await writeVault(deps.vault, pin, merged);
    setActiveKeys(merged);
    return {ok: true, value: merged};
  } catch (e) {
    return {ok: false, reason: (e as Error).message};
  }
};

// Disable encryption: caller passes the unlocked files + writeBack
// callback that turns them back into .txt files on disk. We then
// delete the vault and flip prefs to plaintext. SessionKey is
// cleared because there's nothing to "lock" anymore.
export const disableEncryption = async (
  deps: Deps,
  writeBackPlaintext: (files: KeyFile[]) => Promise<void>,
  currentFiles: KeyFile[],
): Promise<FlowResult> => {
  try {
    await writeBackPlaintext(currentFiles);
    await deleteVault(deps.vault);
    await setEncryptionMode(deps.prefs, 'plaintext');
    clearSessionKey();
    return {ok: true, value: undefined};
  } catch (e) {
    return {ok: false, reason: (e as Error).message};
  }
};

// Forgot PIN / reset: deletes the vault, flips prefs back to
// 'undecided' so the next plaintext drop re-runs the migration prompt.
export const resetVault = async (deps: Deps): Promise<FlowResult> => {
  try {
    await deleteVault(deps.vault);
    await setEncryptionMode(deps.prefs, 'undecided');
    clearSessionKey();
    return {ok: true, value: undefined};
  } catch (e) {
    return {ok: false, reason: (e as Error).message};
  }
};

// Lock without changing anything. Just wipes sessionKey.
export const lockNow = (): void => {
  clearSessionKey();
};

// Helper for user-visible mode in the panel header. The chat surface
// uses this to decide whether to show the "your key is in plaintext"
// banner.
export const isInsecure = (mode: EncryptionMode): boolean =>
  mode === 'plaintext' || mode === 'undecided';
