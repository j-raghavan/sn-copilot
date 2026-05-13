// "Grill Me" screen. Single-surface card flow per the locked plan:
//
//   generating  →  grilling  →  done
//        │           │           │
//        ▼           ▼           ▼
//   one spinner   one card    score + 4-axis bars + Grill again
//
// The rubric (judgeDeck) runs in the BACKGROUND after generation
// completes. Results land on:
//   - per-card chip row inside the reveal panel (when the user
//     answers a card whose score is known)
//   - aggregate 4-axis bars on the Done screen
//   - silent regeneration of cards flagged as weak (factual<4 OR
//     distractor<3); the swap is tracked so the Done screen can say
//     "we swapped card N — its distractors were too easy".
//
// "Grill again" rephrases stems AND reshuffles choices, defeating
// positional pattern matching across revisits. The PREVIOUS pass's
// background pipeline is aborted before a new deck takes over, so
// stale regens never poison the rephrased deck (the regen IDs
// collide because rephrase keeps cardIds).
//
// Constraints honored:
//   - AbortController + setTimeout pattern from ChatView (not
//     signal.addEventListener — unreliable on Hermes).
//   - tryAcquire / release re-entrancy guard so a Grill can't run
//     concurrently with a chat send.
//   - No streaming, no multi-turn LLM context, no persistence.

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {infoLog} from '../diagnostics/log';
import type {ProviderClient} from '../providers/ProviderClient';
import {release, tryAcquire} from '../reentrancy/inFlightGuard';
import type {PageContext} from '../scope/pageContext';
import {generateDeck} from '../grill/deckGenerator';
import {judgeDeck} from '../grill/deckJudge';
import {regenerateCard} from '../grill/regenerateCard';
import {rephraseDeck} from '../grill/rephraseDeck';
import {
  Card,
  CardChoiceIndex,
  DECK_SIZE,
  DISTRACTOR_REGEN_THRESHOLD,
  Deck,
  DeckGenerationError,
  FACTUAL_REGEN_THRESHOLD,
  JudgeResult,
  RubricScores,
} from '../grill/deckTypes';
import {sanitizeProviderError} from './sanitizeProviderError';
import GrillCard from './GrillCard';

// Hard ceilings, mirrored from ChatView's send timeout. Generation
// is the slowest call (~6-15s on a real provider), so we give it
// double the chat budget.
const GENERATE_TIMEOUT_MS = 120_000;
const JUDGE_TIMEOUT_MS = 90_000;
const REGENERATE_TIMEOUT_MS = 60_000;
const REPHRASE_TIMEOUT_MS = 90_000;

type Phase = 'generating' | 'grilling' | 'done' | 'error';

type Answer = {cardId: string; selected: CardChoiceIndex; correct: boolean};

type Swap = {
  position: number; // 1-based
  reason: 'factual' | 'distractor';
};

export type GrillViewProps = {
  client: ProviderClient;
  apiKey: string;
  model: string;
  attachImage: boolean;
  pageContext: PageContext;
  onBack: () => void;
};

const runWithTimeout = async <T,>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const ctl = new AbortController();
  const timeoutId = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await run(ctl.signal);
  } finally {
    clearTimeout(timeoutId);
  }
};

const swapReason = (s: RubricScores): 'factual' | 'distractor' =>
  s.distractor < DISTRACTOR_REGEN_THRESHOLD ? 'distractor' : 'factual';

// Single chokepoint for kicking off the generate pipeline. Shared
// between the initial-mount bootstrap and the Retry button. Returns
// the generated Deck on success; on failure, calls onError with the
// user-visible message and returns null.
type GeneratePipelineArgs = {
  client: ProviderClient;
  apiKey: string;
  model: string;
  pageContext: PageContext;
  attachImage: boolean;
  pendingRegenRef: React.MutableRefObject<Map<string, Card>>;
  isAlive: () => boolean;
  onResult: (result: JudgeResult) => void;
  generationSignal: AbortSignal;
};

