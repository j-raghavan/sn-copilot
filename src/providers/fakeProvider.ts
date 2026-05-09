/**
 * Stub `ProviderClient` for offline / no-key demo flows.
 *
 *  - Resolves after `FAKE_LATENCY_MS` so the UI shows a realistic
 *    "thinking" state.
 *  - Picks a canned response from a small lookup keyed on the first
 *    action keyword in `userText` (summarize/explain/action items/
 *    clarify); a generic fallback handles anything else.
 *  - Honours `AbortSignal` only at call time (we don't subscribe;
 *    see comment on `sleep` below).
 */

import type {
  ProviderClient,
  ProviderRequest,
  ProviderResponse,
  ProviderId,
} from './ProviderClient';

const FAKE_LATENCY_MS = 600;
const FAKE_MODEL_ID = 'fake-model-1';
const DEFAULT_INPUT_TOKENS = 142;
const DEFAULT_OUTPUT_TOKENS = 38;

const CANNED_RESPONSES: Record<string, string> = {
  summarize:
    '• Notes are too long to skim\n' +
    '• Summary actions would help\n' +
    '• Action items are buried',
  explain:
    'The notes describe a plan to build an AI assistant plugin for a ' +
    'note-taking tablet, with privacy and offline support as key ' +
    'requirements.',
  'action items':
    '[ ] Define deployment model\n' +
    '[ ] Clarify offline behaviour\n' +
    '[ ] Prototype UI flows',
  clarify:
    'Project Notes\n\n' +
    'Goal: Build an AI Assistant plugin for note-taking tablets.\n\n' +
    'User pain points:\n' +
    '- Hard to summarize long notes\n' +
    '- Unclear next steps after meetings\n' +
    '- Need privacy and offline support',
};

const FALLBACK_RESPONSE =
  'This is a fake provider response. Configure a real provider via a ' +
  'copilot-key-<provider>.txt file in MyStyle/SnCopilot/ to get live ' +
  'replies.';

const matchActionKeyword = (text: string): string | null => {
  const lower = text.toLowerCase();
  if (lower.includes('summarize')) {
    return 'summarize';
  }
  if (lower.includes('explain')) {
    return 'explain';
  }
  if (lower.includes('action items')) {
    return 'action items';
  }
  if (lower.includes('clarify')) {
    return 'clarify';
  }
  return null;
};

// Bare setTimeout — we don't subscribe to `signal.addEventListener('abort')`
// because the Supernote firmware's Hermes build has shown the
// callback never fire in practice, hanging the chat. We still
// reject up-front if the signal is already aborted at call time.
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    setTimeout(resolve, ms);
  });

export const fakeProvider: ProviderClient = {
  id: 'anthropic' satisfies ProviderId,
  async send(
    req: ProviderRequest,
    opts: {apiKey: string; model: string},
  ): Promise<ProviderResponse> {
    const start = Date.now();
    await sleep(FAKE_LATENCY_MS, req.signal);
    const keyword = matchActionKeyword(req.userText);
    const text =
      keyword !== null ? CANNED_RESPONSES[keyword] : FALLBACK_RESPONSE;
    return {
      text,
      usage: {
        inputTokens: DEFAULT_INPUT_TOKENS,
        outputTokens: DEFAULT_OUTPUT_TOKENS,
      },
      latencyMs: Date.now() - start,
      modelId: opts.model || FAKE_MODEL_ID,
    };
  },
};

export default fakeProvider;
