// User-facing sanitization for provider errors.
//
// Raw error messages from a ProviderClient include the upstream HTTP
// body text (formatted by src/providers/_http.ts) or low-level
// network errors. Surfacing those verbatim in a chat bubble leaks
// implementation detail and can include API request ids the user
// has no use for. The detailed text remains in console.log; the UI
// gets a short, recognisable summary.

import type {StopReason} from '../providers/ProviderClient';

// Thrown when a provider returned HTTP 200 but generation did not
// complete usefully — the budget ran out, the provider declined, or
// the reply came back empty. Carries the reason so the bubble can say
// which, rather than collapsing to the generic fallback below.
export class ProviderStopError extends Error {
  constructor(readonly stopReason: StopReason) {
    super(`provider stopped: ${stopReason}`);
    this.name = 'ProviderStopError';
  }
}

// One message per stop reason. These must stay pairwise distinct —
// that is the whole point of carrying the reason back, and a test
// asserts it.
const STOP_MESSAGES: Record<StopReason, string> = {
  truncated:
    'The reply was cut off before it finished. Try a shorter question.',
  refused: 'The provider declined to answer this request.',
  context_overflow:
    'This conversation is too long to continue. Start a new chat.',
  complete: 'The model returned an empty reply. Please try again.',
  unknown: 'The model returned an empty reply. Please try again.',
};

export const sanitizeProviderError = (err: unknown): string => {
  // Checked first: a ProviderStopError carries a specific reason, and
  // falling through to the generic branches below would erase it.
  if (err instanceof ProviderStopError) {
    return STOP_MESSAGES[err.stopReason];
  }
  const raw = err instanceof Error ? err.message : String(err);
  if (/aborted/i.test(raw)) {
    return 'Request timed out. Please try again.';
  }
  const httpMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*HTTP\s+(\d+)/);
  if (httpMatch) {
    return `${httpMatch[1]}: HTTP ${httpMatch[2]}`;
  }
  return 'Provider request failed.';
};
