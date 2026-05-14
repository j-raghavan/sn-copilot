/**
 * Tests for src/grill/deckGenerator. Provider is injected as a stub
 * so we control the response text exactly (canned JSON, malformed
 * JSON, partial validation failures, network rejection, abort).
 */
import {generateDeck, GRILL_SYSTEM_PROMPT} from '../src/grill/deckGenerator';
import {
  DECK_SIZE,
  DeckGenerationError,
  GENERATE_MAX_TOKENS,
} from '../src/grill/deckTypes';
import type {
  ProviderClient,
  ProviderRequest,
} from '../src/providers/ProviderClient';
import type {PageContext} from '../src/scope/pageContext';

const PAGE: PageContext = {
  notePath: '/storage/emulated/0/Documents/book.pdf',
  page: 4,
  screenshotPath: '/tmp/page-4.png',
  screenshotBase64: 'BASE64DATA',
  pageText: 'Photosynthesis is the conversion of light energy.',
};

const goodCard = (i: number) => ({
  id: `m-${i}`,
  type: 'definition',
  stem: `Stem ${i}?`,
  choices: ['A', 'B', 'C', 'D'],
  correctIndex: 0,
  explanation: 'because',
  sourceQuote: 'q',
});

const stubProvider = (
  text: string,
  observe?: (req: ProviderRequest, opts: {apiKey: string; model: string}) => void,
): ProviderClient => ({
  id: 'fake',
  async send(req, opts) {
    if (observe) {
      observe(req, opts);
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
    // Deliberately re-throw the raw value (NOT wrapped in Error) so
    // the generator's `e instanceof Error ? e.message : String(e)`
    // branch is exercised for both arms.
    throw err;
  },
});

describe('generateDeck — happy path', () => {
  it('returns a deck with the requested cards, namespaced ids, and metadata', async () => {
    const body = JSON.stringify([goodCard(1), goodCard(2), goodCard(3)]);
    const deck = await generateDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm1',
      pageContext: PAGE,
      signal: new AbortController().signal,
      count: 3,
      now: () => 1700000000000,
    });
    expect(deck.cards).toHaveLength(3);
    expect(deck.cards[0].id).toMatch(/^deck-.*-c1$/);
    expect(deck.cards[1].id).toMatch(/^deck-.*-c2$/);
    expect(deck.notePath).toBe(PAGE.notePath);
    expect(deck.page).toBe(PAGE.page);
    expect(deck.createdAt).toBe(1700000000000);
    expect(deck.id).toMatch(/^deck-/);
  });

  it('falls back to DECK_SIZE when count is omitted', async () => {
    const cards = [];
    for (let i = 1; i <= DECK_SIZE; i++) {
      cards.push(goodCard(i));
    }
    const deck = await generateDeck({
      client: stubProvider(JSON.stringify(cards)),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
    });
    expect(deck.cards).toHaveLength(DECK_SIZE);
  });

  it('honours deckIdOverride for deterministic ids', async () => {
    const body = JSON.stringify([goodCard(1)]);
    const deck = await generateDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
      deckIdOverride: 'deck-test-fixed',
    });
    expect(deck.id).toBe('deck-test-fixed');
    expect(deck.cards[0].id).toBe('deck-test-fixed-c1');
  });

  it('strips markdown fences from the response', async () => {
    const body = '```json\n' + JSON.stringify([goodCard(1)]) + '\n```';
    const deck = await generateDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
    });
    expect(deck.cards).toHaveLength(1);
  });
});

describe('generateDeck — provider invocation', () => {
  it('sends the system prompt + composed user text + image (vision)', async () => {
    let captured: ProviderRequest | undefined;
    const body = JSON.stringify([goodCard(1)]);
    await generateDeck({
      client: stubProvider(body, (req) => {
        captured = req;
      }),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
    });
    expect(captured?.systemPrompt).toBe(GRILL_SYSTEM_PROMPT);
    expect(captured?.userText).toContain('Generate exactly 5 drill cards');
    expect(captured?.userText).toContain('Photosynthesis');
    expect(captured?.imageBase64).toBe(PAGE.screenshotBase64);
    expect(captured?.maxTokens).toBe(GENERATE_MAX_TOKENS);
  });

  it('omits the image when attachImage is false (DeepSeek path)', async () => {
    let captured: ProviderRequest | undefined;
    const body = JSON.stringify([goodCard(1)]);
    await generateDeck({
      client: stubProvider(body, (req) => {
        captured = req;
      }),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
      attachImage: false,
    });
    expect(captured?.imageBase64).toBeUndefined();
  });

  it('passes the caller-provided AbortSignal verbatim', async () => {
    let captured: ProviderRequest | undefined;
    const ctl = new AbortController();
    await generateDeck({
      client: stubProvider(JSON.stringify([goodCard(1)]), (req) => {
        captured = req;
      }),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: ctl.signal,
    });
    expect(captured?.signal).toBe(ctl.signal);
  });

  it('asks for the requested count in the user text', async () => {
    let captured: ProviderRequest | undefined;
    await generateDeck({
      client: stubProvider(JSON.stringify([goodCard(1)]), (req) => {
        captured = req;
      }),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
      count: 3,
    });
    expect(captured?.userText).toContain('Generate exactly 3 drill cards');
  });
});

describe('generateDeck — error paths', () => {
  it('wraps a provider rejection as DeckGenerationError(provider)', async () => {
    await expect(
      generateDeck({
        client: rejectProvider(new Error('anthropic: HTTP 500')),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: 'DeckGenerationError',
      kind: 'provider',
    });
  });

  it('wraps a non-Error rejection as DeckGenerationError(provider)', async () => {
    await expect(
      generateDeck({
        client: rejectProvider('weird-string-throw'),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DeckGenerationError);
  });

  it('throws DeckGenerationError(parse) on malformed JSON', async () => {
    await expect(
      generateDeck({
        client: stubProvider('this is not json at all'),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'parse'});
  });

  it('throws DeckGenerationError(empty) when every card fails validation', async () => {
    const badBatch = JSON.stringify([{not: 'a card'}, {also: 'not'}]);
    await expect(
      generateDeck({
        client: stubProvider(badBatch),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'empty'});
  });

  it('keeps valid cards when SOME cards in the batch are malformed', async () => {
    const mixed = JSON.stringify([goodCard(1), {garbage: true}, goodCard(2)]);
    const deck = await generateDeck({
      client: stubProvider(mixed),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
    });
    expect(deck.cards).toHaveLength(2);
  });
});

describe('generateDeck — id minting', () => {
  it('mints unique deck ids across back-to-back calls', async () => {
    const body = JSON.stringify([goodCard(1)]);
    const deck1 = await generateDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
    });
    const deck2 = await generateDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      pageContext: PAGE,
      signal: new AbortController().signal,
    });
    // Same ms timestamp possible; the random suffix should split them
    // ~65k times out of 65k attempts. Loop a few to dodge a 1-in-65k
    // flake but not endlessly.
    if (deck1.id === deck2.id) {
      const deck3 = await generateDeck({
        client: stubProvider(body),
        apiKey: 'sk',
        model: 'm',
        pageContext: PAGE,
        signal: new AbortController().signal,
      });
      expect(new Set([deck1.id, deck2.id, deck3.id]).size).toBeGreaterThan(1);
    } else {
      expect(deck1.id).not.toBe(deck2.id);
    }
  });
});
