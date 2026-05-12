// Resolves where the encrypted vault and the prefs file live.
//
// Strategy:
//   1. Probe `PluginManager.getPluginDirPath()`. The host is supposed
//      to return a private-ish per-plugin install path, but the typed
//      contract is `Promise<string | null | undefined>` so we treat
//      a falsy or throwing result as "not available" rather than
//      crashing.
//   2. On success, files live alongside the plugin install
//      (`<dir>/copilot-key.enc` + `<dir>/copilot-prefs.json`).
//   3. On failure, fall back to a hidden file under MyStyle/SnCopilot.
//      The vault is encrypted, so privacy doesn't degrade — only the
//      "harder for a casual hostile plugin to grep" bonus does.
//
// Pure-ish: takes a probe function so tests don't need to mock the
// whole sn-plugin-lib import.

import {DEFAULT_KEY_ROOT} from './keyFiles';

export const VAULT_FILENAME = 'copilot-key.enc';
export const PREFS_FILENAME = 'copilot-prefs.json';
export const CONVERSATIONS_FILENAME = 'copilot-conversations.json';
const FALLBACK_VAULT_FILENAME = '.copilot-key.enc';
const FALLBACK_PREFS_FILENAME = '.copilot-prefs.json';
const FALLBACK_CONVERSATIONS_FILENAME = '.copilot-conversations.json';

export type ResolvedPaths = {
  // Plugin-private dir if available; null when we fell back.
  baseDir: string | null;
  vaultPath: string;
  prefsPath: string;
  // History file path — same dir as the vault; auto-detected as
  // plaintext-or-encrypted by the conversations store on read.
  conversationsPath: string;
};

export type PluginDirProbe = () => Promise<string | null | undefined>;

const trimTrailingSlash = (p: string): string =>
  p.endsWith('/') ? p.slice(0, -1) : p;

export const resolveVaultPaths = async (
  probe: PluginDirProbe,
): Promise<ResolvedPaths> => {
  let dir: string | null = null;
  try {
    const raw = await probe();
    if (typeof raw === 'string' && raw.length > 0) {
      dir = trimTrailingSlash(raw);
    }
  } catch {
    // Host didn't implement getPluginDirPath, or it threw. Either way
    // we fall back; no point surfacing this as a user-visible error.
    dir = null;
  }
  if (dir !== null) {
    return {
      baseDir: dir,
      vaultPath: `${dir}/${VAULT_FILENAME}`,
      prefsPath: `${dir}/${PREFS_FILENAME}`,
      conversationsPath: `${dir}/${CONVERSATIONS_FILENAME}`,
    };
  }
  return {
    baseDir: null,
    vaultPath: `${DEFAULT_KEY_ROOT}/${FALLBACK_VAULT_FILENAME}`,
    prefsPath: `${DEFAULT_KEY_ROOT}/${FALLBACK_PREFS_FILENAME}`,
    conversationsPath: `${DEFAULT_KEY_ROOT}/${FALLBACK_CONVERSATIONS_FILENAME}`,
  };
};
