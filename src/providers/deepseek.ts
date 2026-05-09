/**
 * DeepSeek Chat Completions API client (text-only).
 *
 * Endpoint: POST https://api.deepseek.com/v1/chat/completions
 * Auth:     Authorization: Bearer <key>
 *
 * The wire shape mirrors OpenAI's chat-completions API; same body
 * fields (model, messages, max_tokens), same response shape
 * (choices[0].message.content + usage).
 */

import {throwHttpError} from './_http';
import type {ProviderClient, ProviderRequest, ProviderResponse} from './ProviderClient';

const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';

export const createDeepSeekClient = (
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderClient => ({
  id: 'deepseek',
  async send(
    req: ProviderRequest,
    opts: {apiKey: string; model: string},
  ): Promise<ProviderResponse> {
    const start = Date.now();
    if (req.imageBase64) {
      // DeepSeek's chat-completions API doesn't accept images today —
      // drop the attachment but proceed with the text so the chat
      // still runs. The user's text-only prompt may still be useful.
      console.log(
        '[DEEPSEEK] image attachment dropped (provider is text-only)',
      );
    }
    const body = {
      model: opts.model,
      max_tokens: req.maxTokens,
      messages: [
        {role: 'system', content: req.systemPrompt},
        {role: 'user', content: req.userText},
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
      await throwHttpError('deepseek', res);
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
