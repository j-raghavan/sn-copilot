import {
  redactPii,
  EMAIL_PLACEHOLDER,
  NUMBER_PLACEHOLDER,
} from '../src/privacy/redact';

describe('redactPii', () => {
  it('replaces email addresses', () => {
    expect(redactPii('contact me at jay@example.com today')).toBe(
      `contact me at ${EMAIL_PLACEHOLDER} today`,
    );
  });

  it('replaces multiple emails in one pass', () => {
    expect(redactPii('a@b.co and c.d+tag@e.io')).toBe(
      `${EMAIL_PLACEHOLDER} and ${EMAIL_PLACEHOLDER}`,
    );
  });

  it('replaces 7+ digit runs (phone, ssn, card, account)', () => {
    expect(redactPii('call 5551234567 or wire 4111111111111111')).toBe(
      `call ${NUMBER_PLACEHOLDER} or wire ${NUMBER_PLACEHOLDER}`,
    );
  });

  it('leaves short numeric tokens (years, page nums) intact', () => {
    expect(redactPii('see page 42 from 2026 onwards')).toBe(
      'see page 42 from 2026 onwards',
    );
  });

  it('is a no-op for empty input', () => {
    expect(redactPii('')).toBe('');
  });

  it('redacts emails embedded inside surrounding text', () => {
    const out = redactPii('Forward: jane.doe+work@corp.example.co.uk please');
    expect(out).toContain(EMAIL_PLACEHOLDER);
    expect(out).not.toContain('jane.doe');
  });

  it('preserves non-PII content verbatim', () => {
    const out = redactPii('Summarize the meeting notes from yesterday.');
    expect(out).toBe('Summarize the meeting notes from yesterday.');
  });
});
