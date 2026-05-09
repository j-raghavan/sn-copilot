/**
 * Google Gemini Generative Language API client.
 *
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * Auth:     ?key=<key> query parameter
 */

import {throwHttpError} from './_http';
import type {ProviderClient, ProviderRequest, ProviderResponse} from './ProviderClient';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const createGeminiClient = (
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderClient => ({
  id: 'gemini',
  async send(
    req: ProviderRequest,
    opts: {apiKey: string; model: string},
  ): Promise<ProviderResponse> {
    const start = Date.now();
    // Gemini accepts image as an inline_data part with a base64 string
    // and explicit mime_type. Ordering: image first, text second.
    type Part =
      | {text: string}
      | {inline_data: {mime_type: string; data: string}};
    const parts: Part[] = [];
    if (req.imageBase64) {
      parts.push({
        inline_data: {mime_type: 'image/png', data: req.imageBase64},
      });
    }
    parts.push({text: req.userText});
    const body = {
      systemInstruction: {parts: [{text: req.systemPrompt}]},
      contents: [{role: 'user', parts}],
      generationConfig: {maxOutputTokens: req.maxTokens},
    };
    const url = `${BASE}/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
    const res = await fetchFn(url, {
      method: 'POST',
      signal: req.signal,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await throwHttpError('gemini', res);
    }
    const data = (await res.json()) as {
      candidates?: Array<{content?: {parts?: Array<{text?: string}>}}>;
      usageMetadata?: {promptTokenCount?: number; candidatesTokenCount?: number};
      modelVersion?: string;
    };
    const respParts = data.candidates?.[0]?.content?.parts ?? [];
    const text = respParts.map(p => p.text ?? '').join('');
    return {
      text,
      usage: {
        inputTokens: Number(data.usageMetadata?.promptTokenCount ?? 0),
        outputTokens: Number(data.usageMetadata?.candidatesTokenCount ?? 0),
      },
      latencyMs: Date.now() - start,
      modelId: typeof data.modelVersion === 'string' ? data.modelVersion : opts.model,
    };
  },
});
