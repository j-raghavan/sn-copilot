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
export const finiteOrUndefined = (v: unknown): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return undefined;
  }
  return v;
};

// Shared HTTP error formatter for provider clients. The body-text
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
