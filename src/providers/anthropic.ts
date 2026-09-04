/**
 * Anthropic Messages API client.
 *
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Auth:     x-api-key header + anthropic-version header
 *
 * Response: `content[]` of typed blocks; we concatenate every `text`
 * block in order. Token usage at `usage.input_tokens` /
 * `usage.output_tokens`.
 */

import {throwHttpError} from './_http';
import type {ProviderClient, ProviderRequest, ProviderResponse} from './ProviderClient';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

const extractText = (data: unknown): string => {
  const d = data as {content?: Array<{type?: string; text?: string}>};
  const blocks = Array.isArray(d.content) ? d.content : [];
  return blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('');
};

export const createAnthropicClient = (
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderClient => ({
  id: 'anthropic',
  async send(
    req: ProviderRequest,
    opts: {apiKey: string; model: string},
  ): Promise<ProviderResponse> {
    const start = Date.now();
    // Image block (when present) precedes the text — Anthropic's
    // documented best practice and what the Messages API expects.
    type CacheControl = {type: 'ephemeral'};
    type Block =
      | {type: 'text'; text: string}
      | {
          type: 'image';
          source: {type: 'base64'; media_type: string; data: string};
          cache_control?: CacheControl;
        };
    const content: Block[] = [];
    if (req.imageBase64) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: req.imageBase64,
        },
        // Cache breakpoint at the END of the stable prefix. Everything
        // before and including this block — the system prompt and the
        // page screenshot — is byte-identical for every send against
        // the same capture (pageContext holds one base64 string per
        // sidebar tap), so repeat sends bill it at ~10% instead of
        // full price. The volatile user text follows and stays outside
        // the cached region, which is the whole point: a top-level
        // marker would auto-place AFTER that text and cache a prefix
        // nothing ever matches, paying the 1.25x write premium on
        // every request for zero reads.
        //
        // Only set when an image is present. Without one the stable
        // prefix is the system prompt alone (~400 tokens), below every
        // model's minimum cacheable size, so a marker there would be a
        // silent no-op — and text-only paths (Test Connection, the
        // Grill judge/rephrase calls) keep their exact previous wire
        // shape.
        cache_control: {type: 'ephemeral'},
      });
    }
    content.push({type: 'text', text: req.userText});
    // Prior turns first (normalised upstream: starts with 'user',
    // alternating, non-empty — the shape this API enforces), then the
    // current user message.
    const history = (req.history ?? []).map(t => ({
      role: t.role,
      content: t.text,
    }));
    const body = {
      model: opts.model,
      max_tokens: req.maxTokens,
      system: req.systemPrompt,
      messages: [...history, {role: 'user', content}],
    };
    const res = await fetchFn(ENDPOINT, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await throwHttpError('anthropic', res);
    }
    const data = (await res.json()) as {
      content?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      model?: string;
    };
    return {
      text: extractText(data),
      usage: {
        inputTokens: Number(data.usage?.input_tokens ?? 0),
        outputTokens: Number(data.usage?.output_tokens ?? 0),
        cacheReadInputTokens: Number(data.usage?.cache_read_input_tokens ?? 0),
        cacheCreationInputTokens: Number(
          data.usage?.cache_creation_input_tokens ?? 0,
        ),
      },
      latencyMs: Date.now() - start,
      modelId: typeof data.model === 'string' ? data.model : opts.model,
    };
  },
});
