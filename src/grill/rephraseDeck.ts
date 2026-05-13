// Rephrases the stems of every card in a deck for the "Drill again"
// flow. Keeps the same correct answer and the same explanation —
// only the question phrasing changes — so users encode the material
// across multiple framings instead of pattern-matching the first
// three words of the stem.
//
// One LLM call. The model returns ONLY the rephrased stems keyed by
// cardId; choices/explanation/sourceQuote are merged from the
// original deck so a misbehaving model can't introduce factual drift
// here.

import type {ProviderClient} from '../providers/ProviderClient';
import {
  Card,
  Deck,
  DeckGenerationError,
  REPHRASE_MAX_TOKENS,
  Rng,
  defaultRng,
  parseStrictJsonArray,
  shuffleChoices,
  validateRephraseRow,
} from './deckTypes';

export type RephraseDeckArgs = {
  client: ProviderClient;
  apiKey: string;
  model: string;
  deck: Deck;
  signal: AbortSignal;
  // Inject for deterministic tests; defaults to Math.random.
  rng?: Rng;
};

export const REPHRASE_SYSTEM_PROMPT = [
  'You rephrase study-card stems for revision.',
  'For each provided card you receive {cardId, stem}. Write a new',
  'stem that asks for the SAME information from a different angle.',
  'Do not change the correct answer. Do not change the question',
  'type. Keep the rephrasing roughly the same length.',
  '',
  'Output STRICT JSON. A single JSON array, one object per card,',
  'with fields {cardId, stem}. No prose, no fences.',
].join('\n');

const buildUserText = (deck: Deck): string => {
  const block = JSON.stringify(
    deck.cards.map((c) => ({cardId: c.id, stem: c.stem})),
    null,
    2,
  );
  return `Rephrase the stems of these cards.\n\n--- Cards ---\n${block}`;
};

export const rephraseDeck = async (
  args: RephraseDeckArgs,
): Promise<Deck> => {
  const {client, apiKey, model, deck, signal, rng = defaultRng} = args;

  let response;
  try {
    response = await client.send(
      {
        systemPrompt: REPHRASE_SYSTEM_PROMPT,
        userText: buildUserText(deck),
        imageBase64: undefined,
        maxTokens: REPHRASE_MAX_TOKENS,
        signal,
      },
      {apiKey, model},
    );
  } catch (e) {
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
      `Rephrase did not return valid JSON: ${(e as Error).message}`,
    );
  }

  const stemById = new Map<string, string>();
  for (const raw of rawArray) {
    const row = validateRephraseRow(raw);
    if (row !== null) {
      stemById.set(row.cardId, row.stem);
    }
  }

  // Build the new deck. Always reshuffle choices (defeats positional
  // memory). Update the stem only when the model returned a rephrase
  // for that id — silent fallback to the original on misbehaving
  // models, rather than failing the whole "Drill again" interaction.
  const updatedCards: Card[] = deck.cards.map((c) => {
    const shuffled = shuffleChoices(c, rng);
    const rephrased = stemById.get(c.id);
    return rephrased !== undefined ? {...shuffled, stem: rephrased} : shuffled;
  });

  return {...deck, cards: updatedCards};
};
