// Single-card replacement. Used in two places by DrillView:
//   1. Silently, in the background, when the judge flags a card with
//      poor distractor or factual scores (and the user hasn't seen it
//      yet).
//   2. Loudly, on "Drill again", to swap out the lowest-rubric card
//      with something fresh so revisits aren't just rephrases.
//
// Single LLM call. Same JSON shape as one element of generateDeck.

import {composeUserText} from '../scope/composePrompt';
import type {ProviderClient} from '../providers/ProviderClient';
import type {PageContext} from '../scope/pageContext';
import {
  Card,
  DeckGenerationError,
  REGENERATE_CARD_MAX_TOKENS,
  parseStrictJsonArray,
  validateCard,
} from './deckTypes';
import {GRILL_SYSTEM_PROMPT} from './deckGenerator';

export type RegenerateCardArgs = {
  client: ProviderClient;
  apiKey: string;
  model: string;
  pageContext: PageContext;
  // The card we're replacing. The model is told to write something
  // *different* — different angle of the same source, not a rephrase
  // of the same fact. This is the key difference from rephraseDeck:
  // rephrase keeps the answer, regenerate replaces it.
  originalCard: Card;
  signal: AbortSignal;
  attachImage?: boolean;
};

const buildUserPrompt = (
  pageContext: PageContext,
  original: Card,
): string => {
  const ask =
    'Generate ONE replacement drill card for the same source. Pick a' +
    ' DIFFERENT angle or fact than the original — do not paraphrase' +
    ' it. Return a JSON array with exactly one card object (same' +
    ' shape as generateDeck).\n\n' +
    '--- Original card to replace ---\n' +
    JSON.stringify(
      {
        type: original.type,
        stem: original.stem,
        choices: original.choices,
        correctIndex: original.correctIndex,
      },
      null,
      2,
    ) +
    '\n';
  return composeUserText(ask, pageContext);
};

export const regenerateCard = async (
  args: RegenerateCardArgs,
): Promise<Card> => {
  const {
    client,
    apiKey,
    model,
    pageContext,
    originalCard,
    signal,
    attachImage = true,
  } = args;

  let response;
  try {
    response = await client.send(
      {
        systemPrompt: GRILL_SYSTEM_PROMPT,
        userText: buildUserPrompt(pageContext, originalCard),
        imageBase64: attachImage ? pageContext.screenshotBase64 : undefined,
        maxTokens: REGENERATE_CARD_MAX_TOKENS,
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
      `Regenerate did not return valid JSON: ${(e as Error).message}`,
    );
  }

  if (rawArray.length === 0) {
    throw new DeckGenerationError(
      'empty',
      'Regenerate returned no card object',
    );
  }

  const result = validateCard(rawArray[0], originalCard.id);
  if (!result.ok) {
    throw new DeckGenerationError(
      'empty',
      `Regenerated card failed validation: ${result.reason}`,
    );
  }
  // Keep the SAME id as the original so callers can swap in-place
  // without re-indexing the deck array. (validateCard already used
  // originalCard.id as the fallback when the model omitted it.)
  return {...result.value, id: originalCard.id};
};
