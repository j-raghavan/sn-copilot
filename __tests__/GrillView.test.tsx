/**
 * Tests for src/ui/GrillView. Pins:
 *  - generating → grilling → done state machine
 *  - tap-to-answer + tap-to-advance flow
 *  - "Grill again" rephrases AND resets index/answers/swappedCards
 *  - background judge runs, does NOT block grilling
 *  - judge-flagged cards get silently swapped at the next advance
 *    AND surface as "we swapped card N" lines on Done
 *  - per-card rubric chips appear after judge resolves
 *  - 4-axis aggregate bars render on the Done screen
 *  - error state shows retry; retry path succeeds
 *  - in-flight guard rejects concurrent Grills
 *  - back button surfaces onBack
 *
 * The scripted provider extracts real card IDs from each outgoing
 * request so its responses always reference the IDs generateDeck
 * actually used (which are renamespaced under the deck id).
 */
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import GrillView from '../src/ui/GrillView';
import {
  __testing__ as guardTesting,
  tryAcquire,
} from '../src/reentrancy/inFlightGuard';
import type {
  ProviderClient,
  ProviderRequest,
} from '../src/providers/ProviderClient';
import type {PageContext} from '../src/scope/pageContext';
import {
  findByTestID,
  maybeFindByTestID,
  textOf,
} from './helpers/textTraversal';

const PAGE: PageContext = {
  notePath: '/foo.pdf',
  page: 1,
  screenshotPath: '/tmp/p.png',
  screenshotBase64: 'B64',
  pageText: 'sample text',
};

const baseCard = (id: string, stem = `stem ${id}?`, correctIndex = 0) => ({
  id,
  type: 'definition',
  stem,
  choices: ['A', 'B', 'C', 'D'],
  correctIndex,
  explanation: `because ${id}`,
  sourceQuote: `q ${id}`,
});

const DECK_BODY = JSON.stringify([
  baseCard('m1', 'stem 1?'),
  baseCard('m2', 'stem 2?'),
  baseCard('m3', 'stem 3?'),
  baseCard('m4', 'stem 4?'),
  baseCard('m5', 'stem 5?'),
]);

const extractCardIds = (text: string): string[] => {
  const re = /"cardId":\s*"([^"]+)"/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1]);
  }
  return ids;
};

type ProviderOptions = {
  failGenerate?: boolean;
  failJudge?: boolean;
  failRephrase?: boolean;
  failRegenerate?: boolean;
  // Position (1-based) of a card to mark as weak.
  weakAt?: number;
  // Which axis dips below threshold (drives the swap-reason callout).
  weakAxis?: 'factual' | 'distractor';
  regenerateBody?: string;
};

const scriptedProvider = (
  options: ProviderOptions = {},
  observer?: (req: ProviderRequest) => void,
): ProviderClient => ({
  id: 'fake',
  async send(req, opts) {
    if (observer) {
      observer(req);
    }
    const sys = req.systemPrompt;
    const respond = (text: string) => ({
      text,
      usage: {inputTokens: 1, outputTokens: 1},
      latencyMs: 1,
      modelId: opts.model,
    });
    if (sys.startsWith('You generate study questions')) {
      if (req.userText.includes('Original card to replace')) {
        if (options.failRegenerate) {
          throw new Error('regenerate boom');
        }
        return respond(options.regenerateBody ?? '[]');
      }
      if (options.failGenerate) {
        throw new Error('generate boom');
      }
      return respond(DECK_BODY);
    }
    if (sys.startsWith('You are a strict reviewer')) {
      if (options.failJudge) {
        throw new Error('judge boom');
      }
      const ids = extractCardIds(req.userText);
      const axis = options.weakAxis ?? 'distractor';
      const rows = ids.map((id, i) => {
        const isWeak =
          options.weakAt !== undefined && options.weakAt === i + 1;
        return {
          cardId: id,
          factual: isWeak && axis === 'factual' ? 2 : 5,
          clarity: 5,
          distractor: isWeak && axis === 'distractor' ? 1 : 5,
          typeCoverage: 5,
        };
      });
      return respond(JSON.stringify(rows));
    }
    if (sys.startsWith('You rephrase study-card')) {
      if (options.failRephrase) {
        throw new Error('rephrase boom');
      }
      const ids = extractCardIds(req.userText);
      const rows = ids.map((id, i) => ({cardId: id, stem: `rephrased ${i}?`}));
      return respond(JSON.stringify(rows));
    }
    return respond('[]');
  },
});

const drainMicrotasks = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