const runGeneratePipeline = async (
  args: GeneratePipelineArgs,
): Promise<{ok: true; deck: Deck} | {ok: false; error: unknown}> => {
  const {
    client,
    apiKey,
    model,
    pageContext,
    attachImage,
    pendingRegenRef,
    isAlive,
    onResult,
    generationSignal,
  } = args;
  let deck: Deck;
  try {
    deck = await runWithTimeout(GENERATE_TIMEOUT_MS, (signal) =>
      generateDeck({
        client,
        apiKey,
        model,
        pageContext,
        signal,
        attachImage,
      }),
    );
  } catch (e) {
    return {ok: false, error: e};
  }
  judgeAndRegenerateInBackground(
    deck,
    client,
    apiKey,
    model,
    pageContext,
    attachImage,
    pendingRegenRef,
    isAlive,
    onResult,
    generationSignal,
  );
  return {ok: true, deck};
};

export default function GrillView(props: GrillViewProps): React.JSX.Element {
  const {client, apiKey, model, attachImage, pageContext, onBack} = props;

  const [phase, setPhase] = useState<Phase>('generating');
  const [deck, setDeck] = useState<Deck | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [selected, setSelected] = useState<CardChoiceIndex | null>(null);
  const [judgeResult, setJudgeResult] = useState<JudgeResult | null>(null);
  const [swappedCards, setSwappedCards] = useState<Swap[]>([]);

  const mountedRef = useRef<boolean>(true);
  const pendingRegenRef = useRef<Map<string, Card>>(new Map());
  // Scoped abort signal for the BACKGROUND judge + regen pipeline.
  // Distinct from the per-call timeouts inside runWithTimeout.
  // Aborted (and replaced) whenever a new generation starts (Retry)
  // or the deck identity changes (Grill again), so an in-flight v1
  // regen cannot pollute v2's pendingRegenRef and silently swap into
  // the rephrased deck.
  const generationAbortRef = useRef<AbortController | null>(null);
  const judgeResultRef = useRef<JudgeResult | null>(null);

  // Keep the ref in sync with state so onAdvance can look up the
  // reason for each swap without re-creating the callback every time
  // the judge ticks.
  useEffect(() => {
    judgeResultRef.current = judgeResult;
  }, [judgeResult]);

  // Helper: end the in-flight background pipeline and clear any
  // pending regen results. Used by Grill again, Retry, and unmount.
  const cancelBackground = useCallback(() => {
    if (generationAbortRef.current !== null) {
      generationAbortRef.current.abort();
    }
    pendingRegenRef.current.clear();
  }, []);

  // Bootstrap: acquire guard, kick the shared pipeline. We're using
  // useEffect with stable deps so this runs once per mount.
  useEffect(() => {
    mountedRef.current = true;
    if (!tryAcquire()) {
      setPhase('error');
      setErrorMessage('Another request is in flight. Try again in a moment.');
      return () => {
        mountedRef.current = false;
      };
    }
    let released = false;
    const releaseOnce = (): void => {
      if (released) {
        return;
      }
      released = true;
      release();
    };
    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    const generationSignal = abortController.signal;
    const isAlive = (): boolean =>
      mountedRef.current && !generationSignal.aborted;

    (async () => {
      const result = await runGeneratePipeline({
        client,
        apiKey,
        model,
        pageContext,
        attachImage,
        pendingRegenRef,
        isAlive,
        onResult: (r) => {
          if (isAlive()) {
            setJudgeResult(r);
          }
        },
        generationSignal,
      });
      releaseOnce();
      if (!isAlive()) {
        return;
      }
      if (!result.ok) {
        setPhase('error');
        setErrorMessage(toUserMessage(result.error));
        return;
      }
      setDeck(result.deck);
      setPhase('grilling');
    })();
    return () => {
      mountedRef.current = false;
      abortController.abort();
      releaseOnce();
    };
  }, [client, apiKey, model, pageContext, attachImage]);

  const answerCard = (currentDeck: Deck, idx: CardChoiceIndex): void => {
    const card = currentDeck.cards[currentIndex];
    const isCorrect = idx === card.correctIndex;
    setSelected(idx);
    setAnswers((curr) => [
      ...curr,
      {cardId: card.id, selected: idx, correct: isCorrect},
    ]);
  };

  const advanceCard = (currentDeck: Deck): void => {
    const nextIndex = currentIndex + 1;
    const pending = pendingRegenRef.current;
    if (pending.size > 0) {
      // CAPTURE swaps into a local map BEFORE we mutate `pending` and
      // before we queue setDeck — React 18 batches the setDeck
      // callback, and by the time it runs the loop below has already
      // deleted the pending entries. The local map holds them stable.
      const swapsById = new Map<string, Card>();
      const judgeAtSwap = judgeResultRef.current;
      const newSwaps: Swap[] = [];
      for (let i = nextIndex; i < currentDeck.cards.length; i++) {
        const cardId = currentDeck.cards[i].id;
        const replacement = pending.get(cardId);
        if (replacement !== undefined) {
          swapsById.set(cardId, replacement);
          const scores = judgeAtSwap?.scores.get(cardId);
          newSwaps.push({
            position: i + 1,
            reason: scores ? swapReason(scores) : 'distractor',
          });
          pending.delete(cardId);
        }
      }
      if (swapsById.size > 0) {
        // setDeck inside onAdvance only fires when deck is non-null
        // (the button isn't rendered otherwise), so the curr passed
        // to the updater is always a live Deck.
        setDeck((curr) => {
          const live = curr as Deck;
          const swapped = live.cards.map((c, i) =>
            i < nextIndex ? c : swapsById.get(c.id) ?? c,
          );
          return {...live, cards: swapped};
        });
        setSwappedCards((curr) => [...curr, ...newSwaps]);
      }
    }
    if (nextIndex >= currentDeck.cards.length) {
      setPhase('done');
      return;
    }
    setCurrentIndex(nextIndex);
    setSelected(null);
  };

  const grillAgain = async (currentDeck: Deck): Promise<void> => {
    // Cancel the previous pipeline FIRST. The v1 regen for a card id
    // would otherwise land in pendingRegenRef and swap a v1-flavored
    // card into the v2 deck (rephrase preserves card ids).
    cancelBackground();
    setPhase('generating');
    setAnswers([]);
    setCurrentIndex(0);
    setSelected(null);
    setSwappedCards([]);
    try {
      const rephrased = await runWithTimeout(REPHRASE_TIMEOUT_MS, (signal) =>
        rephraseDeck({client, apiKey, model, deck: currentDeck, signal}),
      );
      if (!mountedRef.current) {
        return;
      }
      setDeck(rephrased);
      setPhase('grilling');
    } catch (e) {
      if (!mountedRef.current) {
        return;
      }
      setPhase('error');
      setErrorMessage(sanitizeProviderError(e));
    }
  };

  const onRetry = useCallback(() => {
    cancelBackground();
    setPhase('generating');
    setDeck(null);
    setAnswers([]);
    setCurrentIndex(0);
    setSelected(null);
    setErrorMessage(null);
    setJudgeResult(null);
    setSwappedCards([]);
    if (!tryAcquire()) {
      setPhase('error');
      setErrorMessage('Another request is in flight. Try again.');
      return;
    }
    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    const generationSignal = abortController.signal;
    const isAlive = (): boolean =>
      mountedRef.current && !generationSignal.aborted;
    (async () => {
      const result = await runGeneratePipeline({
        client,
        apiKey,
        model,
        pageContext,
        attachImage,
        pendingRegenRef,
        isAlive,
        onResult: (r) => {
          if (isAlive()) {
            setJudgeResult(r);
          }
        },
        generationSignal,
      });
      release();
      if (!isAlive()) {
        return;
      }
      if (!result.ok) {
        setPhase('error');
        setErrorMessage(toUserMessage(result.error));
        return;
      }
      setDeck(result.deck);
      setPhase('grilling');
    })();
  }, [client, apiKey, model, pageContext, attachImage, cancelBackground]);

  return (
    <View testID="grill-view" style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Grill Me</Text>
        <TouchableOpacity
          testID="grill-close"
          accessibilityLabel="Close Grill, return to chat"
          onPress={onBack}
          style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>×</Text>
        </TouchableOpacity>
      </View>

      {phase === 'generating' ? (
        <View testID="grill-loading" style={styles.center}>
          <Text style={styles.loadingText}>Building your Grill deck…</Text>
          <Text style={styles.loadingHint}>
            One screen. {DECK_SIZE} questions. Tap to answer.
          </Text>
        </View>
      ) : null}

      {phase === 'grilling' && deck !== null ? (
        <GrillCard
          card={deck.cards[currentIndex]}
          selected={selected}
          position={currentIndex + 1}
          total={deck.cards.length}
          onAnswer={(idx) => answerCard(deck, idx)}
          onAdvance={() => advanceCard(deck)}
        />
      ) : null}

      {phase === 'done' && deck !== null ? (
        <DoneScreen
          deck={deck}
          answers={answers}
          judgeResult={judgeResult}
          swappedCards={swappedCards}
          onGrillAgain={() => grillAgain(deck)}
        />
      ) : null}

      {phase === 'error' ? (
        <View testID="grill-error" style={styles.center}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <TouchableOpacity
            testID="grill-retry"
            accessibilityLabel="Retry"
            onPress={onRetry}
            style={styles.pill}>
            <Text style={styles.pillText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

// Map a generate-pipeline error to a user-visible message. Parse
// failures get a distinct copy; everything else flows through the
// shared sanitizer.
const toUserMessage = (e: unknown): string => {
  if (e instanceof DeckGenerationError && e.kind === 'parse') {
    return 'The model returned an unusable response. Tap retry to try again.';
  }
  return sanitizeProviderError(e);
};

// --- Done screen --------------------------------------------------
//
// Built on the user-knowledge model — what the LEARNER got out of the
// session — rather than the deck-quality model from the original
// implementation. The deck-quality rubric still runs in the
// background (it drives the auto-regen of weak cards, surfaced via
// the "we swapped card N" callout below) but is no longer rendered
// as a 4-axis bar chart; surveyed learning apps treat generation
// quality as backstage telemetry.
//
// Three blocks, in order:
//   1. 2x2 quadrant grid by question type (cloze / definition /
//      inference / application). Each quadrant shows the marks for
//      that type (✓ for each correct, ✗ for each miss) and a count.
//      Empty quadrants render an em-dash + "not tested" — the type-
//      coverage gap is visible at-a-glance.
//   2. "Review these" — one block per missed card, showing the
//      stem, what the user picked, the correct answer, and the
//      source quote (borrowed from NotebookLM's pattern).
//   3. Swap callout — unchanged.

import {QUESTION_TYPES, type QuestionType} from '../grill/deckTypes';

type DoneScreenProps = {
  deck: Deck;
  answers: Answer[];
  swappedCards: Swap[];
  onGrillAgain: () => void;
};

const TYPE_LABELS: Record<QuestionType, string> = {
  cloze: 'Cloze',
  definition: 'Definition',
  inference: 'Inference',
  application: 'Application',
};

// Group answers by question type. Each entry holds the marks the
// user earned ('correct' | 'wrong') and the source cards they came
// from, in deck order. Types with no questions render as "not
// tested" — we always render all 4 quadrants so the 2x2 grid stays
// structurally stable.
type TypeBucket = {
  type: QuestionType;
  marks: Array<{cardId: string; correct: boolean}>;
};

const bucketByType = (deck: Deck, answers: Answer[]): TypeBucket[] => {
  const byCardId = new Map(deck.cards.map((c) => [c.id, c]));
  const buckets: Record<QuestionType, TypeBucket> = {
    cloze: {type: 'cloze', marks: []},
    definition: {type: 'definition', marks: []},
    inference: {type: 'inference', marks: []},
    application: {type: 'application', marks: []},
  };
  // Every answer.cardId comes from a card already in deck.cards
  // (cards are only added at generate time; rephrase/regen preserve
  // IDs). The lookup is always defined.
  for (const a of answers) {
    const card = byCardId.get(a.cardId) as Card;
    buckets[card.type].marks.push({cardId: a.cardId, correct: a.correct});
  }
  return QUESTION_TYPES.map((t) => buckets[t]);
};

function DoneScreen(props: DoneScreenProps): React.JSX.Element {
  const {deck, answers, swappedCards, onGrillAgain} = props;
  const correct = answers.reduce((acc, a) => (a.correct ? acc + 1 : acc), 0);
  const buckets = bucketByType(deck, answers);
  const byCardId = new Map(deck.cards.map((c) => [c.id, c]));
  // Misses, in the order the user encountered them — the Review-these
  // list should follow the drill order so the user can locate cards.
  const misses = answers
    .map((a, i) => ({answer: a, position: i + 1}))
    .filter(({answer}) => !answer.correct);

  return (
    <ScrollView
      testID="grill-done"
      style={styles.doneScroll}
      contentContainerStyle={styles.doneRoot}>
      <Text testID="grill-score" style={styles.scoreText}>
        {`${correct} / ${deck.cards.length}`}
      </Text>
      <Text style={styles.scoreHint}>
        {scoreHint(correct, deck.cards.length)}
      </Text>

      <View testID="grill-type-grid" style={styles.gridRoot}>
        <View style={styles.gridRow}>
          <TypeQuadrant bucket={buckets[0]} />
          <TypeQuadrant bucket={buckets[1]} />
        </View>
        <View style={styles.gridRow}>
          <TypeQuadrant bucket={buckets[2]} />
          <TypeQuadrant bucket={buckets[3]} />
        </View>
      </View>

      {misses.length > 0 ? (
        <View testID="grill-review-these" style={styles.reviewRoot}>
          <Text style={styles.reviewHeader}>Review these</Text>
          {misses.map(({answer, position}) => {
            const card = byCardId.get(answer.cardId) as Card;
            const userPick = card.choices[answer.selected];
            const correctText = card.choices[card.correctIndex];
            return (
              <View
                key={answer.cardId}
                testID={`grill-review-card-${position}`}
                style={styles.reviewCard}>
                <Text style={styles.reviewCardHeader}>
                  {`Card ${position} · ${TYPE_LABELS[card.type]}`}
                </Text>
                <Text style={styles.reviewStem}>{`Q: ${card.stem}`}</Text>
                <Text style={styles.reviewLine}>
                  <Text style={styles.reviewLabel}>You picked: </Text>
                  {userPick}
                </Text>
                <Text style={styles.reviewLine}>
                  <Text style={styles.reviewLabel}>Correct: </Text>
                  {correctText}
                </Text>
                {card.sourceQuote.length > 0 ? (
                  <Text style={styles.reviewSource}>
                    {`Source: "${card.sourceQuote}"`}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {swappedCards.length > 0 ? (
        <View testID="grill-swap-callout" style={styles.swapRoot}>
          {swappedCards.map((s, i) => (
            <Text
              key={i}
              testID={`grill-swap-callout-${s.position}`}
              style={styles.swapText}>
              {`We swapped card ${s.position} — its ${
                s.reason === 'distractor'
                  ? 'distractors were too easy'
                  : 'facts were thin'
              } on the first pass.`}
            </Text>
          ))}
        </View>
      ) : null}

      <TouchableOpacity
        testID="grill-again"
        accessibilityLabel="Grill again with rephrased questions"
        onPress={onGrillAgain}
        style={styles.pill}>
        <Text style={styles.pillText}>Grill again</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function TypeQuadrant({bucket}: {bucket: TypeBucket}): React.JSX.Element {
  const {type, marks} = bucket;
  const correct = marks.filter((m) => m.correct).length;
  const total = marks.length;
  // Marks render inline, in deck order. The string composition is
  // tested separately so the visual rule ("✓ for each correct, ✗ for
  // each miss") can't drift across refactors.
  const markString = marks.map((m) => (m.correct ? '✓' : '✗')).join('  ');
  return (
    <View
      testID={`grill-quadrant-${type}`}
      style={styles.quadrant}>
      <Text style={styles.quadrantLabel}>{TYPE_LABELS[type]}</Text>
      {total > 0 ? (
        <>
          <Text
            testID={`grill-quadrant-${type}-marks`}
            style={styles.quadrantMarks}>
            {markString}
          </Text>
          <Text
            testID={`grill-quadrant-${type}-count`}
            style={styles.quadrantCount}>
            {`${correct} / ${total}`}
          </Text>
        </>
      ) : (
        <>
          <Text
            testID={`grill-quadrant-${type}-empty`}
            style={styles.quadrantMarks}>
            {'—'}
          </Text>
          <Text style={styles.quadrantNotTested}>not tested</Text>
        </>
      )}
    </View>
  );
}

const judgeAndRegenerateInBackground = async (
  deck: Deck,
  client: ProviderClient,
  apiKey: string,
  model: string,
  pageContext: PageContext,
  attachImage: boolean,
  pendingRegenRef: React.MutableRefObject<Map<string, Card>>,
  isAlive: () => boolean,
  onResult: (result: JudgeResult) => void,
  generationSignal: AbortSignal,
): Promise<void> => {
  let judgeResult: JudgeResult;
  try {
    judgeResult = await runWithTimeout(JUDGE_TIMEOUT_MS, (signal) =>
      judgeDeck({
        client,
        apiKey,
        model,
        sourcePageText: pageContext.pageText,
        deck,
        signal,
      }),
    );
  } catch (e) {
    infoLog('[GRILL] judge failed', String(e));
    return;
  }
  if (!isAlive() || generationSignal.aborted) {
    return;
  }
  onResult(judgeResult);
  if (judgeResult.regenerateIds.length === 0) {
    return;
  }
  for (const cardId of judgeResult.regenerateIds) {
    // The post-regen isAlive check below catches mid-loop abort —
    // saving one wasted LLM call in the rare between-iteration race
    // isn't worth the test complexity of forcing the branch.
    const original = deck.cards.find((c) => c.id === cardId) as Card;
    try {
      const replacement = await runWithTimeout(
        REGENERATE_TIMEOUT_MS,
        (signal) =>
          regenerateCard({
            client,
            apiKey,
            model,
            pageContext,
            originalCard: original,
            signal,
            attachImage,
          }),
      );
      if (!isAlive() || generationSignal.aborted) {
        return;
      }
      pendingRegenRef.current.set(cardId, replacement);
    } catch (e) {
      infoLog(`[GRILL] regenerate ${cardId} failed`, String(e));
    }
  }
};

const scoreHint = (correct: number, total: number): string => {
  const ratio = correct / total;
  if (ratio === 1) {
    return 'Solid. Worth one more pass with rephrased stems.';
  }
  if (ratio >= 0.6) {
    return 'Good. Grill again to lock in the misses.';
  }
  return 'Tap Grill again — rephrased stems help on the next pass.';
};

export const __testing__ = {
  scoreHint,
  swapReason,
  FACTUAL_REGEN_THRESHOLD,
  DISTRACTOR_REGEN_THRESHOLD,
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#000000',
  },
  title: {
    fontSize: 26,
    fontWeight: '600',
    color: '#000000',
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 0,
    marginLeft: 8,
  },
  closeBtnText: {
    fontSize: 32,
    color: '#000000',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },
  loadingText: {
    fontSize: 19,
    color: '#000000',
    marginBottom: 8,
  },
  loadingHint: {
    fontSize: 15,
    color: '#000000',
    fontStyle: 'italic',
  },
  doneScroll: {
    flex: 1,
  },
  doneRoot: {
    alignItems: 'center',
    paddingVertical: 16,
    paddingBottom: 32,
  },
  scoreText: {
    fontSize: 48,
    fontWeight: '700',
    color: '#000000',
    marginBottom: 4,
  },
  scoreHint: {
    fontSize: 15,
    color: '#000000',
    fontStyle: 'italic',
    marginBottom: 16,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  gridRoot: {
    alignSelf: 'stretch',
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  gridRow: {
    flexDirection: 'row',
  },
  quadrant: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#000000',
    paddingHorizontal: 10,
    paddingVertical: 10,
    alignItems: 'center',
    minHeight: 80,
  },
  quadrantLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
  },
  quadrantMarks: {
    fontSize: 22,
    fontWeight: '700',
    color: '#000000',
    letterSpacing: 4,
    marginBottom: 6,
  },
  quadrantCount: {
    fontSize: 13,
    color: '#000000',
  },
  quadrantNotTested: {
    fontSize: 12,
    color: '#000000',
    fontStyle: 'italic',
  },
  reviewRoot: {
    alignSelf: 'stretch',
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  reviewHeader: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000000',
    textAlign: 'center',
    marginBottom: 8,
  },
  reviewCard: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  reviewCardHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#000000',
    marginBottom: 6,
  },
  reviewStem: {
    fontSize: 14,
    color: '#000000',
    marginBottom: 6,
  },
  reviewLine: {
    fontSize: 13,
    color: '#000000',
    marginBottom: 2,
  },
  reviewLabel: {
    fontWeight: '700',
    color: '#000000',
  },
  reviewSource: {
    fontSize: 12,
    color: '#000000',
    fontStyle: 'italic',
    marginTop: 4,
  },
  swapRoot: {
    alignSelf: 'stretch',
    paddingHorizontal: 24,
    marginBottom: 16,
  },
  swapText: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: 4,
  },
  errorText: {
    fontSize: 17,
    color: '#000000',
    marginBottom: 16,
    textAlign: 'center',
  },
  pill: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 24,
  },
  pillText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000000',
  },
});
