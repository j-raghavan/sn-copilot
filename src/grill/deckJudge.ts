// Scores a generated deck on the 4-axis rubric pulled from the user's
// source quote: factual correctness, clarity, distractor quality,
// type coverage. One LLM call, JSON-array response.
//
// The user-visible output of this module is NOT the scores themselves
// — those stay invisible per the locked-in UX. The scores drive
// silent regeneration of weak cards (regenerateIds) before they
// surface to the user. The optional `scores` map is still returned
// for diagnostics + a future "show me why this card changed" affordance.

import type {ProviderClient} from '../providers/ProviderClient';
import {
  Card,
  Deck,
  DeckGenerationError,
  JUDGE_MAX_TOKENS,
  JudgeResult,
  RubricScores,
  parseStrictJsonArray,
  shouldRegenerate,
  validateRubricRow,
} from './deckTypes';

export type JudgeDeckArgs = {
  client: ProviderClient;
  apiKey: string;
  model: string;
  // The page text the deck was generated from. Sent to the judge so
  // it can spot factual hallucinations (card claims a fact not in
  // source = factual<5). Image is NOT sent — adds tokens with little
  // judging signal vs the verbatim text.
  sourcePageText: string;
  deck: Deck;
  signal: AbortSignal;
};

// Exported so tests can pin the prompt and any future provider-native
// JSON-mode wiring (e.g., Anthropic tool_use forcing) can attach to a
// stable identifier.
export const JUDGE_SYSTEM_PROMPT = [
  'You are a strict reviewer for multiple-choice study cards.',
  'Score each card on four axes, 0..5 inclusive:',
  '  - factual: is the correct answer SUPPORTED by the source text?',
  '            5 = directly stated; 3 = inferable; 0 = invented.',
  '  - clarity: is the stem unambiguous and grammatical?',
  '  - distractor: are the 3 wrong choices near-misses (plausibly',
  '                correct on a skim, wrong on careful read)? 5 = yes;',
  '                0 = obvious throwaways.',
  '  - typeCoverage: relative to the rest of the deck, does this card',
  '                  contribute type variety (cloze / definition /',
  '                  inference / application)? 5 = yes; 0 = redundant.',
  '',
  'Output STRICT JSON. A single JSON array. One object per card with',
  'fields: cardId, factual, clarity, distractor, typeCoverage. No',
  'prose, no code fences, no commentary.',
].join('\n');

// Compact one-card representation we ship to the judge. We deliberately
// don't send the explanation or sourceQuote back — the judge derives
// its scores from the stem + choices + the page text, not the model's
// own self-explanation.
const cardForJudge = (c: Card): Record<string, unknown> => ({
  cardId: c.id,
  type: c.type,
  stem: c.stem,
  choices: c.choices,
  correctIndex: c.correctIndex,
});

const buildJudgeUserText = (deck: Deck, sourcePageText: string): string => {
  const cardsBlock = JSON.stringify(deck.cards.map(cardForJudge), null, 2);
  return (
    `Score these ${deck.cards.length} cards. Return JSON array only.\n\n` +
    `--- Source text ---\n${sourcePageText}\n\n` +
    `--- Cards ---\n${cardsBlock}`
  );
};

export const judgeDeck = async (args: JudgeDeckArgs): Promise<JudgeResult> => {
  const {client, apiKey, model, sourcePageText, deck, signal} = args;

  let response;
  try {
    response = await client.send(
      {
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        userText: buildJudgeUserText(deck, sourcePageText),
        // No image — the judge works off the verbatim source text we
        // already have transcribed. Cheaper, faster, and no provider-
        // capability branching needed.
        imageBase64: undefined,
        maxTokens: JUDGE_MAX_TOKENS,
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
      `Judge did not return valid JSON: ${(e as Error).message}`,
    );
  }

  const scores = new Map<string, RubricScores>();
  const regenerateIds: string[] = [];
  // Build a set of known card ids so a judge that hallucinates new ids
  // gets filtered. We never act on scores attached to ids we didn't ask
  // about — they'd be unsafe to regenerate / display.
  const knownIds = new Set(deck.cards.map((c) => c.id));

  for (const raw of rawArray) {
    const r = validateRubricRow(raw);
    if (!r.ok) {
      continue;
    }
    if (!knownIds.has(r.value.cardId)) {
      continue;
    }
    scores.set(r.value.cardId, r.value.scores);
    if (shouldRegenerate(r.value.scores)) {
      regenerateIds.push(r.value.cardId);
    }
  }

  return {scores, regenerateIds};
};

// Convenience for callers who want the aggregate score for an
// optional "you scored 4/5" UI line. Drops cards the judge didn't
// return; divides by remaining count. Returns 0 when no cards were
// judged at all (caller should treat as "judge unavailable").
export const averageRubric = (
  result: JudgeResult,
): RubricScores | null => {
  if (result.scores.size === 0) {
    return null;
  }
  let f = 0;
  let cl = 0;
  let d = 0;
  let tc = 0;
  result.scores.forEach((s) => {
    f += s.factual;
    cl += s.clarity;
    d += s.distractor;
    tc += s.typeCoverage;
  });
  const n = result.scores.size;
  return {
    factual: f / n,
    clarity: cl / n,
    distractor: d / n,
    typeCoverage: tc / n,
  };
};
