/**
 * The contract every LLM provider implements. Callers depend only on
 * this interface, never on a concrete provider — `createProviderClient`
 * in `./index.ts` resolves the right implementation by id.
 */

import type {ProviderId} from '../types';

export type {ProviderId};

// Discriminator on a ProviderClient instance. Real provider ids are
// the same union as ProviderId; the offline / no-key fallback uses
// 'fake' so telemetry and routing can tell demo traffic apart from
// genuine Anthropic / OpenAI / etc. calls.
export type ProviderClientId = ProviderId | 'fake';

export interface ProviderRequest {
  systemPrompt: string;
  userText: string;
  // Optional base64-encoded PNG of the current page. Image-capable
  // providers (anthropic, openai, gemini) attach it as an image part
  // alongside the text; deepseek (text-only) drops it with a warn.
  imageBase64?: string;
  maxTokens: number;
  signal: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  usage: {inputTokens: number; outputTokens: number};
  latencyMs: number;
  modelId: string;
}

export interface ProviderClient {
  id: ProviderClientId;
  send(
    req: ProviderRequest,
    opts: {apiKey: string; model: string},
  ): Promise<ProviderResponse>;
}