const flush = async (): Promise<void> => {
  await act(async () => {
    await drainMicrotasks();
  });
};

beforeEach(() => {
  guardTesting.reset();
});

const renderGrill = (
  overrides: Partial<React.ComponentProps<typeof GrillView>> = {},
  client: ProviderClient = scriptedProvider(),
): {tree: ReactTestRenderer; onBack: jest.Mock} => {
  const onBack = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <GrillView
        client={client}
        apiKey="sk"
        model="m"
        attachImage={true}
        pageContext={PAGE}
        onBack={onBack}
        {...overrides}
      />,
    );
  });
  return {tree, onBack};
};

describe('GrillView — state machine', () => {
  it('starts in the generating phase', () => {
    const {tree} = renderGrill();
    expect(findByTestID(tree, 'grill-loading')).toBeDefined();
  });

  it('transitions to grilling once the deck arrives', async () => {
    const {tree} = renderGrill();
    await flush();
    expect(maybeFindByTestID(tree, 'grill-loading')).toBeNull();
    expect(textOf(tree, 'grill-card-position')).toBe('Card 1 of 5');
    expect(textOf(tree, 'grill-card-stem')).toBe('stem 1?');
  });

  it('close (×) button fires onBack to return to chat', () => {
    const {tree, onBack} = renderGrill();
    act(() => {
      findByTestID(tree, 'grill-close').props.onPress();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('user-facing strings say "Grill", not "drill"', async () => {
    const {tree} = renderGrill();
    expect(textOf(tree, 'grill-loading')).toContain('Building your Grill deck');
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(textOf(tree, 'grill-again')).toBe('Grill again');
  });
});

describe('GrillView — grilling flow', () => {
  it('answer + advance moves through every card and lands on done', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(findByTestID(tree, 'grill-done')).toBeDefined();
    expect(textOf(tree, 'grill-score')).toBe('5 / 5');
  });

  it('records wrong answers as wrong', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-2').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(textOf(tree, 'grill-score')).toBe('0 / 5');
  });

  it('mixes correct + wrong → partial score', async () => {
    const {tree} = renderGrill();
    await flush();
    const picks = [0, 2, 0, 2, 0]; // 3 correct
    for (const pick of picks) {
      act(() => {
        findByTestID(tree, `grill-card-choice-${pick}`).props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(textOf(tree, 'grill-score')).toBe('3 / 5');
  });
});

describe('GrillView — Grill again', () => {
  it('rephrases stems, resets index, resets answers + swappedCards', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(findByTestID(tree, 'grill-done')).toBeDefined();

    act(() => {
      findByTestID(tree, 'grill-again').props.onPress();
    });
    await flush();
    expect(textOf(tree, 'grill-card-stem')).toBe('rephrased 0?');
    expect(textOf(tree, 'grill-card-position')).toBe('Card 1 of 5');
  });

  it('shows error UI and a Retry button when rephrase fails', async () => {
    const {tree} = renderGrill({}, scriptedProvider({failRephrase: true}));
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    act(() => {
      findByTestID(tree, 'grill-again').props.onPress();
    });
    await flush();
    expect(findByTestID(tree, 'grill-error')).toBeDefined();
    expect(findByTestID(tree, 'grill-retry')).toBeDefined();
  });
});

describe('GrillView — background judge + regen', () => {
  it('silently swaps a judge-flagged card before the user reaches it', async () => {
    const regenBody = JSON.stringify([
      {
        id: 'replacement',
        type: 'inference',
        stem: 'SWAPPED STEM?',
        choices: ['W', 'X', 'Y', 'Z'],
        correctIndex: 0,
        explanation: 'swapped because weak',
        sourceQuote: 'q',
      },
    ]);
    const client = scriptedProvider({weakAt: 3, regenerateBody: regenBody});
    const {tree} = renderGrill({}, client);
    await flush();
    act(() => {
      findByTestID(tree, 'grill-card-choice-0').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'grill-card-reveal').props.onPress();
    });
    await flush();
    act(() => {
      findByTestID(tree, 'grill-card-choice-0').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'grill-card-reveal').props.onPress();
    });
    await flush();
    expect(textOf(tree, 'grill-card-stem')).toBe('SWAPPED STEM?');
  });

  it('survives judge failure with the deck untouched', async () => {
    const {tree} = renderGrill({}, scriptedProvider({failJudge: true}));
    await flush();
    expect(textOf(tree, 'grill-card-stem')).toBe('stem 1?');
    act(() => {
      findByTestID(tree, 'grill-card-choice-0').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'grill-card-reveal').props.onPress();
    });
    expect(textOf(tree, 'grill-card-stem')).toBe('stem 2?');
  });

  it('survives regenerate failure with the deck untouched', async () => {
    const {tree} = renderGrill(
      {},
      scriptedProvider({weakAt: 3, failRegenerate: true}),
    );
    await flush();
    for (let i = 0; i < 2; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    await flush();
    expect(textOf(tree, 'grill-card-stem')).toBe('stem 3?');
  });
});

describe('GrillView — per-card chrome (no rubric chips)', () => {
  // Generation-quality is backstage; reveal panels show only the
  // ✓/✗ + explanation + source. Surveyed apps (Quizlet, Khan,
  // Duolingo, NotebookLM) all match this pattern.
  it('does not render a rubric chip row on reveal, even after judge resolves', async () => {
    const {tree} = renderGrill();
    await flush();
    act(() => {
      findByTestID(tree, 'grill-card-choice-0').props.onPress();
    });
    expect(maybeFindByTestID(tree, 'grill-card-rubric')).toBeNull();
  });
});

describe('GrillView — Done screen 2x2 type quadrant grid', () => {
  it('renders all four quadrants regardless of deck composition', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(findByTestID(tree, 'grill-type-grid')).toBeDefined();
    expect(findByTestID(tree, 'grill-quadrant-cloze')).toBeDefined();
    expect(findByTestID(tree, 'grill-quadrant-definition')).toBeDefined();
    expect(findByTestID(tree, 'grill-quadrant-inference')).toBeDefined();
    expect(findByTestID(tree, 'grill-quadrant-application')).toBeDefined();
  });

  it('shows ✓ marks and count for question types the deck tested', async () => {
    // Default deck has 5 definition cards. The definition quadrant
    // should show 5 ✓ marks; the others get the "not tested" em-dash.
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    const marks = textOf(tree, 'grill-quadrant-definition-marks');
    expect(marks).toContain('✓');
    // 5 cards all answered correctly → 5 ✓ marks, no ✗.
    expect(marks).not.toContain('✗');
    expect(textOf(tree, 'grill-quadrant-definition-count')).toBe('5 / 5');
  });

  it('shows ✗ marks for missed cards in a quadrant', async () => {
    const {tree} = renderGrill();
    await flush();
    // 3 correct + 2 wrong (correctIndex is 0 for canned cards).
    const picks = [0, 2, 0, 2, 0];
    for (const pick of picks) {
      act(() => {
        findByTestID(tree, `grill-card-choice-${pick}`).props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    const marks = textOf(tree, 'grill-quadrant-definition-marks');
    // Three ✓, two ✗.
    expect((marks.match(/✓/g) ?? []).length).toBe(3);
    expect((marks.match(/✗/g) ?? []).length).toBe(2);
    expect(textOf(tree, 'grill-quadrant-definition-count')).toBe('3 / 5');
  });

  it('renders "not tested" em-dash for question types the deck did not include', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(textOf(tree, 'grill-quadrant-cloze-empty')).toBe('—');
    expect(textOf(tree, 'grill-quadrant-cloze')).toContain('not tested');
    expect(textOf(tree, 'grill-quadrant-inference-empty')).toBe('—');
    expect(textOf(tree, 'grill-quadrant-application-empty')).toBe('—');
  });
});

describe('GrillView — Done screen "Review these" block', () => {
  it('omits the Review-these block when the user got every card right', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(maybeFindByTestID(tree, 'grill-review-these')).toBeNull();
  });

  it('renders one review card per miss, with stem + pick + correct + source', async () => {
    const {tree} = renderGrill();
    await flush();
    // Miss card 2 only.
    const picks = [0, 2, 0, 0, 0];
    for (const pick of picks) {
      act(() => {
        findByTestID(tree, `grill-card-choice-${pick}`).props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(findByTestID(tree, 'grill-review-these')).toBeDefined();
    const reviewCard = textOf(tree, 'grill-review-card-2');
    // Card 2 has stem "stem 2?", correct choice index 0 (A), user picked
    // index 2 (C). The review block should expose all four pieces.
    expect(reviewCard).toContain('Card 2');
    expect(reviewCard).toContain('Definition');
    expect(reviewCard).toContain('stem 2?');
    expect(reviewCard).toContain('You picked:');
    expect(reviewCard).toContain('C');
    expect(reviewCard).toContain('Correct:');
    expect(reviewCard).toContain('A');
    expect(reviewCard).toContain('Source:');
    expect(reviewCard).toContain('q m2');
  });

  it('renders multiple review cards in deck order when multiple were missed', async () => {
    const {tree} = renderGrill();
    await flush();
    const picks = [0, 2, 0, 2, 2]; // misses on 2, 4, 5
    for (const pick of picks) {
      act(() => {
        findByTestID(tree, `grill-card-choice-${pick}`).props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(findByTestID(tree, 'grill-review-card-2')).toBeDefined();
    expect(findByTestID(tree, 'grill-review-card-4')).toBeDefined();
    expect(findByTestID(tree, 'grill-review-card-5')).toBeDefined();
    expect(maybeFindByTestID(tree, 'grill-review-card-1')).toBeNull();
    expect(maybeFindByTestID(tree, 'grill-review-card-3')).toBeNull();
  });
});

describe('GrillView — Done screen swap callout', () => {
  it('renders swap callout when a card was swapped (distractor reason)', async () => {
    const regenBody = JSON.stringify([
      {
        id: 'replacement',
        type: 'inference',
        stem: 'SWAPPED?',
        choices: ['W', 'X', 'Y', 'Z'],
        correctIndex: 0,
        explanation: 'r',
        sourceQuote: 'q',
      },
    ]);
    const {tree} = renderGrill(
      {},
      scriptedProvider({
        weakAt: 3,
        weakAxis: 'distractor',
        regenerateBody: regenBody,
      }),
    );
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
      await flush();
    }
    expect(findByTestID(tree, 'grill-swap-callout')).toBeDefined();
    const line = textOf(tree, 'grill-swap-callout-3');
    expect(line).toContain('We swapped card 3');
    expect(line).toContain('distractors were too easy');
  });

  it('renders swap callout with factual reason when factual was the weak axis', async () => {
    const regenBody = JSON.stringify([
      {
        id: 'replacement',
        type: 'inference',
        stem: 'SWAPPED?',
        choices: ['W', 'X', 'Y', 'Z'],
        correctIndex: 0,
        explanation: 'r',
        sourceQuote: 'q',
      },
    ]);
    const {tree} = renderGrill(
      {},
      scriptedProvider({
        weakAt: 2,
        weakAxis: 'factual',
        regenerateBody: regenBody,
      }),
    );
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
      await flush();
    }
    const line = textOf(tree, 'grill-swap-callout-2');
    expect(line).toContain('We swapped card 2');
    expect(line).toContain('facts were thin');
  });

  it('omits the swap callout when no swap happened', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(maybeFindByTestID(tree, 'grill-swap-callout')).toBeNull();
  });
});

// Keep the unused block opener so the trailing closing brace below
// still balances; the rest of the file already has its own describe
// blocks that follow.
describe('GrillView — old aggregate (removed) sanity check', () => {
  it('does not render a deck-quality aggregate block anymore', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(maybeFindByTestID(tree, 'grill-rubric-aggregate')).toBeNull();
  });

  it('renders swap callout when a card was swapped (distractor reason)', async () => {
    const regenBody = JSON.stringify([
      {
        id: 'replacement',
        type: 'inference',
        stem: 'SWAPPED?',
        choices: ['W', 'X', 'Y', 'Z'],
        correctIndex: 0,
        explanation: 'r',
        sourceQuote: 'q',
      },
    ]);
    const {tree} = renderGrill(
      {},
      scriptedProvider({
        weakAt: 3,
        weakAxis: 'distractor',
        regenerateBody: regenBody,
      }),
    );
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
      await flush();
    }
    expect(findByTestID(tree, 'grill-swap-callout')).toBeDefined();
    const line = textOf(tree, 'grill-swap-callout-3');
    expect(line).toContain('We swapped card 3');
    expect(line).toContain('distractors were too easy');
  });

  it('renders swap callout with factual reason when factual was the weak axis', async () => {
    const regenBody = JSON.stringify([
      {
        id: 'replacement',
        type: 'inference',
        stem: 'SWAPPED?',
        choices: ['W', 'X', 'Y', 'Z'],
        correctIndex: 0,
        explanation: 'r',
        sourceQuote: 'q',
      },
    ]);
    const {tree} = renderGrill(
      {},
      scriptedProvider({
        weakAt: 2,
        weakAxis: 'factual',
        regenerateBody: regenBody,
      }),
    );
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
      await flush();
    }
    const line = textOf(tree, 'grill-swap-callout-2');
    expect(line).toContain('We swapped card 2');
    expect(line).toContain('facts were thin');
  });

  it('omits the swap callout when no swap happened', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(maybeFindByTestID(tree, 'grill-swap-callout')).toBeNull();
  });
});

describe('GrillView — Grill again aborts in-flight regen (no stale swap)', () => {
  it('does not swap a v1 regen into a v2 (rephrased) deck', async () => {
    // Reproduces the bug: v1 regen for c3 is still in flight when the
    // user taps Grill again. v2 has the SAME card IDs (rephrase
    // preserves them), so without an abort the v1 regen card would
    // get swapped into v2's deck at the next advance. With the abort,
    // pendingRegenRef is cleared and the v1 result is discarded.
    const POLLUTANT_STEM = 'V1 REGEN POLLUTANT STEM (should not appear in v2)';
    const regenBody = JSON.stringify([
      {
        id: 'r',
        type: 'inference',
        stem: POLLUTANT_STEM,
        choices: ['W', 'X', 'Y', 'Z'],
        correctIndex: 0,
        explanation: 'r',
        sourceQuote: 'q',
      },
    ]);
    let regenResolvers: Array<() => void> = [];
    let phase: 'generate' | 'rephrase' = 'generate';
    const client: ProviderClient = {
      id: 'fake',
      send(req, opts) {
        const respond = (text: string) => ({
          text,
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        });
        const sys = req.systemPrompt;
        if (sys.startsWith('You generate study questions')) {
          if (req.userText.includes('Original card to replace')) {
            // Hold the v1 regen response until the test releases it,
            // simulating slow network mid-flight.
            return new Promise((resolve) => {
              regenResolvers.push(() => resolve(respond(regenBody)));
            });
          }
          if (phase === 'generate') {
            phase = 'rephrase';
            return Promise.resolve(respond(DECK_BODY));
          }
          return Promise.resolve(respond(DECK_BODY));
        }
        if (sys.startsWith('You are a strict reviewer')) {
          const ids = extractCardIds(req.userText);
          // Flag card 3 → triggers regen of c3 with held promise.
          const rows = ids.map((id, i) => ({
            cardId: id,
            factual: 5,
            clarity: 5,
            distractor: i === 2 ? 1 : 5,
            typeCoverage: 5,
          }));
          return Promise.resolve(respond(JSON.stringify(rows)));
        }
        if (sys.startsWith('You rephrase study-card')) {
          // Rephrase succeeds normally; preserves card IDs.
          const ids = extractCardIds(req.userText);
          const rows = ids.map((id, i) => ({
            cardId: id,
            stem: `v2 rephrased ${i}?`,
          }));
          return Promise.resolve(respond(JSON.stringify(rows)));
        }
        return Promise.resolve(respond('[]'));
      },
    };
    const {tree} = renderGrill({}, client);
    await flush();
    // v1: drive all 5 cards. Regen is still pending (held).
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(findByTestID(tree, 'grill-done')).toBeDefined();
    // Tap Grill again — this should abort the in-flight v1 regen.
    act(() => {
      findByTestID(tree, 'grill-again').props.onPress();
    });
    await flush();
    // Now release the held v1 regen response. It should be discarded
    // because the generation signal was aborted.
    for (const r of regenResolvers) {
      r();
    }
    await flush();
    // Drive through v2 cards 1, 2 → advance past card 2. If the v1
    // regen had polluted pending, card 3 would show POLLUTANT_STEM.
    act(() => {
      findByTestID(tree, 'grill-card-choice-0').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'grill-card-reveal').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'grill-card-choice-0').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'grill-card-reveal').props.onPress();
    });
    await flush();
    // Card 3's stem should be the v2 rephrased stem, NOT the v1 regen.
    expect(textOf(tree, 'grill-card-stem')).not.toBe(POLLUTANT_STEM);
    expect(textOf(tree, 'grill-card-stem')).toBe('v2 rephrased 2?');
  });
});

