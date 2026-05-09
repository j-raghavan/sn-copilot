// Coarse PII scrub for outbound provider payloads.
//
// Scope: best-effort redaction of the patterns that most commonly leak
// from notes — emails and long digit runs (phone, SSN, card, account).
// Designed to be conservative: we'd rather over-redact a license-plate
// number than ship a real bank account through.
//
// When the user toggles "PII redaction" off in the chat header, the
// caller skips this step entirely. The toggle is the contract; this
// module only enforces it on the text path.

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Seven or more consecutive digits — catches phone numbers (10),
// US SSNs (9), most card numbers (13-19) and account numbers without
// fragmenting four-digit years or short codes the LLM may need.
const LONG_DIGITS_RE = /\d{7,}/g;

export const EMAIL_PLACEHOLDER = '[REDACTED-EMAIL]';
export const NUMBER_PLACEHOLDER = '[REDACTED-NUMBER]';

export const redactPii = (text: string): string =>
  text
    .replace(EMAIL_RE, EMAIL_PLACEHOLDER)
    .replace(LONG_DIGITS_RE, NUMBER_PLACEHOLDER);
