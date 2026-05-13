// Shared types, constants, validators, and the JSON extractor for the
// "Grill Me" flow. Every other module under src/grill/ depends only
// on this file (no provider-specific knowledge, no React Native
// imports) so it stays trivially testable on Hermes and Node alike.
//
// Design choices:
//   - `Card.choices` is a 4-tuple. The four-distractor rubric is a
//     hard contract; modelling it as a tuple lets TypeScript catch
//     drift at compile time instead of at runtime in the LLM-judge.
//   - `correctIndex` is a 0-3 union for the same reason.
//   - All "random" behaviour is parameterised on an injected Rng so
//     tests are deterministic AND we sidestep the Hermes
//     crypto.getRandomValues absence. Math.random IS available on
//     Hermes — the absence is only of crypto.getRandomValues. Math.
//     random's bias is irrelevant for shuffling 4 choices.

export type CardChoiceIndex = 0 | 1 | 2 | 3;

// Question types we ask the model to mix. The user's source quote
// specifically called out that "all cloze" / "all definition recall"
// is a coverage failure that caps quality in the mid-60s.
export type QuestionType =
  | 'cloze'
  | 'definition'
  | 'inference'
  | 'application';

export const QUESTION_TYPES: readonly QuestionType[] = [
  'cloze',
  'definition',
  'inference',
  'application',
] as const;

export type Card = {
  id: string;
  type: QuestionType;
  stem: string;
  choices: readonly [string, string, string, string];
  correctIndex: CardChoiceIndex;
  // Why the correct answer is correct. Surfaced after the user
  // answers; helps the encode step the moat is really about.
  explanation: string;
  // The verbatim snippet from page text this card was anchored to.
  // Lets us spot hallucinations and gives the user a "show source"
  // affordance.
  sourceQuote: string;
};

export type Deck = {
  id: string;
  createdAt: number;
  // The notePath + page the deck was generated from. Kept for
  // diagnostics and for a future "regenerate from same page" path.
  notePath: string;
  page: number;
  cards: Card[];
};

// One card scored on the 4 axes the user's source quote called out:
// factual correctness, clarity, distractor quality, type coverage.
// Each axis is 0..5 (inclusive). 0 means "broken", 5 means "publish".
export type RubricScores = {
  factual: number;
  clarity: number;
  distractor: number;
  typeCoverage: number;
};

export type JudgeResult = {
  // Card id -> scores. Cards the judge didn't return are simply
  // absent; callers should treat absence as "not evaluated yet".
  scores: Map<string, RubricScores>;
  // Card ids the judge thinks should be regenerated (silently, before
  // the user sees them, when possible). Derived from thresholds in
  // shouldRegenerate() — the judge model itself only returns scores.
  regenerateIds: string[];
};

// Fixed deck size. Chosen for a single Supernote screen of drill
// (5 cards × ~30s = ~2.5 minutes — short enough to retry, long
// enough to encode). Surface as a constant so tests can sanity-check
// the contract without hard-coding the number in three places.
export const DECK_SIZE = 5;

// Token budgets per call. Conservative — provider responses cluster
// well under these in practice but a dense EPUB page can be wordy.
export const GENERATE_MAX_TOKENS = 1800;
export const JUDGE_MAX_TOKENS = 1000;
export const REPHRASE_MAX_TOKENS = 1200;
export const REGENERATE_CARD_MAX_TOKENS = 500;

// Rubric scoring bounds + the threshold below which a card is
// flagged for silent regeneration. Pulled out as constants so the
// tuning is centralised and tests can pin the gate behaviour
// without grepping for magic numbers.
export const RUBRIC_MIN = 0;
export const RUBRIC_MAX = 5;
export const FACTUAL_REGEN_THRESHOLD = 4; // factual < 4 → regenerate
export const DISTRACTOR_REGEN_THRESHOLD = 3; // distractor < 3 → regenerate

// Card is weak enough that we want to swap it out, per the rubric.
// Used by deckJudge to populate regenerateIds and by DrillView's
// "Drill again" path to decide which card to fully replace vs just
// rephrase the stem of.
export const shouldRegenerate = (s: RubricScores): boolean =>
  s.factual < FACTUAL_REGEN_THRESHOLD ||
  s.distractor < DISTRACTOR_REGEN_THRESHOLD;

// Inject-able RNG so tests are deterministic. Default uses Math.random.
export type Rng = () => number;
export const defaultRng: Rng = () => Math.random();

