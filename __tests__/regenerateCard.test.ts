/**
 * Tests for src/grill/regenerateCard. Pins:
 *  - happy path → returns a NEW card with the SAME id as the original
 *  - provider failure → DeckGenerationError(provider)
 *  - malformed JSON → DeckGenerationError(parse)
 *  - empty array → DeckGenerationError(empty)
 *  - invalid card shape → DeckGenerationError(empty)
 *  - attachImage gating
 */
import {regenerateCard} from '../src/grill/regenerateCard';
import {
  Card,
  DeckGenerationError,
  REGENERATE_CARD_MAX_TOKENS,
} from '../src/grill/deckTypes';
import {GRILL_SYSTEM_PROMPT} from '../src/grill/deckGenerator';
import type {
  ProviderClient,
  ProviderRequest,
} from '../src/providers/ProviderClient';
import type {PageContext} from '../src/scope/pageContext';

const PAGE: PageContext = {
  notePath: '/foo.pdf',
  page: 1,
  screenshotPath: '/tmp/p.png',
  screenshotBase64: 'B64',
  pageText: 'sample',
};

const original: Card = {
  id: 'deck-x-c1',
  type: 'definition',
  stem: 'What is photosynthesis?',
  choices: ['A', 'B', 'C', 'D'] as const,
  correctIndex: 0,
  explanation: 'because',
  sourceQuote: '',
};

const replacement = (id = 'm1') => ({
  id,
  type: 'inference',
  stem: 'Replacement?',
  choices: ['W', 'X', 'Y', 'Z'],
  correctIndex: 1,
  explanation: 'reason',
  sourceQuote: 'q',
});

const stubProvider = (
  text: string,
  observe?: (req: ProviderRequest) => void,
): ProviderClient => ({
  id: 'fake',
  async send(req, opts) {
    if (observe) {
      observe(req);
    }
    return {
      text,
      usage: {inputTokens: 1, outputTokens: 1},
      latencyMs: 1,
      modelId: opts.model,
    };
  },
});

const rejectProvider = (err: unknown): ProviderClient => ({
  id: 'fake',
  async send() {
    throw err;
  },
});

describe('regenerateCard', () => {
  it('returns a card preserving the original id', async () => {
    const body = JSON.stringify([replacement()]);
    const c = await regenerateCard({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      originalCard: original,
      signal: new AbortController().signal,
    });
    expect(c.id).toBe(original.id);
    expect(c.type).toBe('inference');
    expect(c.stem).toBe('Replacement?');
  });

  it('uses the grill system prompt and includes the original in user text', async () => {
    let captured: ProviderRequest | undefined;
    await regenerateCard({
      client: stubProvider(JSON.stringify([replacement()]), (req) => {
        captured = req;
      }),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      originalCard: original,
      signal: new AbortController().signal,
    });
    expect(captured?.systemPrompt).toBe(GRILL_SYSTEM_PROMPT);
    expect(captured?.userText).toContain('photosynthesis');
    expect(captured?.imageBase64).toBe(PAGE.screenshotBase64);
    expect(captured?.maxTokens).toBe(REGENERATE_CARD_MAX_TOKENS);
  });

  it('omits image when attachImage is false', async () => {
    let captured: ProviderRequest | undefined;
    await regenerateCard({
      client: stubProvider(JSON.stringify([replacement()]), (req) => {
        captured = req;
      }),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      originalCard: original,
      signal: new AbortController().signal,
      attachImage: false,
    });
    expect(captured?.imageBase64).toBeUndefined();
  });

  it('wraps provider rejection as DeckGenerationError(provider)', async () => {
    await expect(
      regenerateCard({
        client: rejectProvider(new Error('boom')),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        originalCard: original,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'provider'});
  });

  it('wraps a non-Error provider rejection', async () => {
    await expect(
      regenerateCard({
        client: rejectProvider('weird'),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        originalCard: original,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DeckGenerationError);
  });

  it('throws DeckGenerationError(parse) on bad JSON', async () => {
    await expect(
      regenerateCard({
        client: stubProvider('not json'),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        originalCard: original,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'parse'});
  });

  it('throws DeckGenerationError(empty) on empty array', async () => {
    await expect(
      regenerateCard({
        client: stubProvider('[]'),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        originalCard: original,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'empty'});
  });

  it('throws DeckGenerationError(empty) on invalid card shape', async () => {
    await expect(
      regenerateCard({
        client: stubProvider(JSON.stringify([{garbage: true}])),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        originalCard: original,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'empty'});
  });
});
