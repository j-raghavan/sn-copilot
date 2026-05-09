/**
 * Tests for src/reentrancy/inFlightGuard. The contract:
 *   1. First tryAcquire() returns true; flag is set.
 *   2. Subsequent tryAcquire() before release() returns false.
 *   3. After release(), tryAcquire() succeeds again.
 *   4. isInFlight reflects the current flag.
 */
import {
  tryAcquire,
  release,
  isInFlight,
  __testing__,
} from '../src/reentrancy/inFlightGuard';

beforeEach(() => {
  __testing__.reset();
});

describe('inFlightGuard', () => {
  it('starts in non-in-flight state', () => {
    expect(isInFlight()).toBe(false);
  });

  it('first tryAcquire() succeeds and flips the flag', () => {
    expect(tryAcquire()).toBe(true);
    expect(isInFlight()).toBe(true);
  });

  it('second tryAcquire() before release() is a no-op', () => {
    expect(tryAcquire()).toBe(true);
    expect(tryAcquire()).toBe(false);
    expect(tryAcquire()).toBe(false);
    expect(isInFlight()).toBe(true);
  });

  it('release() clears the flag and re-enables acquisition', () => {
    tryAcquire();
    expect(isInFlight()).toBe(true);
    release();
    expect(isInFlight()).toBe(false);
    expect(tryAcquire()).toBe(true);
  });

  it('release() is idempotent', () => {
    release();
    release();
    expect(isInFlight()).toBe(false);
  });
});