// Fisher-Yates shuffle on a NEW array — original is not mutated.
// Pure aside from `rng`, which is itself injectable.
const shuffleArray = <T>(arr: readonly T[], rng: Rng): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
};

// Reshuffle a card's 4 choices while keeping the SAME correct answer
// (correctIndex is remapped to wherever the answer landed). Used by
// GrillView on every grill pass to defeat positional pattern-matching
// — users can't memorise "always tap C" across revisits.
//
// shuffleArray preserves every element, so the correct answer's text
// is always still in the array and indexOf is always 0..3. The cast
// reflects that invariant; if it ever broke, every test that pins
// "correctIndex still points at the right answer" would fail loudly.
export const shuffleChoices = (card: Card, rng: Rng = defaultRng): Card => {
  const correctText = card.choices[card.correctIndex];
  const shuffled = shuffleArray(card.choices, rng);
  return {
    ...card,
    choices: [shuffled[0], shuffled[1], shuffled[2], shuffled[3]] as const,
    correctIndex: shuffled.indexOf(correctText) as CardChoiceIndex,
  };
};

// --- JSON extraction ------------------------------------------------
//
// Providers don't all support native JSON-output mode (Anthropic and
// DeepSeek don't, as of writing) so generated decks come back as text
// that *contains* JSON. The model regularly wraps it in ```json …```
// fences or prepends a "Here's the deck:" line despite explicit
// instructions otherwise. parseStrictJsonArray is defensive against
// both common shapes WITHOUT being permissive about the JSON itself —
// a malformed inner structure must still fail loudly so the caller can
// retry / surface a clear error.

const stripCodeFences = (raw: string): string => {
  const trimmed = raw.trim();
  // Match ```json or just ``` at the start, and a closing ``` at the
  // end. Use a manual slice rather than a regex with /s so we don't
  // depend on dotAll being available on every Hermes target.
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) {
    return trimmed;
  }
  const bodyStart = firstNewline + 1;
  const lastFence = trimmed.lastIndexOf('```');
  // lastFence === 0 means the opening fence is also the only one →
  // no close found; treat as no fence (the JSON parser will fail
  // and surface a useful error to the caller).
  if (lastFence <= bodyStart) {
    return trimmed.slice(bodyStart);
  }
  return trimmed.slice(bodyStart, lastFence).trim();
};

// Locate the first top-level JSON array in the text. Used because
// models often prepend prose ("Here are the 5 questions:\n[…]")
// despite being told JSON only. Returns the bracketed substring or
// null if no balanced array is found.
const extractJsonArray = (raw: string): string | null => {
  const start = raw.indexOf('[');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
};

