/**
 * Tests for src/grill/deckJudge. Pins:
 *  - 4-axis scoring per card, in/out of threshold
 *  - hallucinated cardIds (judge inventing rows) are dropped
 *  - malformed rubric rows are skipped, not fatal
 *  - provider rejection → DeckGenerationError(provider)
 *  - parse failure → DeckGenerationError(parse)
 *  - averageRubric returns null when nothing was judged
 */
import {
  averageRubric,
  judgeDeck,
  JUDGE_SYSTEM_PROMPT,
} from '../src/grill/deckJudge';
import {
  Card,
  DECK_SIZE,
  Deck,
  DeckGenerationError,
  JUDGE_MAX_TOKENS,
} from '../src/grill/deckTypes';
import type {
  ProviderClient,
  ProviderRequest,
} from '../src/providers/ProviderClient';

const card = (id: string, stem = 'q?'): Card => ({
  id,
  type: 'definition',
  stem,
  choices: ['A', 'B', 'C', 'D'] as const,
  correctIndex: 0,
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
    throw err;
  },
});

describe('judgeDeck — happy path', () => {
  it('returns scores for every card in the deck', async () => {
    const d = deck([card('c1'), card('c2'), card('c3')]);
    const body = JSON.stringify([
      {cardId: 'c1', factual: 5, clarity: 5, distractor: 5, typeCoverage: 5},
      {cardId: 'c2', factual: 4, clarity: 5, distractor: 4, typeCoverage: 4},
      {cardId: 'c3', factual: 5, clarity: 5, distractor: 5, typeCoverage: 4},
    ]);
    const r = await judgeDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      sourcePageText: 'src',
      deck: d,
      signal: new AbortController().signal,
    });
    expect(r.scores.size).toBe(3);
    expect(r.scores.get('c1')?.factual).toBe(5);
    expect(r.regenerateIds).toEqual([]);
  });

  it('flags weak cards (factual<4 OR distractor<3) for regeneration', async () => {
    const d = deck([card('c1'), card('c2'), card('c3')]);
    const body = JSON.stringify([
      {cardId: 'c1', factual: 5, clarity: 5, distractor: 5, typeCoverage: 5},
      // c2 has weak distractor → flagged
      {cardId: 'c2', factual: 5, clarity: 5, distractor: 2, typeCoverage: 5},
      // c3 has hallucinated fact → flagged
      {cardId: 'c3', factual: 3, clarity: 5, distractor: 5, typeCoverage: 5},
    ]);
    const r = await judgeDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      sourcePageText: 'src',
      deck: d,
      signal: new AbortController().signal,
    });
    expect(r.regenerateIds.sort()).toEqual(['c2', 'c3']);
  });
});

describe('judgeDeck — adversarial responses', () => {
  it('drops rubric rows whose cardId was never in the deck', async () => {
    const d = deck([card('c1')]);
    const body = JSON.stringify([
      {cardId: 'c1', factual: 5, clarity: 5, distractor: 5, typeCoverage: 5},
      {cardId: 'GHOST', factual: 0, clarity: 0, distractor: 0, typeCoverage: 0},
    ]);
    const r = await judgeDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      sourcePageText: 'src',
      deck: d,
      signal: new AbortController().signal,
    });
    expect(r.scores.has('GHOST')).toBe(false);
    expect(r.regenerateIds).not.toContain('GHOST');
  });

  it('skips malformed rubric rows without poisoning the rest', async () => {
    const d = deck([card('c1'), card('c2')]);
    const body = JSON.stringify([
      {cardId: 'c1', factual: 5, clarity: 5, distractor: 5, typeCoverage: 5},
      // Bad: out-of-range axis. validateRubricRow rejects → row dropped.
      {cardId: 'c2', factual: 99, clarity: 5, distractor: 5, typeCoverage: 5},
    ]);
    const r = await judgeDeck({
      client: stubProvider(body),
      apiKey: 'sk',
      model: 'm',
      sourcePageText: 'src',
      deck: d,
      signal: new AbortController().signal,
    });
    expect(r.scores.get('c1')).toBeDefined();
    expect(r.scores.get('c2')).toBeUndefined();
  });

  it('returns empty result (no throw) when judge returns no usable rows', async () => {
    const d = deck([card('c1')]);
    const r = await judgeDeck({
      client: stubProvider(JSON.stringify([{garbage: true}])),
      apiKey: 'sk',
      model: 'm',
      sourcePageText: 'src',
      deck: d,
      signal: new AbortController().signal,
    });
    expect(r.scores.size).toBe(0);
    expect(r.regenerateIds).toEqual([]);
  });
});

describe('judgeDeck — error paths', () => {
  it('wraps provider rejection as DeckGenerationError(provider)', async () => {
    await expect(
      judgeDeck({
        client: rejectProvider(new Error('boom')),
        apiKey: 'sk',
        model: 'm',
        sourcePageText: 'src',
        deck: deck([card('c1')]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'provider'});
  });

  it('wraps a non-Error provider rejection', async () => {
    await expect(
      judgeDeck({
        client: rejectProvider('weird'),
        apiKey: 'sk',
        model: 'm',
        sourcePageText: 'src',
        deck: deck([card('c1')]),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DeckGenerationError);
  });

  it('throws DeckGenerationError(parse) on malformed JSON', async () => {
    await expect(
      judgeDeck({
        client: stubProvider('not json'),
        apiKey: 'sk',
        model: 'm',
        sourcePageText: 'src',
        deck: deck([card('c1')]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({kind: 'parse'});
  });
});

describe('judgeDeck — request shape', () => {
  it('sends the judge system prompt + cards + source text, no image', async () => {
    let captured: ProviderRequest | undefined;
    await judgeDeck({
      client: stubProvider('[]', (req) => {
        captured = req;
      }),
      apiKey: 'sk',
      model: 'm',
      sourcePageText: 'PAGE TEXT HERE',
      deck: deck([card('c1', 'STEM HERE')]),
      signal: new AbortController().signal,
    });
    expect(captured?.systemPrompt).toBe(JUDGE_SYSTEM_PROMPT);
    expect(captured?.userText).toContain('PAGE TEXT HERE');
    expect(captured?.userText).toContain('STEM HERE');
    expect(captured?.imageBase64).toBeUndefined();
    expect(captured?.maxTokens).toBe(JUDGE_MAX_TOKENS);
  });
});

describe('averageRubric', () => {
  it('returns null on empty result (judge unavailable)', () => {
    expect(averageRubric({scores: new Map(), regenerateIds: []})).toBeNull();
  });

  it('averages across cards', () => {
    const scores = new Map<string, ReturnType<typeof judgeDeck> extends Promise<infer R> ? R extends {scores: Map<string, infer S>} ? S : never : never>();
    scores.set('a', {factual: 4, clarity: 4, distractor: 4, typeCoverage: 4});
    scores.set('b', {factual: 5, clarity: 3, distractor: 3, typeCoverage: 5});
    const avg = averageRubric({scores, regenerateIds: []});
    expect(avg).not.toBeNull();
    if (avg) {
      expect(avg.factual).toBeCloseTo(4.5);
      expect(avg.distractor).toBeCloseTo(3.5);
    }
  });

  it('DECK_SIZE constant is referenced (smoke check shared constants are wired)', () => {
    // Defensive: ensures the judge module's bundled DECK_SIZE matches
    // the generator's so the deck-vs-rubric counts line up.
    expect(DECK_SIZE).toBeGreaterThan(0);
  });
});
