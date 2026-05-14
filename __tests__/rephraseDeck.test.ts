/**
 * Tests for src/grill/rephraseDeck. Pins:
 *  - rephrased stems replace originals; missing rows fall back silently
 *  - choices are reshuffled (correct ANSWER preserved)
 *  - malformed rows skipped without poisoning the rest
 *  - provider failure → DeckGenerationError(provider)
 *  - parse failure → DeckGenerationError(parse)
 */
import {
  rephraseDeck,
  REPHRASE_SYSTEM_PROMPT,
} from '../src/grill/rephraseDeck';
import {
  Card,
  Deck,
  DeckGenerationError,
  REPHRASE_MAX_TOKENS,
} from '../src/grill/deckTypes';
import type {
  ProviderClient,
  ProviderRequest,
} from '../src/providers/ProviderClient';

const card = (id: string, stem = 'original?', correctIndex: 0 | 1 | 2 | 3 = 2): Card => ({
  id,
  type: 'definition',
  stem,
  choices: ['A', 'B', 'C', 'D'] as const,
  correctIndex,
  explanation: 'because',
  sourceQuote: 'q',
});

const deck = (cards: Card[]): Deck => ({
  id: 'deck-1',
  createdAt: 0,
  notePath: '/foo.pdf',
  page: 1,
  cards,
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

describe('rephraseDeck', () => {
  it('replaces stems by cardId and preserves the correct ANSWER through shuffle', async () => {
    const d = deck([card('c1', 'old1', 2), card('c2', 'old2', 0)]);
    const body = JSON.stringify([
      {cardId: 'c1', stem: 'new1?'},
      {cardId: 'c2', stem: 'new2?'},
    ]);
    // Force a deterministic shuffle so the test can pin the answer
    // text rather than the index.
    const result = await rephraseDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      deck: d,
      signal: new AbortController().signal,
      rng: () => 0,
    });
    expect(result.cards[0].stem).toBe('new1?');
    expect(result.cards[1].stem).toBe('new2?');
    // Correct ANSWER preserved (text), even though index may have moved.
    expect(result.cards[0].choices[result.cards[0].correctIndex]).toBe('C');
    expect(result.cards[1].choices[result.cards[1].correctIndex]).toBe('A');
  });

  it('silently keeps the original stem when the model omits a cardId', async () => {
    const d = deck([card('c1', 'keep'), card('c2', 'rephrase-me')]);
    const body = JSON.stringify([{cardId: 'c2', stem: 'new2'}]);
    const result = await rephraseDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      deck: d,
      signal: new AbortController().signal,
      rng: () => 0,
    });
    expect(result.cards[0].stem).toBe('keep');
    expect(result.cards[1].stem).toBe('new2');
  });

  it('still reshuffles choices on every pass (even cards whose stem stayed)', async () => {
    const d = deck([card('c1', 'unchanged', 0)]);
    // Empty response — no rephrases provided.
    const result = await rephraseDeck({
      client: stubProvider('[]'),
      apiKey: 'sk',
      model: 'm',
      deck: d,
      signal: new AbortController().signal,
      rng: () => 0,
    });
    // The correct ANSWER ('A') still points at the same text, but
    // the position may differ from the original index (0).
    expect(result.cards[0].choices[result.cards[0].correctIndex]).toBe('A');
  });

  it('drops malformed rephrase rows without losing the rest', async () => {
    const d = deck([card('c1', 'old1'), card('c2', 'old2')]);
    const body = JSON.stringify([
      {cardId: 'c1', stem: 'new1'},
      {cardId: 42, stem: 'bad'},
      {cardId: 'c2', stem: ''},
    ]);
    const result = await rephraseDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      deck: d,
      signal: new AbortController().signal,
      rng: () => 0,
    });
    expect(result.cards[0].stem).toBe('new1');
    expect(result.cards[1].stem).toBe('old2');
  });

  it('drops null rows defensively', async () => {
    const d = deck([card('c1', 'old1')]);
    const body = JSON.stringify([null, {cardId: 'c1', stem: 'new1'}]);
    const result = await rephraseDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      deck: d,
      signal: new AbortController().signal,
      rng: () => 0,
    });
    expect(result.cards[0].stem).toBe('new1');
  });

  it('uses defaultRng when rng is omitted (smoke check)', async () => {
    const d = deck([card('c1', 'old1', 0)]);
    const result = await rephraseDeck({
      client: stubProvider('[]'),
      apiKey: 'sk',
      model: 'm',
      deck: d,
      signal: new AbortController().signal,
    });
    expect(result.cards[0].choices[result.cards[0].correctIndex]).toBe('A');
  });

  it('sends the rephrase system prompt + cards block, no image', async () => {
    let captured: ProviderRequest | undefined;
    const d = deck([card('c1', 'OLD STEM HERE')]);
    await rephraseDeck({
      client: stubProvider('[]', (req) => {
        captured = req;
      }),
      apiKey: 'sk',
      model: 'm',
      deck: d,
      signal: new AbortController().signal,
    });
    expect(captured?.systemPrompt).toBe(REPHRASE_SYSTEM_PROMPT);
    expect(captured?.userText).toContain('OLD STEM HERE');
    expect(captured?.imageBase64).toBeUndefined();
    expect(captured?.maxTokens).toBe(REPHRASE_MAX_TOKENS);
  });

  it('wraps provider rejection as DeckGenerationError(provider)', async () => {
    await expect(
      rephraseDeck({
        client: rejectProvider(new Error('boom')),
        apiKey: 'sk',
        model: 'm',
        deck: deck([card('c1')]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'provider'});
  });

  it('wraps non-Error rejection', async () => {
    await expect(
      rephraseDeck({
        client: rejectProvider('weird'),
        apiKey: 'sk',
        model: 'm',
        deck: deck([card('c1')]),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DeckGenerationError);
  });

  it('throws DeckGenerationError(parse) on bad JSON', async () => {
    await expect(
      rephraseDeck({
        client: stubProvider('not json'),
        apiKey: 'sk',
        model: 'm',
        deck: deck([card('c1')]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'parse'});
  });
});
