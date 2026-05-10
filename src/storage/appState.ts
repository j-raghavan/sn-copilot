// Pure function that decides what UI to render based on the
// observable facts at startup (and whenever the user takes an action
// that changes them).
//
// Inputs are snapshots — IO is the caller's job. This keeps the
// decision logic 100% unit-testable and means CopilotPanel can be a
// thin orchestrator over `computeAppState`.
//
// State machine:
//
//   no-key        → no vault file AND no plaintext .txt files.
//   plaintext     → no vault, plaintext files exist, mode='plaintext'.
//                    (today's behaviour; also chosen for 'undecided'
//                    + plaintext when the user is in the chat sidebar
//                    and we don't want to interrupt them — the
//                    Settings cog surfaces the migration prompt.)
//   migrate       → vault doesn't exist, plaintext files exist, and
//                    mode='undecided'. Show MigrationPrompt.
//   merge         → vault exists AND plaintext files exist (rotation /
//                    new provider added). Show unlock first; the
//                    merge happens in the unlock callback.
//   locked        → vault exists, no plaintext, no in-memory key.
//   unlocked      → vault exists and in-memory key is loaded.

import type {EncryptionMode, KeyFile} from '../types';

export type AppState =
  | {kind: 'no-key'}
  | {kind: 'plaintext'; files: KeyFile[]}
  | {kind: 'migrate'; files: KeyFile[]}
  | {kind: 'merge'; vaultExists: true; plaintextFiles: KeyFile[]}
  | {kind: 'locked'}
  | {kind: 'unlocked'; files: KeyFile[]};

export type AppStateInputs = {
  vaultExists: boolean;
  plaintextFiles: KeyFile[];
  encryptionMode: EncryptionMode;
  unlockedFiles: KeyFile[] | null;
};

export const computeAppState = (i: AppStateInputs): AppState => {
  // Fast paths that don't depend on encryption mode.
  if (i.vaultExists && i.unlockedFiles !== null) {
    if (i.plaintextFiles.length > 0) {
      // Edge case: unlocked but a new .txt landed since last unlock.
      // We still surface the merge prompt so the user can fold it in.
      return {
        kind: 'merge',
        vaultExists: true,
        plaintextFiles: i.plaintextFiles,
      };
    }
    return {kind: 'unlocked', files: i.unlockedFiles};
  }
  if (i.vaultExists && i.plaintextFiles.length > 0) {
    return {
      kind: 'merge',
      vaultExists: true,
      plaintextFiles: i.plaintextFiles,
    };
  }
  if (i.vaultExists) {
    return {kind: 'locked'};
  }

  // No vault from here on.
  if (i.plaintextFiles.length === 0) {
    return {kind: 'no-key'};
  }

  if (i.encryptionMode === 'undecided') {
    return {kind: 'migrate', files: i.plaintextFiles};
  }
  // 'plaintext' OR 'encrypted' (the latter shouldn't happen — vault
  // doesn't exist yet — but we collapse it to plaintext rather than
  // showing nothing).
  return {kind: 'plaintext', files: i.plaintextFiles};
};
