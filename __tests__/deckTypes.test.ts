/**
 * Tests for src/grill/deckTypes. Pure-data module — these tests are
 * the contract for every other grill module:
 *   - Card / Deck / RubricScores shape
 *   - parseStrictJsonArray handles fences, prose preamble, malformed
 *   - validateCard rejects every wrong shape we've seen LLMs emit
 *   - shuffleChoices preserves the correct answer text + remaps index
 *   - shouldRegenerate respects the rubric thresholds
 */
import {
  Card,
  CardChoiceIndex,
  DECK_SIZE,
  DISTRACTOR_REGEN_THRESHOLD,
  DeckGenerationError,
  FACTUAL_REGEN_THRESHOLD,
  QUESTION_TYPES,
  RUBRIC_MAX,
  RUBRIC_MIN,
  defaultRng,
  parseStrictJsonArray,
  shouldRegenerate,
  shuffleChoices,
  validateCard,
  validateCards,
  validateRubricRow,
} from '../src/grill/deckTypes';

const goodCardObj = (id = 'c1') => ({
  id,
  type: 'definition',
  stem: 'What is photosynthesis?',
  choices: [
    'Conversion of light to chemical energy by plants',
    'A type of cellular respiration in animals',
    'The process of plants absorbing water through roots only',
    'The chemical breakdown of sugars in mitochondria',
  ],
  correctIndex: 0,
  explanation: 'Plants convert light energy to glucose via chlorophyll.',
  sourceQuote: 'Photosynthesis is the conversion of light energy.',
});

describe('deckTypes — constants', () => {
  it('DECK_SIZE matches the locked product decision (5 cards)', () => {
    expect(DECK_SIZE).toBe(5);
  });

  it('rubric bounds are 0..5', () => {
    expect(RUBRIC_MIN).toBe(0);
    expect(RUBRIC_MAX).toBe(5);
  });

  it('QUESTION_TYPES covers the four moat-relevant variants', () => {
    expect(QUESTION_TYPES).toEqual([
      'cloze',
      'definition',
      'inference',
      'application',
    ]);
  });
});

