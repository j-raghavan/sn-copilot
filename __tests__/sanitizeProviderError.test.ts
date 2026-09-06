import {
  ProviderStopError,
  sanitizeProviderError,
} from '../src/ui/sanitizeProviderError';

describe('sanitizeProviderError', () => {
  it('maps an "aborted" error to a timeout-friendly message', () => {
    expect(sanitizeProviderError(new Error('aborted'))).toBe(
      'Request timed out. Please try again.',
    );
  });

  it('preserves provider + status for HTTP errors and drops the body', () => {
    expect(
      sanitizeProviderError(
        new Error('anthropic: HTTP 401 — {"error":"invalid api key"}'),
      ),
    ).toBe('anthropic: HTTP 401');
  });

  it('handles HTTP errors without a body suffix', () => {
    expect(sanitizeProviderError(new Error('openai: HTTP 500'))).toBe(
      'openai: HTTP 500',
    );
  });

  it('falls back to a generic summary for unknown shapes', () => {
    expect(sanitizeProviderError(new Error('weird thing happened'))).toBe(
      'Provider request failed.',
    );
  });

  it('handles non-Error rejections', () => {
    expect(sanitizeProviderError('plain string')).toBe(
      'Provider request failed.',
    );
  });
});

describe('sanitizeProviderError — ProviderStopError', () => {
  it.each([
    ['truncated', /cut off/i],
    ['refused', /declined/i],
    ['context_overflow', /new chat/i],
    ['complete', /empty reply/i],
    ['unknown', /empty reply/i],
  ] as const)('%s produces its own message', (reason, pattern) => {
    expect(sanitizeProviderError(new ProviderStopError(reason))).toMatch(
      pattern,
    );
  });

  it('never falls through to the generic failure text', () => {
    // The bug this guards: sanitizeProviderError returns
    // "Provider request failed." for anything it does not recognise,
    // which would make all four stop reasons read identically.
    const reasons = [
      'truncated',
      'refused',
      'context_overflow',
      'complete',
      'unknown',
    ] as const;
    for (const r of reasons) {
      expect(sanitizeProviderError(new ProviderStopError(r))).not.toBe(
        'Provider request failed.',
      );
    }
  });

  it('keeps the three actionable reasons pairwise distinct', () => {
    const distinct = [
      sanitizeProviderError(new ProviderStopError('truncated')),
      sanitizeProviderError(new ProviderStopError('refused')),
      sanitizeProviderError(new ProviderStopError('context_overflow')),
    ];
    expect(new Set(distinct).size).toBe(3);
  });

  it('still sanitises ordinary errors unchanged', () => {
    expect(sanitizeProviderError(new Error('aborted'))).toMatch(/timed out/i);
    expect(sanitizeProviderError(new Error('openai: HTTP 429 — slow down'))).toBe(
      'openai: HTTP 429',
    );
    expect(sanitizeProviderError(new Error('socket hang up'))).toBe(
      'Provider request failed.',
    );
  });
});
