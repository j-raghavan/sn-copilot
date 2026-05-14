// Generates a deck of MCQ "drill" cards from the current page.
//
// One LLM call. JSON-only response. The system prompt enforces the
// rubric the user's source quote called out as the moat: mixed
// question types, near-miss distractors (not "obviously wrong"),
// and source anchoring. The judge pass (deckJudge.ts) scores how
// well the model actually followed the rubric and triggers silent
// regeneration of weak cards before they surface.
//
// Pure module: no React Native imports, no provider implementation
// detail leaks in. The caller (DrillView) injects the ProviderClient.

import {composeUserText} from '../scope/composePrompt';
import type {ProviderClient} from '../providers/ProviderClient';
import type {PageContext} from '../scope/pageContext';
import {
  Card,
  DECK_SIZE,
  Deck,
  DeckGenerationError,
  GENERATE_MAX_TOKENS,
  parseStrictJsonArray,
  validateCards,
} from './deckTypes';

export type GenerateDeckArgs = {
  client: ProviderClient;
  apiKey: string;
  model: string;
  pageContext: PageContext;
  // Caller-supplied so DrillView controls the abort lifecycle exactly
  // like ChatView's send path (timeout = setTimeout(() => abort)).
  signal: AbortSignal;
  // How many cards to ask for. Defaults to DECK_SIZE (5). Lower
  // counts are useful in tests and on long pages where the model
  // would otherwise truncate.
  count?: number;
  // Optional override for the deck id — useful for tests that want
  // stable ids. Production callers omit this and accept the
  // timestamp-based default.
  deckIdOverride?: string;
  // For unit tests: stub `now()` so the deck id + createdAt are
  // predictable without touching Date.now() globally.
  now?: () => number;
  // Allow callers to add image attachment when the provider supports
  // it. Defaults to true — the page screenshot lifts handwriting
  // accuracy on vision models. Set false for text-only providers.
  attachImage?: boolean;
};

// Exported so deckJudge / rephraseDeck can reuse the same source-of-
// truth instructions ("here's how a Grill card should look"). DRY:
// any tightening of the rubric here automatically lands in the judge
// pass on the next request.
export const GRILL_SYSTEM_PROMPT = [
  'You generate study questions for active recall from a single page',
  'of notes, a PDF, or an EPUB. Your job is to make the reader',
  'ENCODE the material, not just look up the answer.',
  '',
  'Hard rules:',
  '1. Output STRICT JSON. A single JSON array, nothing else. No prose',
  '   before or after, no code fences, no commentary.',
  '2. Each item is an object with exactly these fields:',
  '   - id: string (e.g. "c1", "c2"...)',
  '   - type: one of "cloze" | "definition" | "inference" | "application"',
  '   - stem: the question text. For cloze, use ____ for the blank.',
  '   - choices: array of exactly 4 strings. ONE is correct.',
  '     The other 3 must be NEAR-MISSES (plausibly correct on a',
  '     skim, wrong on careful read). No "all of the above" /',
  '     "none of the above". No joke options.',
  '   - correctIndex: integer 0..3 — position of the correct choice.',
  '   - explanation: 1-2 sentences on WHY the correct answer is right',
  '     and at least one distractor is a near-miss.',
  '   - sourceQuote: a short verbatim snippet (<= 200 chars) from the',
  '     source text the question is anchored to. Empty string is',
  '     allowed only if the source text was empty.',
  '3. Question-type SPREAD matters. Do not return all cloze, do not',
  '   return all definition recall. Mix all four types when the',
  '   source text supports it (most pages do).',
  '4. Facts must come from the source. Do not invent dates, numbers,',
  '   or names that are not present in the source.',
].join('\n');

const buildUserPrompt = (
  pageContext: PageContext,
  count: number,
): string => {
  const ask =
    `Generate exactly ${count} drill cards from the following source.\n` +
    'Return JSON only — no prose, no fences. Mix question types.\n';
  return composeUserText(ask, pageContext);
};

// Deck id mints from a timestamp + a short random suffix so two
// generations on the same page in the same ms don't collide. We
// deliberately use Math.random for the suffix — this is a UI id,
// not a security boundary.
const mintDeckId = (now: number): string => {
  const suffix = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `deck-${now.toString(36)}-${suffix}`;
};

// Card ids from the model are accepted as-is unless missing/invalid
// (validateCard already falls back to the supplied `card-<i>`). We
// re-namespace them under the deck id so two decks generated back-to-
// back can't share a card id — keeps the regen path safe to merge.
const renamespaceCardIds = (deckId: string, cards: Card[]): Card[] =>
  cards.map((c, i) => ({...c, id: `${deckId}-c${i + 1}`}));

export const generateDeck = async (args: GenerateDeckArgs): Promise<Deck> => {
  const {
    client,
    apiKey,
    model,
    pageContext,
    signal,
    count = DECK_SIZE,
    deckIdOverride,
    now = () => Date.now(),
    attachImage = true,
  } = args;

  const userText = buildUserPrompt(pageContext, count);

  let response;
  try {
    response = await client.send(
      {
        systemPrompt: GRILL_SYSTEM_PROMPT,
        userText,
        imageBase64: attachImage ? pageContext.screenshotBase64 : undefined,
        maxTokens: GENERATE_MAX_TOKENS,
        signal,
      },
      {apiKey, model},
    );
  } catch (e) {
    // Provider failure (timeout/network/HTTP). Wrap so callers can
    // branch on kind without parsing strings.
    throw new DeckGenerationError(
      'provider',
      e instanceof Error ? e.message : String(e),
    );
  }

  let rawArray: unknown[];
  try {
    rawArray = parseStrictJsonArray(response.text);
  } catch (e) {
    throw new DeckGenerationError(
      'parse',
      `Model did not return valid JSON: ${(e as Error).message}`,
    );
  }

  const {cards} = validateCards(rawArray);
  if (cards.length === 0) {
    throw new DeckGenerationError(
      'empty',
      'Model returned no valid cards. The page may be too sparse.',
    );
  }

  const stamp = now();
  const deckId = deckIdOverride ?? mintDeckId(stamp);
  return {
    id: deckId,
    createdAt: stamp,
    notePath: pageContext.notePath,
    page: pageContext.page,
    cards: renamespaceCardIds(deckId, cards),
  };
};
