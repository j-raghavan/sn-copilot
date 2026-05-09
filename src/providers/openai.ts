/**
 * OpenAI Chat Completions API client.
 *
 * Endpoint: POST https://api.openai.com/v1/chat/completions
 * Auth:     Authorization: Bearer <key>
 */

import {throwHttpError} from './_http';
import type {ProviderClient, ProviderRequest, ProviderResponse} from './ProviderClient';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

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
    const body = {
      model: opts.model,
      max_tokens: req.maxTokens,
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