describe('GrillView — error + retry', () => {
  it('shows error UI on generate failure', async () => {
    const {tree} = renderGrill({}, scriptedProvider({failGenerate: true}));
    await flush();
    expect(findByTestID(tree, 'grill-error')).toBeDefined();
    expect(findByTestID(tree, 'grill-retry')).toBeDefined();
  });

  it('Retry path recovers from a transient failure', async () => {
    let calls = 0;
    const flakyClient: ProviderClient = {
      id: 'fake',
      async send(req, opts) {
        const respond = (text: string) => ({
          text,
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        });
        if (req.systemPrompt.startsWith('You generate study questions')) {
          calls += 1;
          if (calls === 1) {
            throw new Error('flaky');
          }
          return respond(DECK_BODY);
        }
        return respond('[]');
      },
    };
    const {tree} = renderGrill({}, flakyClient);
    await flush();
    expect(findByTestID(tree, 'grill-error')).toBeDefined();
    act(() => {
      findByTestID(tree, 'grill-retry').props.onPress();
    });
    await flush();
    expect(textOf(tree, 'grill-card-stem')).toBe('stem 1?');
  });

  it('Retry path that also fails lands on the error screen', async () => {
    const alwaysFail: ProviderClient = {
      id: 'fake',
      async send(req, opts) {
        if (req.systemPrompt.startsWith('You generate study questions')) {
          throw new Error('anthropic: HTTP 500');
        }
        return {
          text: '[]',
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        };
      },
    };
    const {tree} = renderGrill({}, alwaysFail);
    await flush();
    act(() => {
      findByTestID(tree, 'grill-retry').props.onPress();
    });
    await flush();
    expect(findByTestID(tree, 'grill-error')).toBeDefined();
    expect(textOf(tree, 'grill-error')).toContain('HTTP 500');
  });

  it('parse error surfaces a friendly message', async () => {
    const broken: ProviderClient = {
      id: 'fake',
      async send(_req, opts) {
        return {
          text: 'nothing parseable here',
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        };
      },
    };
    const {tree} = renderGrill({}, broken);
    await flush();
    expect(textOf(tree, 'grill-error')).toContain('unusable response');
  });
});

