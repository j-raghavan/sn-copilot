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