describe('deckTypes — parseStrictJsonArray', () => {
  it('parses a bare JSON array', () => {
    expect(parseStrictJsonArray('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    const wrapped = '```json\n[{"a":1}]\n```';
    expect(parseStrictJsonArray(wrapped)).toEqual([{a: 1}]);
  });

  it('strips bare ``` fences', () => {
    expect(parseStrictJsonArray('```\n[true,false]\n```')).toEqual([
      true,
      false,
    ]);
  });

  it('extracts the array out of a prose preamble', () => {
    const noisy = 'Sure! Here is the deck:\n\n[{"x":1},{"x":2}]\n\nEnjoy.';
    expect(parseStrictJsonArray(noisy)).toEqual([{x: 1}, {x: 2}]);
  });

  it('handles brackets inside strings without breaking depth tracking', () => {
    const tricky = '[{"s":"a [bracket] inside"}, {"s":"more]"}]';
    expect(parseStrictJsonArray(tricky)).toEqual([
      {s: 'a [bracket] inside'},
      {s: 'more]'},
    ]);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseStrictJsonArray('[1, 2,]')).toThrow(/JSON parse failed/);
  });

  it('throws when top-level is not an array', () => {
    expect(() => parseStrictJsonArray('{"a":1}')).toThrow(/JSON array/);
  });

  it('throws when no array is present at all', () => {
    expect(() => parseStrictJsonArray('hello there')).toThrow(
      /JSON parse failed/,
    );
  });

  it('handles strings with escaped quotes', () => {
    const escaped = '[{"s":"a \\"quoted\\" word"}]';
    expect(parseStrictJsonArray(escaped)).toEqual([{s: 'a "quoted" word'}]);
  });

  it('recovers a JSON array from a malformed inline fence', () => {
    // No newline after the fence → fence-strip is a no-op, but the
    // bracket-scanner still finds the balanced [1] inside the noise.
    expect(parseStrictJsonArray('```[1]```')).toEqual([1]);
  });

  it('handles fence with no closing fence: parses the post-newline body', () => {
    expect(parseStrictJsonArray('```json\n[42]')).toEqual([42]);
  });

  it('falls back to direct JSON.parse when an open bracket has no matching close', () => {
    // The bracket-scanner returns null when balance never reaches 0,
    // so the caller falls back to JSON.parse on the unfenced text,
    // which then surfaces a clear parse error rather than silently
    // succeeding.
    expect(() => parseStrictJsonArray('[1, 2, 3')).toThrow(/JSON/);
  });
});

describe('deckTypes — validateCard', () => {
  it('accepts a fully-formed card', () => {
    const r = validateCard(goodCardObj(), 'fallback');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('c1');
      expect(r.value.choices).toHaveLength(4);
      expect(r.value.correctIndex).toBe(0);
    }
  });

  it('falls back to the supplied id when card.id is missing', () => {
    const raw = {...goodCardObj()} as Record<string, unknown>;
    delete raw.id;
    const r = validateCard(raw, 'fallback-id');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('fallback-id');
    }
  });

  it('rejects non-object input', () => {
    expect(validateCard(null, 'x').ok).toBe(false);
    expect(validateCard('string', 'x').ok).toBe(false);
    expect(validateCard(42, 'x').ok).toBe(false);
  });

  it('rejects unknown question types', () => {
    const raw = {...goodCardObj(), type: 'multi-select'};
    const r = validateCard(raw, 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/invalid type/);
    }
  });

  it('rejects empty stem', () => {
    const r = validateCard({...goodCardObj(), stem: ''}, 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/stem/);
    }
  });

  it('rejects missing stem (non-string)', () => {
    const raw = {...goodCardObj()} as Record<string, unknown>;
    delete raw.stem;
    const r = validateCard(raw, 'x');
    expect(r.ok).toBe(false);
  });

  it('rejects choices with wrong length', () => {
    const r3 = validateCard(
      {...goodCardObj(), choices: ['a', 'b', 'c']},
      'x',
    );
    expect(r3.ok).toBe(false);

    const r5 = validateCard(
      {...goodCardObj(), choices: ['a', 'b', 'c', 'd', 'e']},
      'x',
    );
    expect(r5.ok).toBe(false);
  });

  it('rejects empty choice strings', () => {
    const r = validateCard(
      {...goodCardObj(), choices: ['a', '', 'c', 'd']},
      'x',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/choice 1/);
    }
  });

  it('rejects non-string choices', () => {
    const r = validateCard(
      {...goodCardObj(), choices: ['a', 'b', 3, 'd']},
      'x',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects correctIndex out of 0..3', () => {
    expect(validateCard({...goodCardObj(), correctIndex: -1}, 'x').ok).toBe(
      false,
    );
    expect(validateCard({...goodCardObj(), correctIndex: 4}, 'x').ok).toBe(
      false,
    );
    expect(
      validateCard({...goodCardObj(), correctIndex: '0' as unknown}, 'x').ok,
    ).toBe(false);
  });

  it('rejects missing explanation', () => {
    const raw = {...goodCardObj()} as Record<string, unknown>;
    delete raw.explanation;
    expect(validateCard(raw, 'x').ok).toBe(false);
  });

  it('allows empty sourceQuote (pages with no extracted text)', () => {
    const r = validateCard({...goodCardObj(), sourceQuote: ''}, 'x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sourceQuote).toBe('');
    }
  });

  it('coerces a missing sourceQuote to empty string', () => {
    const raw = {...goodCardObj()} as Record<string, unknown>;
    delete raw.sourceQuote;
    const r = validateCard(raw, 'x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sourceQuote).toBe('');
    }
  });

  it('coerces non-string sourceQuote (e.g. null) to empty string', () => {
    const r = validateCard(
      {...goodCardObj(), sourceQuote: null as unknown},
      'x',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sourceQuote).toBe('');
    }
  });
});

describe('deckTypes — validateCards (batch)', () => {
  it('returns the good cards and collects errors for the bad ones', () => {
    const raw = [goodCardObj('a'), {bad: true}, goodCardObj('b')];
    const {cards, errors} = validateCards(raw);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
    expect(errors).toHaveLength(1);
  });

  it('synthesises card-<i> ids for fallback when id missing', () => {
    const raw = [{...goodCardObj(), id: undefined}];
    const {cards} = validateCards(raw);
    expect(cards[0].id).toBe('card-1');
  });

  it('handles an all-bad batch (returns empty cards, all errors)', () => {
    const {cards, errors} = validateCards([null, 'bad', 42]);
    expect(cards).toEqual([]);
    expect(errors).toHaveLength(3);
  });
});

