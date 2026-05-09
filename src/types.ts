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

export type Mode = 'text' | 'image';

// Parsed contents of one copilot-key-<provider>.txt file. Produced by
// src/storage/keyFiles.ts, consumed by src/storage/activeProvider.ts.
export type KeyFile = {
  provider: ProviderId;
  model: string;
  key: string;
  mode: Mode;
  defaultProvider?: ProviderId;
  // Per-action override of the default PII redaction policy. text-only.
  clarifyRedact?: boolean;
  // Source path on disk; shown in Settings as "Managed by …".
  sourcePath: string;
};

// Resolved at startup and on Settings refresh. Either a fully
// validated active provider, or a reason no provider can be selected.
export type ProviderResolution =
  | {kind: 'ok'; active: KeyFile; others: KeyFile[]}
  | {kind: 'none'; message: string}
  | {kind: 'ambiguous'; message: string; candidates: KeyFile[]};
