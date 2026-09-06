import type {StopReason} from './ProviderClient';

// Maps an OpenAI-shaped `finish_reason` onto the shared StopReason.
// Shared because the DeepSeek API is Chat Completions compatible and
// its response envelope is byte-identical to OpenAI's — duplicating
// the mapping would let the two drift.
export const mapChatCompletionsStopReason = (raw: unknown): StopReason => {
  switch (raw) {
    case 'stop':
      return 'complete';
    case 'length':
      return 'truncated';
    case 'content_filter':
      return 'refused';
    default:
      return 'unknown';
  }
};

// Numeric coercion that yields undefined rather than NaN. Provider
// usage fields are optional and occasionally malformed; NaN would
// propagate into logs and arithmetic silently.
// Same guard with a caller-supplied default, for the non-optional
// usage counts. Declaring finiteOrUndefined and then leaving the
// existing Number(x ?? 0) sites unguarded would be the worst of both:
// Number('abc') is NaN, and NaN propagates silently into logs.
export const finiteOr = (v: unknown, fallback: number): number => {
  const n = finiteOrUndefined(v);
  return n === undefined ? fallback : n;
};

export const finiteOrUndefined = (v: unknown): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return undefined;
  }
  return v;
};

// Small helpers shared by two or more provider clients: the HTTP error
// formatter, the Chat Completions stop-reason mapper (OpenAI and
// DeepSeek speak the same envelope), and the numeric coercions used on
// every usage field.
//
// Error formatter — the body-text
// read is best-effort — a thrown text() (rare, but observed on
// unparseable bodies) must not mask the original status code.

export const throwHttpError = async (
  provider: string,
  res: Response,
): Promise<never> => {
  const body = await res.text().catch(() => '');
  throw new Error(
    `${provider}: HTTP ${res.status}${body ? ` — ${body}` : ''}`,
  );
};