describe('deckTypes — validateRubricRow', () => {
  const good = () => ({
    cardId: 'c1',
    factual: 5,
    clarity: 4,
    distractor: 3,
    typeCoverage: 5,
  });

  it('accepts a fully-formed rubric row', () => {
    const r = validateRubricRow(good());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cardId).toBe('c1');
      expect(r.value.scores.factual).toBe(5);
    }
  });

  it('rejects non-object', () => {
    expect(validateRubricRow(null).ok).toBe(false);
    expect(validateRubricRow('row').ok).toBe(false);
  });

  it('rejects missing cardId', () => {
    const raw = {...good()} as Record<string, unknown>;
    delete raw.cardId;
    expect(validateRubricRow(raw).ok).toBe(false);
  });

  it('rejects out-of-range axis (< 0)', () => {
    expect(validateRubricRow({...good(), factual: -1}).ok).toBe(false);
  });

  it('rejects out-of-range axis (> 5)', () => {
    expect(validateRubricRow({...good(), clarity: 6}).ok).toBe(false);
  });

  it('rejects NaN axis', () => {
    expect(validateRubricRow({...good(), distractor: NaN}).ok).toBe(false);
  });

  it('rejects non-number axis', () => {
    expect(
      validateRubricRow({...good(), typeCoverage: 'good' as unknown}).ok,
    ).toBe(false);
  });
});

describe('deckTypes — shouldRegenerate', () => {
  const base = {factual: 5, clarity: 5, distractor: 5, typeCoverage: 5};

  it('keeps cards above thresholds', () => {
    expect(shouldRegenerate(base)).toBe(false);
  });

  it(`flags factual < ${FACTUAL_REGEN_THRESHOLD}`, () => {
    expect(
      shouldRegenerate({...base, factual: FACTUAL_REGEN_THRESHOLD - 1}),
    ).toBe(true);
  });

  it(`keeps factual === ${FACTUAL_REGEN_THRESHOLD} (threshold is strict <)`, () => {
    expect(
      shouldRegenerate({...base, factual: FACTUAL_REGEN_THRESHOLD}),
    ).toBe(false);
  });

  it(`flags distractor < ${DISTRACTOR_REGEN_THRESHOLD}`, () => {
    expect(
      shouldRegenerate({
        ...base,
        distractor: DISTRACTOR_REGEN_THRESHOLD - 1,
      }),
    ).toBe(true);
  });

  it('clarity and typeCoverage do NOT gate regeneration (they only inform UI later)', () => {
    expect(
      shouldRegenerate({...base, clarity: 0, typeCoverage: 0}),
    ).toBe(false);
  });
});

describe('deckTypes — shuffleChoices', () => {
  const card: Card = {
    id: 'c1',
    type: 'definition',
    stem: 'pick the right one',
    choices: ['A', 'B', 'C', 'D'] as const,
    correctIndex: 2,
    explanation: 'because',
    sourceQuote: '',
  };

  it('preserves the correct ANSWER even when its index moves', () => {
    // Deterministic RNG: always returns 0 → Fisher-Yates with j=0
    // produces a specific permutation. We don't care what permutation
    // — we care that correctIndex points at "C" wherever it is.
    const seqRng = (): number => 0;
    const shuffled = shuffleChoices(card, seqRng);
    expect(shuffled.choices[shuffled.correctIndex]).toBe('C');
  });

  it('still returns 4 choices', () => {
    const shuffled = shuffleChoices(card);
    expect(shuffled.choices).toHaveLength(4);
  });

  it('does not mutate the original card', () => {
    const before = JSON.stringify(card);
    shuffleChoices(card, () => 0.1234);
    expect(JSON.stringify(card)).toBe(before);
  });

  it('handles every correctIndex 0..3 reliably', () => {
    for (const idx of [0, 1, 2, 3] as CardChoiceIndex[]) {
      const c: Card = {...card, correctIndex: idx};
      const shuffled = shuffleChoices(c, () => 0.5);
      expect(shuffled.choices[shuffled.correctIndex]).toBe(
        card.choices[idx],
      );
    }
  });

  it('uses defaultRng when no rng is supplied (smoke check)', () => {
    // Just exercise the default path — value is non-deterministic so
    // we only assert the invariant.
    const shuffled = shuffleChoices(card);
    expect(shuffled.choices[shuffled.correctIndex]).toBe('C');
  });

  it('defaultRng returns a number in [0, 1)', () => {
    for (let i = 0; i < 10; i++) {
      const v = defaultRng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('deckTypes — DeckGenerationError', () => {
  it('carries a kind discriminator', () => {
    const e = new DeckGenerationError('parse', 'oops');
    expect(e.kind).toBe('parse');
    expect(e.name).toBe('DeckGenerationError');
    expect(e.message).toBe('oops');
  });

  it('is an instance of Error', () => {
    expect(new DeckGenerationError('empty', 'no cards')).toBeInstanceOf(Error);
  });
});
