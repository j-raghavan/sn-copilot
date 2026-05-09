/**
 * Provider registry — pick a concrete `ProviderClient` for the
 * resolved provider id. The `fetchFn` indirection lets tests inject
 * a mocked fetch routed by URL.
 */

import {createAnthropicClient} from './anthropic';
import {createOpenAIClient} from './openai';
import {createGeminiClient} from './gemini';
import {createDeepSeekClient} from './deepseek';
import type {ProviderClient, ProviderId} from './ProviderClient';

export const createProviderClient = (
  id: ProviderId,
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderClient => {
  switch (id) {
    case 'anthropic':
      return createAnthropicClient(fetchFn);
    case 'openai':
      return createOpenAIClient(fetchFn);
    case 'gemini':
      return createGeminiClient(fetchFn);
    case 'deepseek':
      return createDeepSeekClient(fetchFn);
  }
};