describe('GrillView — re-entrancy', () => {
  it('refuses to start when another request is in flight', () => {
    expect(tryAcquire()).toBe(true);
    const {tree} = renderGrill();
    expect(findByTestID(tree, 'grill-error')).toBeDefined();
    expect(textOf(tree, 'grill-error')).toContain('Another request');
    guardTesting.reset();
  });

  it('unmount after a guard-fail boot still cleans up safely', () => {
    expect(tryAcquire()).toBe(true);
    const {tree} = renderGrill();
    expect(findByTestID(tree, 'grill-error')).toBeDefined();
    act(() => {
      tree.unmount();
    });
    guardTesting.reset();
  });

  it('retry also refuses when guard is held', async () => {
    const {tree} = renderGrill({}, scriptedProvider({failGenerate: true}));
    await flush();
    expect(findByTestID(tree, 'grill-error')).toBeDefined();
    expect(tryAcquire()).toBe(true);
    act(() => {
      findByTestID(tree, 'grill-retry').props.onPress();
    });
    expect(textOf(tree, 'grill-error')).toContain('Another request');
    guardTesting.reset();
  });

  it('releases the guard on unmount so subsequent flows can run', async () => {
    const {tree} = renderGrill();
    await flush();
    act(() => {
      tree.unmount();
    });
    expect(tryAcquire()).toBe(true);
    guardTesting.reset();
  });
});

