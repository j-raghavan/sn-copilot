/**
 * Shared domain types for sn-copilot.
 *
 * The provider id is the company identifier (`'anthropic'`, not
 * `'claude'`), so the on-disk `copilot-key-<provider>.txt` filename
 * maps directly to ProviderId without translation.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'deepseek';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
] as const;

// Parsed contents of one copilot-key-<provider>.txt file. Produced by
// src/storage/keyFiles.ts, consumed by src/storage/activeProvider.ts.
//
// Vision capability is derived strictly from `provider` via
// isImageCapableProvider — there's no per-key opt-out. DeepSeek is
// the only text-only provider; the rest carry images. A `mode=…`
// line in the on-disk file is logged-and-ignored by the parser for
// backwards compatibility with old templates.
export type KeyFile = {
  provider: ProviderId;
  model: string;
  key: string;
  defaultProvider?: ProviderId;
  // Per-action override of the default PII redaction policy. text-only.
  clarifyRedact?: boolean;
  // Source path on disk; shown in Settings as "Managed by …".
  sourcePath: string;
};

// Single source of truth for "does this provider's API accept image
// inputs?". Used by the chat send path to decide whether to attach
// the page screenshot.
export const isImageCapableProvider = (provider: ProviderId): boolean =>
  provider !== 'deepseek';

// Resolved at startup and on Settings refresh. Either a fully
// validated active provider, or a reason no provider can be selected.
export type ProviderResolution =
  | {kind: 'ok'; active: KeyFile; others: KeyFile[]}
  | {kind: 'none'; message: string}
  | {kind: 'ambiguous'; message: string; candidates: KeyFile[]};

// User's choice for whether the key file lives plaintext on disk or
// encrypted with a PIN. `undecided` is the bootstrap state — the
// migration prompt sets it to one of the other two on first run.
export type EncryptionMode = 'plaintext' | 'encrypted' | 'undecided';

// Persisted alongside the encrypted vault (or alongside the plaintext
// .txt files if the user opts out). Held in a small JSON file under the
// plugin's private install dir, with fallback to MyStyle/SnCopilot.
export type CopilotPrefs = {
  version: 1;
  encryptionMode: EncryptionMode;
  // Minutes of inactivity before the in-memory derived key is wiped.
  // Only meaningful when encryptionMode === 'encrypted'.
  idleTimeoutMin: number;
};

export const DEFAULT_IDLE_TIMEOUT_MIN = 10;

export const DEFAULT_PREFS: Readonly<CopilotPrefs> = Object.freeze({
  version: 1 as const,
  encryptionMode: 'undecided' as const,
  idleTimeoutMin: DEFAULT_IDLE_TIMEOUT_MIN,
});
