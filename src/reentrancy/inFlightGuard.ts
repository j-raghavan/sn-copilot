/**
 * Prevents concurrent provider invocations. When the user hammers an
 * action button while a request is in flight, the second tap is a
 * no-op — not a queued call, not an in-flight cancel.
 *
 * Module-level state because the overlay only ever has a single user
 * and a single in-flight request at any time.
 */

let inFlight = false;

export function tryAcquire(): boolean {
  if (inFlight) {
    return false;
  }
  inFlight = true;
  return true;
}

export function release(): void {
  inFlight = false;
}

export function isInFlight(): boolean {
  return inFlight;
}

// Test-only helper. Production code should never reach into this —
// `release()` is the public API for clearing the flag.
export const __testing__ = {
  reset(): void {
    inFlight = false;
  },
};
