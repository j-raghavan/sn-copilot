// Resolves which provider is active given the discovered key files.
// Pure function — no IO, fully unit-testable.
//
// Rules:
//   1. Zero key files                        → 'none' with setup message.
//   2. Exactly one key file                  → that provider.
//   3. Two or more files, agreeing default   → that provider.
//   4. Two or more files, disagreeing        → 'ambiguous'.
//   5. Two or more files, no default at all  → 'none' with setup message.
//   6. default_provider names a missing file → 'none'.

import type {KeyFile, ProviderId, ProviderResolution} from '../types';

export const resolveActiveProvider = (files: KeyFile[]): ProviderResolution => {
  if (files.length === 0) {
    return {
      kind: 'none',
      message:
        'No key file found. Drop a copilot-key-<provider>.txt file in MyStyle/SnCopilot/ to enable Copilot.',
    };
  }
  if (files.length === 1) {
    return {kind: 'ok', active: files[0], others: []};
  }

  // Aggregate default_provider declarations. We accept multiple files
  // declaring the SAME default_provider (redundant but consistent);
  // any disagreement is ambiguous.
  const declared = new Set<ProviderId>();
  for (const f of files) {
    if (f.defaultProvider !== undefined) {
      declared.add(f.defaultProvider);
    }
  }

  if (declared.size === 0) {
    return {
      kind: 'none',
      message:
        'Multiple key files configured but none marked default. Add `default_provider=<name>` to one file.',
    };
  }
  if (declared.size > 1) {
    return {
      kind: 'ambiguous',
      message:
        'Multiple key files declare conflicting default_provider values. Pick one.',
      candidates: files,
    };
  }

  const wanted = Array.from(declared)[0];
  const active = files.find(f => f.provider === wanted);
  if (!active) {
    return {
      kind: 'none',
      message: `default_provider="${wanted}" but no copilot-key-${wanted}.txt was found.`,
    };
  }
  return {
    kind: 'ok',
    active,
    others: files.filter(f => f.provider !== wanted),
  };
};
