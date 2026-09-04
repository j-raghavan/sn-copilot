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

// One prior exchange turn, as replayed to the provider. Kept
// deliberately text-only: page context attached to EARLIER turns is
// not resent (token economy — the reply that used it already carries
// the relevant conclusions), and no image ever rides along in
// history.
export type ProviderTurn = {
  role: 'user' | 'assistant';
  text: string;
};

export interface ProviderRequest {
  systemPrompt: string;
  userText: string;
  // Optional base64-encoded PNG of the current page. Image-capable
  // providers (anthropic, openai, gemini) attach it as an image part
  // alongside the text; deepseek (text-only) drops it with a warn.
  imageBase64?: string;
  // Prior turns of the current conversation, oldest first, already
  // normalised by buildProviderHistory (starts with 'user', strictly
  // alternating, no empty texts) so every provider can map it 1:1
  // onto its native message array. Absent/empty → single-turn send,
  // identical to the previous behaviour.
  history?: ProviderTurn[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    // Prompt-cache accounting, when the provider reports it
    // (Anthropic today). Cache reads bill at ~10% of the input rate —
    // surfacing them keeps the cost picture honest in logs and lets
    // the user verify caching works from their provider dashboard.
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
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
