import {sanitizeProviderError} from '../src/ui/sanitizeProviderError';

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