// Strict-ish parser. Strips a single code fence wrap, finds the first
// balanced JSON array, parses it, asserts it's an array. Any failure
// throws so callers can route to retry / user-visible error.
export const parseStrictJsonArray = (raw: string): unknown[] => {
  const unfenced = stripCodeFences(raw);
  const arrText = extractJsonArray(unfenced) ?? unfenced;
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrText);
  } catch (e) {
    throw new Error(`JSON parse failed: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array at the top level');
  }
  return parsed;
};

// --- Validators -----------------------------------------------------
//
// Hand-rolled rather than a runtime schema library — there's no zod /
// io-ts dep in this repo and we follow the same pattern as
// conversations.ts. validate* functions return a tagged result so
// callers can decide whether a single bad card kills the whole deck
// or just gets skipped.

export type ValidationResult<T> =
  | {ok: true; value: T}
  | {ok: false; reason: string};

const isStringOfMinLen = (v: unknown, min: number): v is string =>
  typeof v === 'string' && v.length >= min;

const isQuestionType = (v: unknown): v is QuestionType =>
  v === 'cloze' ||
  v === 'definition' ||
  v === 'inference' ||
  v === 'application';

const isChoiceIndex = (v: unknown): v is CardChoiceIndex =>
  v === 0 || v === 1 || v === 2 || v === 3;

export const validateCard = (
  raw: unknown,
  fallbackId: string,
): ValidationResult<Card> => {
  if (raw === null || typeof raw !== 'object') {
    return {ok: false, reason: 'card is not an object'};
  }
  const r = raw as Record<string, unknown>;
  const id = isStringOfMinLen(r.id, 1) ? r.id : fallbackId;
  if (!isQuestionType(r.type)) {
    return {ok: false, reason: `card ${id}: invalid type ${String(r.type)}`};
  }
  if (!isStringOfMinLen(r.stem, 1)) {
    return {ok: false, reason: `card ${id}: stem missing or empty`};
  }
  if (!Array.isArray(r.choices) || r.choices.length !== 4) {
    return {ok: false, reason: `card ${id}: choices must be array of 4`};
  }
  const choices = r.choices;
  for (let i = 0; i < 4; i++) {
    if (!isStringOfMinLen(choices[i], 1)) {
      return {
        ok: false,
        reason: `card ${id}: choice ${i} missing or empty`,
      };
    }
  }
  if (!isChoiceIndex(r.correctIndex)) {
    return {
      ok: false,
      reason: `card ${id}: correctIndex must be 0..3`,
    };
  }
  if (!isStringOfMinLen(r.explanation, 1)) {
    return {ok: false, reason: `card ${id}: explanation missing`};
  }
  // sourceQuote allowed to be empty — pages with no extracted text
  // legitimately can't anchor a quote. Type-check only.
  const sourceQuote =
    typeof r.sourceQuote === 'string' ? r.sourceQuote : '';
  return {
    ok: true,
    value: {
      id,
      type: r.type,
      stem: r.stem,
      choices: [
        choices[0] as string,
        choices[1] as string,
        choices[2] as string,
        choices[3] as string,
      ] as const,
      correctIndex: r.correctIndex,
      explanation: r.explanation,
      sourceQuote,
    },
  };
};

// Validate a full array of cards. Drops invalid ones but reports
// them in `errors` so the caller can decide whether to fail the
// whole deck or proceed with what we got. We don't fail-fast on the
// first bad card — losing a card to a regex glitch shouldn't kill
// the deck.
export const validateCards = (
  raw: unknown[],
): {cards: Card[]; errors: string[]} => {
  const cards: Card[] = [];
  const errors: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = validateCard(raw[i], `card-${i + 1}`);
    if (r.ok) {
      cards.push(r.value);
    } else {
      errors.push(r.reason);
    }
  }
  return {cards, errors};
};

// Rubric validator: each axis must be a number in [RUBRIC_MIN,
// RUBRIC_MAX]. Out-of-range or non-number → reject the whole row;
// the judge's response loses one card, not the whole judge pass.
const isRubricNumber = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  v >= RUBRIC_MIN &&
  v <= RUBRIC_MAX;

export const validateRubricRow = (
  raw: unknown,
): ValidationResult<{cardId: string; scores: RubricScores}> => {
  if (raw === null || typeof raw !== 'object') {
    return {ok: false, reason: 'rubric row is not an object'};
  }
  const r = raw as Record<string, unknown>;
  if (!isStringOfMinLen(r.cardId, 1)) {
    return {ok: false, reason: 'rubric row missing cardId'};
  }
  if (
    !isRubricNumber(r.factual) ||
    !isRubricNumber(r.clarity) ||
    !isRubricNumber(r.distractor) ||
    !isRubricNumber(r.typeCoverage)
  ) {
    return {
      ok: false,
      reason: `rubric ${r.cardId}: missing or out-of-range axis`,
    };
  }
  return {
    ok: true,
    value: {
      cardId: r.cardId,
      scores: {
        factual: r.factual,
        clarity: r.clarity,
        distractor: r.distractor,
        typeCoverage: r.typeCoverage,
      },
    },
  };
};

// One row from a rephrase response. Shared between the rephrase
// pipeline and (potentially) any future UI that previews rephrased
// stems. Kept here next to validateCard / validateRubricRow so all
// LLM-response shapes live in one place.
export type RephraseRow = {cardId: string; stem: string};

export const validateRephraseRow = (raw: unknown): RephraseRow | null => {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.cardId !== 'string' || r.cardId.length === 0) {
    return null;
  }
  if (typeof r.stem !== 'string' || r.stem.length === 0) {
    return null;
  }
  return {cardId: r.cardId, stem: r.stem};
};

// Typed errors so callers can branch on cause without parsing
// messages. Network/abort errors come straight from the provider and
// are wrapped here as a separate kind so GrillView can show "tap to
// retry" vs "deck malformed" appropriately.
export class DeckGenerationError extends Error {
  readonly kind: 'parse' | 'empty' | 'provider';
  constructor(kind: 'parse' | 'empty' | 'provider', message: string) {
    super(message);
    this.name = 'DeckGenerationError';
    this.kind = kind;
  }
}
