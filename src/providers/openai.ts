/**
 * OpenAI Chat Completions API client.
 *
 * Endpoint: POST https://api.openai.com/v1/chat/completions
 * Auth:     Authorization: Bearer <key>
 *
 * Token-cap parameter: legacy chat models (gpt-3.5, gpt-4, gpt-4o,
 * gpt-4o-mini) accept `max_tokens`. Newer reasoning + GPT-5 family
 * models (o1*, o3*, o4*, gpt-5*) REJECT `max_tokens` and require
 * `max_completion_tokens`. We pick the right field name at send
 * time based on the model id prefix — sending both fields makes
 * gpt-5 fail with a 400 ("unsupported parameter"), and sending only
 * `max_completion_tokens` makes legacy models fail too. So it has
 * to be one-or-the-other, chosen per call.
 */

import {throwHttpError} from './_http';
import type {ProviderClient, ProviderRequest, ProviderResponse} from './ProviderClient';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// Match OpenAI model ids that require `max_completion_tokens` instead
// of `max_tokens`. Covers:
//   - reasoning families:   o1*, o3*, o4*, o5* (e.g. o1-mini, o3-mini)
//   - GPT-5 generation:     gpt-5*, gpt-5-mini, gpt-5-nano
// Case-insensitive so user-supplied model ids with mixed casing work.
// Conservative: defaults to legacy max_tokens for anything that doesn't
// match — preserves compat with gpt-4o, gpt-4o-mini, gpt-4-turbo, etc.
const NEW_TOKEN_PARAM_RE = /^(o[1-9]|gpt-[5-9])/i;

export const usesMaxCompletionTokens = (model: string): boolean =>
  NEW_TOKEN_PARAM_RE.test(model);

export const createOpenAIClient = (
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderClient => ({
  id: 'openai',
  async send(
    req: ProviderRequest,
    opts: {apiKey: string; model: string},
  ): Promise<ProviderResponse> {
    const start = Date.now();
    // OpenAI Chat Completions: when only text, content is a string;
    // when text+image, content becomes an array of typed parts. The
    // image is attached as a data: URL inside an image_url part.
    type Part =
      | {type: 'text'; text: string}
      | {type: 'image_url'; image_url: {url: string}};
    const userContent: string | Part[] = req.imageBase64
      ? [
          {
            type: 'image_url',
            image_url: {url: `data:image/png;base64,${req.imageBase64}`},
          },
          {type: 'text', text: req.userText},
        ]
      : req.userText;
    const tokenCap = usesMaxCompletionTokens(opts.model)
      ? {max_completion_tokens: req.maxTokens}
      : {max_tokens: req.maxTokens};
    const body = {
      model: opts.model,
      ...tokenCap,
      messages: [
        {role: 'system', content: req.systemPrompt},
        {role: 'user', content: userContent},
      ],
    };
    const res = await fetchFn(ENDPOINT, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await throwHttpError('openai', res);
    }
    const data = (await res.json()) as {
      choices?: Array<{message?: {content?: string}}>;
      usage?: {prompt_tokens?: number; completion_tokens?: number};
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      usage: {
        inputTokens: Number(data.usage?.prompt_tokens ?? 0),
        outputTokens: Number(data.usage?.completion_tokens ?? 0),
      },
      latencyMs: Date.now() - start,
      modelId: typeof data.model === 'string' ? data.model : opts.model,
    };
  },
});