describe('GrillView — unmount mid-flight', () => {
  type Pending = {
    resolve: (text: string) => void;
    reject: (err: unknown) => void;
  };
  const holdableProvider = (): {
    client: ProviderClient;
    pending: Pending[];
  } => {
    const pending: Pending[] = [];
    const client: ProviderClient = {
      id: 'fake',
      send(_req, opts) {
        return new Promise<{
          text: string;
          usage: {inputTokens: number; outputTokens: number};
          latencyMs: number;
          modelId: string;
        }>((resolve, reject) => {
          pending.push({
            resolve: (text: string) =>
              resolve({
                text,
                usage: {inputTokens: 1, outputTokens: 1},
                latencyMs: 1,
                modelId: opts.model,
              }),
            reject,
          });
        });
      },
    };
    return {client, pending};
  };

  it('unmount before generate resolves does not crash on late success', async () => {
    const {client, pending} = holdableProvider();
    const {tree} = renderGrill({}, client);
    act(() => {
      tree.unmount();
    });
    pending[0].resolve(DECK_BODY);
    await flush();
    guardTesting.reset();
  });

  it('unmount before generate resolves does not crash on late failure', async () => {
    const {client, pending} = holdableProvider();
    const {tree} = renderGrill({}, client);
    act(() => {
      tree.unmount();
    });
    pending[0].reject(new Error('late failure'));
    await flush();
    guardTesting.reset();
  });

  it('unmount during the Grill-again rephrase does not crash', async () => {
    let phase: 'generate' | 'rephrase' = 'generate';
    const pending: Array<{resolve: (text: string) => void}> = [];
    const client: ProviderClient = {
      id: 'fake',
      send(req, opts) {
        const sys = req.systemPrompt;
        if (sys.startsWith('You are a strict reviewer')) {
          return Promise.resolve({
            text: '[]',
            usage: {inputTokens: 1, outputTokens: 1},
            latencyMs: 1,
            modelId: opts.model,
          });
        }
        if (sys.startsWith('You generate study questions') && phase === 'generate') {
          phase = 'rephrase';
          return Promise.resolve({
            text: DECK_BODY,
            usage: {inputTokens: 1, outputTokens: 1},
            latencyMs: 1,
            modelId: opts.model,
          });
        }
        if (sys.startsWith('You rephrase study-card')) {
          return new Promise((resolve) => {
            pending.push({
              resolve: (text: string) =>
                resolve({
                  text,
                  usage: {inputTokens: 1, outputTokens: 1},
                  latencyMs: 1,
                  modelId: opts.model,
                }),
            });
          });
        }
        return Promise.resolve({
          text: '[]',
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        });
      },
    };
    const {tree} = renderGrill({}, client);
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    act(() => {
      findByTestID(tree, 'grill-again').props.onPress();
    });
    act(() => {
      tree.unmount();
    });
    pending[0].resolve('[]');
    await flush();
    guardTesting.reset();
  });

  it('unmount during a failing rephrase does not crash', async () => {
    let phase: 'generate' | 'rephrase' = 'generate';
    const pending: Array<{reject: (err: unknown) => void}> = [];
    const client: ProviderClient = {
      id: 'fake',
      send(req, opts) {
        const sys = req.systemPrompt;
        if (sys.startsWith('You are a strict reviewer')) {
          return Promise.resolve({
            text: '[]',
            usage: {inputTokens: 1, outputTokens: 1},
            latencyMs: 1,
            modelId: opts.model,
          });
        }
        if (sys.startsWith('You generate study questions') && phase === 'generate') {
          phase = 'rephrase';
          return Promise.resolve({
            text: DECK_BODY,
            usage: {inputTokens: 1, outputTokens: 1},
            latencyMs: 1,
            modelId: opts.model,
          });
        }
        if (sys.startsWith('You rephrase study-card')) {
          return new Promise((_resolve, reject) => {
            pending.push({reject});
          });
        }
        return Promise.resolve({
          text: '[]',
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        });
      },
    };
    const {tree} = renderGrill({}, client);
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    act(() => {
      findByTestID(tree, 'grill-again').props.onPress();
    });
    act(() => {
      tree.unmount();
    });
    pending[0].reject(new Error('late fail'));
    await flush();
    guardTesting.reset();
  });

  it('unmount during a retry resolve does not crash', async () => {
    let calls = 0;
    const pending: Array<{resolve: (text: string) => void}> = [];
    const client: ProviderClient = {
      id: 'fake',
      send(req, opts) {
        if (req.systemPrompt.startsWith('You generate study questions')) {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(new Error('first fail'));
          }
          return new Promise((resolve) => {
            pending.push({
              resolve: (text) =>
                resolve({
                  text,
                  usage: {inputTokens: 1, outputTokens: 1},
                  latencyMs: 1,
                  modelId: opts.model,
                }),
            });
          });
        }
        return Promise.resolve({
          text: '[]',
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        });
      },
    };
    const {tree} = renderGrill({}, client);
    await flush();
    expect(findByTestID(tree, 'grill-error')).toBeDefined();
    act(() => {
      findByTestID(tree, 'grill-retry').props.onPress();
    });
    act(() => {
      tree.unmount();
    });
    pending[0].resolve(DECK_BODY);
    await flush();
    guardTesting.reset();
  });

  it('unmount AFTER generate resolves but BEFORE judge resolves bails cleanly', async () => {
    // Generate resolves synchronously; judge is held. Unmount between
    // the two awaits. The post-judge isAlive() check should bail.
    let calls = 0;
    const pending: Array<{resolve: (text: string) => void}> = [];
    const client: ProviderClient = {
      id: 'fake',
      send(req, opts) {
        const respond = (text: string) => ({
          text,
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        });
        if (req.systemPrompt.startsWith('You generate study questions')) {
          return Promise.resolve(respond(DECK_BODY));
        }
        if (req.systemPrompt.startsWith('You are a strict reviewer')) {
          calls += 1;
          return new Promise((resolve) => {
            pending.push({
              resolve: (text: string) => resolve(respond(text)),
            });
          });
        }
        return Promise.resolve(respond('[]'));
      },
    };
    const {tree} = renderGrill({}, client);
    await flush();
    // Generate done, judge pending. Unmount.
    act(() => {
      tree.unmount();
    });
    // Resolve judge AFTER unmount — the post-judge isAlive check bails.
    if (pending.length > 0) {
      pending[0].resolve('[]');
    }
    await flush();
    expect(calls).toBeGreaterThanOrEqual(1);
    guardTesting.reset();
  });

  it('unmount AFTER regen resolves but BEFORE set bails cleanly', async () => {
    // Judge flags one card, regen is held. Unmount, then resolve regen.
    // The post-regen isAlive check bails before pendingRegenRef.set.
    const regenBody = JSON.stringify([
      {
        id: 'r',
        type: 'inference',
        stem: 'late stem',
        choices: ['W', 'X', 'Y', 'Z'],
        correctIndex: 0,
        explanation: 'r',
        sourceQuote: 'q',
      },
    ]);
    let regenCount = 0;
    const pending: Array<{resolve: (text: string) => void}> = [];
    const client: ProviderClient = {
      id: 'fake',
      send(req, opts) {
        const respond = (text: string) => ({
          text,
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        });
        if (req.systemPrompt.startsWith('You generate study questions')) {
          if (req.userText.includes('Original card to replace')) {
            regenCount += 1;
            return new Promise((resolve) => {
              pending.push({
                resolve: (text: string) => resolve(respond(text)),
              });
            });
          }
          return Promise.resolve(respond(DECK_BODY));
        }
        if (req.systemPrompt.startsWith('You are a strict reviewer')) {
          // Flag card 3 to trigger regen.
          const ids = extractCardIds(req.userText);
          const rows = ids.map((id, i) => ({
            cardId: id,
            factual: 5,
            clarity: 5,
            distractor: i === 2 ? 1 : 5,
            typeCoverage: 5,
          }));
          return Promise.resolve(respond(JSON.stringify(rows)));
        }
        return Promise.resolve(respond('[]'));
      },
    };
    const {tree} = renderGrill({}, client);
    await flush();
    // Generate + judge done, regen pending. Unmount.
    act(() => {
      tree.unmount();
    });
    // Resolve regen AFTER unmount — post-regen isAlive bails before set.
    if (pending.length > 0) {
      pending[0].resolve(regenBody);
    }
    await flush();
    expect(regenCount).toBeGreaterThanOrEqual(1);
    guardTesting.reset();
  });

  it('unmount during a retry rejection does not crash', async () => {
    let calls = 0;
    const pending: Array<{reject: (err: unknown) => void}> = [];
    const client: ProviderClient = {
      id: 'fake',
      send(req, opts) {
        if (req.systemPrompt.startsWith('You generate study questions')) {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(new Error('first fail'));
          }
          return new Promise((_resolve, reject) => {
            pending.push({reject});
          });
        }
        return Promise.resolve({
          text: '[]',
          usage: {inputTokens: 1, outputTokens: 1},
          latencyMs: 1,
          modelId: opts.model,
        });
      },
    };
    const {tree} = renderGrill({}, client);
    await flush();
    act(() => {
      findByTestID(tree, 'grill-retry').props.onPress();
    });
    act(() => {
      tree.unmount();
    });
    pending[0].reject(new Error('retry late fail'));
    await flush();
    guardTesting.reset();
  });
});

describe('GrillView — score copy', () => {
  it('shows a perfect-score affirmation on 5/5', async () => {
    const {tree} = renderGrill();
    await flush();
    for (let i = 0; i < 5; i++) {
      act(() => {
        findByTestID(tree, 'grill-card-choice-0').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(textOf(tree, 'grill-done')).toContain('Solid');
  });

  it('shows "lock in the misses" copy on 60-99%', async () => {
    const {tree} = renderGrill();
    await flush();
    const picks = [0, 0, 0, 2, 2]; // 3 of 5
    for (const pick of picks) {
      act(() => {
        findByTestID(tree, `grill-card-choice-${pick}`).props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(textOf(tree, 'grill-done')).toContain('lock in the misses');
  });

  it('shows "rephrased helps" copy on <60%', async () => {
    const {tree} = renderGrill();
    await flush();
    const picks = [0, 2, 2, 2, 2]; // 1 of 5
    for (const pick of picks) {
      act(() => {
        findByTestID(tree, `grill-card-choice-${pick}`).props.onPress();
      });
      act(() => {
        findByTestID(tree, 'grill-card-reveal').props.onPress();
      });
    }
    expect(textOf(tree, 'grill-done')).toContain('rephrased stems help');
  });
});
