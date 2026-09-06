// Why generation ended, normalised across providers, and the single
// place that decides whether a response is usable.
//
// This exists because every current flagship model reasons before it
// answers, and those reasoning tokens come out of the SAME output
// budget as the visible reply. A budget exhausted while thinking
// returns HTTP 200 with empty text — indistinguishable from a real
// answer unless the reason travels back with it.
//
// The policy lives here rather than at each call site: chat, Test
// Connection and the four Grill paths each need a different tolerance,
// and hand-writing that condition six times is how two of them drift
// apart (they already had).

import type {ProviderResponse, StopReason} from './ProviderClient';

export type {StopReason};

// Thrown when a provider returned 200 but generation did not produce a
// usable answer. Carries the reason so the message can say which.
export class ProviderStopError extends Error {
  constructor(readonly stopReason: StopReason) {
    super(`provider stopped: ${stopReason}`);
    this.name = 'ProviderStopError';
  }
}

// One message per stop reason. The three actionable reasons stay
// distinct from each other; `complete` and `unknown` deliberately share
// the empty-reply wording, because both mean "nothing came back" and
// there is nothing different for the user to do.
const STOP_MESSAGES: Record<StopReason, string> = {
  truncated:
    'The reply was cut off before it finished. Try a shorter question.',
  refused: 'The provider declined to answer this request.',
  context_overflow:
    'This conversation is too long to continue. Start a new chat.',
  complete: 'The model returned an empty reply. Please try again.',
  unknown: 'The model returned an empty reply. Please try again.',
};

export const stopReasonMessage = (reason: StopReason): string =>
  STOP_MESSAGES[reason];

export const isEmptyText = (text: unknown): boolean =>
  typeof text !== 'string' || text.trim().length === 0;

/**
 * Throws ProviderStopError unless the response can be shown to the user.
 *
 * `acceptPartial` is the per-call-site tolerance, and the three answers
 * are genuinely different:
 *   - chat passes true — a truncated reply that still has text is worth
 *     keeping, marked as cut off; the user paid for those tokens.
 *   - Test Connection passes false — a diagnostic that reports "working"
 *     while the budget is misconfigured is worse than useless.
 *   - Grill passes false — truncated JSON cannot be parsed, and it
 *     previously surfaced as "the model did not return valid JSON",
 *     blaming the model for budget exhaustion.
 */
export const usabilityError = (
  r: Pick<ProviderResponse, 'text' | 'stopReason'>,
  opts: {acceptPartial: boolean},
): StopReason | null => {
  if (r.stopReason === 'refused' || r.stopReason === 'context_overflow') {
    return r.stopReason;
  }
  if (isEmptyText(r.text)) {
    return r.stopReason;
  }
  if (r.stopReason === 'truncated' && !opts.acceptPartial) {
    return 'truncated';
  }
  return null;
};

/** Throwing form, for callers with an existing catch that already does
 *  the right thing (chat persists the user's turn; Settings sets the
 *  error status). Grill uses usabilityError directly — it needs a
 *  message for its own error type, and routing through an exception
 *  there would add an unreachable instanceof branch. */
export const assertUsable = (
  r: Pick<ProviderResponse, 'text' | 'stopReason'>,
  opts: {acceptPartial: boolean},
): void => {
  const bad = usabilityError(r, opts);
  if (bad !== null) {
    throw new ProviderStopError(bad);
  }
};
