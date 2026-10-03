/**
 * Tests for src/providers/stopReason — the single place that decides
 * whether a provider response is usable.
 *
 * Pins:
 *   1. refused / context_overflow always throw, text or not.
 *   2. Empty text always throws, whatever the reason claims.
 *   3. truncated depends on the call site's tolerance, which is the
 *      reason this is one function with a flag rather than two
 *      hand-written conditions that drifted apart.
 *   4. Non-string text counts as empty and never reaches .trim().
 */
import {
  assertUsable,
  isEmptyText,
  ProviderStopError,
  stopReasonMessage,
} from '../src/providers/stopReason';
import type {StopReason} from '../src/providers/ProviderClient';

const res = (text: unknown, stopReason: StopReason) =>
  ({text, stopReason}) as unknown as {text: string; stopReason: StopReason};

describe('assertUsable', () => {
  it.each(['refused', 'context_overflow'] as const)(
    '%s throws even with good text',
    reason => {
      // The stop reason wins over content: a refusal's prose must not
      // be presented as a normal answer.
      expect(() =>
        assertUsable(res('here is an answer', reason), {acceptPartial: true}),
      ).toThrow(ProviderStopError);
    },
  );

  it.each(['complete', 'unknown', 'truncated'] as const)(
    'empty text throws under %s',
    reason => {
      expect(() =>
        assertUsable(res('   \n ', reason), {acceptPartial: true}),
      ).toThrow(ProviderStopError);
    },
  );

  it('truncated with text passes when the caller accepts partials', () => {
    expect(() =>
      assertUsable(res('half an answer', 'truncated'), {acceptPartial: true}),
    ).not.toThrow();
  });

  it('truncated with text throws when the caller does not', () => {
    // Test Connection and Grill: a diagnostic that says "working" on a
    // misconfigured budget is worthless, and truncated JSON will not
    // parse.
    expect(() =>
      assertUsable(res('half an answer', 'truncated'), {acceptPartial: false}),
    ).toThrow(ProviderStopError);
  });

  it.each(['complete', 'unknown'] as const)(
    '%s with text passes under both tolerances',
    reason => {
      for (const acceptPartial of [true, false]) {
        expect(() =>
          assertUsable(res('a real answer', reason), {acceptPartial}),
        ).not.toThrow();
      }
    },
  );

  it('carries the reason on the thrown error', () => {
    try {
      assertUsable(res('', 'truncated'), {acceptPartial: true});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderStopError);
      expect((e as ProviderStopError).stopReason).toBe('truncated');
    }
  });
});

describe('isEmptyText', () => {
  it.each([['', true], ['   ', true], ['\n\t', true], ['x', false]] as const)(
    '%p → %p',
    (v, expected) => {
      expect(isEmptyText(v)).toBe(expected);
    },
  );

  it.each([undefined, null, 42, {}, []])(
    'treats non-string %p as empty rather than calling .trim() on it',
    v => {
      // A hostile response body can put a number or object here; the
      // caller must never reach text.trim().
      expect(isEmptyText(v)).toBe(true);
    },
  );
});

describe('stopReasonMessage', () => {
  it('keeps the three actionable reasons distinct from one another', () => {
    const actionable = (['truncated', 'refused', 'context_overflow'] as const).map(
      stopReasonMessage,
    );
    expect(new Set(actionable).size).toBe(3);
  });

  it('gives every reason a non-empty message', () => {
    const all: StopReason[] = [
      'complete',
      'truncated',
      'refused',
      'context_overflow',
      'unknown',
    ];
    for (const r of all) {
      expect(stopReasonMessage(r).length).toBeGreaterThan(0);
    }
  });

  it('deliberately shares one wording between complete and unknown', () => {
    // Both mean "nothing came back" and there is nothing different for
    // the user to do — documented so a future reader does not "fix" it.
    expect(stopReasonMessage('complete')).toBe(stopReasonMessage('unknown'));
  });
});
