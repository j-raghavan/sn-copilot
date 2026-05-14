/**
 * Tests for src/ui/GrillCard. Pins the single-surface interaction
 * model:
 *   - Unanswered: stem + 4 choices, no reveal panel
 *   - Tap a choice → onAnswer(idx); choices then disabled; reveal
 *     panel appears showing explanation + verdict
 *   - Tap reveal panel → onAdvance
 *   - Empty sourceQuote → no source row rendered
 *   - "Tap to continue →" vs "Tap to see results →" on last card
 *   - No deck-quality rubric chrome on the card itself
 */
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import GrillCard from '../src/ui/GrillCard';
import type {Card, CardChoiceIndex} from '../src/grill/deckTypes';
import {
  findByTestID,
  maybeFindByTestID,
  textOf,
} from './helpers/textTraversal';

const baseCard: Card = {
  id: 'card-x',
  type: 'definition',
  stem: 'What is photosynthesis?',
  choices: [
    'Conversion of light to chemical energy',
    'Cellular respiration in animals',
    'Water absorption through roots only',
    'Breakdown of sugars in mitochondria',
  ] as const,
  correctIndex: 0,
  explanation: 'Plants convert light energy via chlorophyll.',
  sourceQuote: 'Photosynthesis is the conversion of light energy.',
};

function render(
  overrides: Partial<React.ComponentProps<typeof GrillCard>> = {},
): {
  tree: ReactTestRenderer;
  onAnswer: jest.Mock;
  onAdvance: jest.Mock;
} {
  const onAnswer = jest.fn();
  const onAdvance = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <GrillCard
        card={baseCard}
        selected={null}
        position={1}
        total={5}
        onAnswer={onAnswer}
        onAdvance={onAdvance}
        {...overrides}
      />,
    );
  });
  return {tree, onAnswer, onAdvance};
}

describe('GrillCard — question state', () => {
  it('renders stem, 4 choices, and position header', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'grill-card-card-x')).toBeDefined();
    expect(textOf(tree, 'grill-card-stem')).toBe('What is photosynthesis?');
    expect(textOf(tree, 'grill-card-position')).toBe('Card 1 of 5');
    expect(findByTestID(tree, 'grill-card-choice-0')).toBeDefined();
    expect(findByTestID(tree, 'grill-card-choice-3')).toBeDefined();
  });

  it('reveal panel is hidden until a choice is selected', () => {
    const {tree} = render();
    expect(maybeFindByTestID(tree, 'grill-card-reveal')).toBeNull();
  });

  it('choices are enabled (not disabled)', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'grill-card-choice-0').props.disabled).toBe(
      false,
    );
  });

  it('tap fires onAnswer with the chosen index', () => {
    const {tree, onAnswer} = render();
    act(() => {
      findByTestID(tree, 'grill-card-choice-2').props.onPress();
    });
    expect(onAnswer).toHaveBeenCalledWith(2);
  });

  it('no markers visible before answering', () => {
    const {tree} = render();
    expect(maybeFindByTestID(tree, 'grill-card-marker-0')).toBeNull();
    expect(maybeFindByTestID(tree, 'grill-card-marker-3')).toBeNull();
  });
});

describe('GrillCard — revealed state (correct answer)', () => {
  it('shows the verdict + explanation + source quote on a right answer', () => {
    const {tree} = render({selected: 0});
    expect(findByTestID(tree, 'grill-card-reveal')).toBeDefined();
    expect(textOf(tree, 'grill-card-verdict')).toBe('Correct');
    expect(textOf(tree, 'grill-card-explanation')).toContain(
      'Plants convert light energy',
    );
    expect(textOf(tree, 'grill-card-source')).toContain(
      'Photosynthesis is the conversion',
    );
  });

  it('marks the correct choice with ✓', () => {
    const {tree} = render({selected: 0});
    expect(textOf(tree, 'grill-card-marker-0')).toBe('✓');
  });

  it('all choices are disabled after answering', () => {
    const {tree} = render({selected: 0});
    for (let i = 0; i < 4; i++) {
      expect(
        findByTestID(tree, `grill-card-choice-${i}`).props.disabled,
      ).toBe(true);
    }
  });

  it('tapping the reveal panel fires onAdvance', () => {
    const {tree, onAdvance} = render({selected: 0});
    act(() => {
      findByTestID(tree, 'grill-card-reveal').props.onPress();
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});

describe('GrillCard — revealed state (wrong answer)', () => {
  it('shows "Not quite" as verdict', () => {
    const {tree} = render({selected: 2});
    expect(textOf(tree, 'grill-card-verdict')).toBe('Not quite');
  });

  it('marks the selected wrong choice with ✗ AND reveals correct with ✓', () => {
    const {tree} = render({selected: 2});
    expect(textOf(tree, 'grill-card-marker-2')).toBe('✗');
    expect(textOf(tree, 'grill-card-marker-0')).toBe('✓');
  });

  it('does NOT mark unselected non-correct choices', () => {
    const {tree} = render({selected: 2});
    expect(maybeFindByTestID(tree, 'grill-card-marker-1')).toBeNull();
    expect(maybeFindByTestID(tree, 'grill-card-marker-3')).toBeNull();
  });
});

describe('GrillCard — advance hint copy', () => {
  it('shows "Tap to continue" on a non-final card', () => {
    const {tree} = render({selected: 0, position: 2, total: 5});
    const text = textOf(tree, 'grill-card-reveal');
    expect(text).toContain('Tap to continue');
  });

  it('shows "Tap to see results" on the FINAL card', () => {
    const {tree} = render({selected: 0, position: 5, total: 5});
    const text = textOf(tree, 'grill-card-reveal');
    expect(text).toContain('Tap to see results');
  });
});

describe('GrillCard — empty sourceQuote', () => {
  it('omits the source row when sourceQuote is empty', () => {
    const cardNoSource: Card = {...baseCard, sourceQuote: ''};
    const {tree} = render({card: cardNoSource, selected: 0});
    expect(maybeFindByTestID(tree, 'grill-card-source')).toBeNull();
  });

  it('still shows explanation when source is empty', () => {
    const cardNoSource: Card = {...baseCard, sourceQuote: ''};
    const {tree} = render({card: cardNoSource, selected: 0});
    expect(textOf(tree, 'grill-card-explanation')).toContain(
      'Plants convert light energy',
    );
  });
});

describe('GrillCard — every correctIndex value renders cleanly', () => {
  it.each([0, 1, 2, 3] as CardChoiceIndex[])(
    'correctIndex=%i puts ✓ on the right choice on a right answer',
    (idx) => {
      const card: Card = {...baseCard, correctIndex: idx};
      const {tree} = render({card, selected: idx});
      expect(textOf(tree, `grill-card-marker-${idx}`)).toBe('✓');
    },
  );
});

describe('GrillCard — no deck-quality chrome', () => {
  // The chip row was dropped in favor of treating generation quality
  // as backstage telemetry (matches Quizlet / Khan / Duolingo /
  // NotebookLM patterns). The card's reveal panel shows the ✓/✗ +
  // explanation + source quote — and nothing else.
  it('does not render a per-card rubric chip row', () => {
    const {tree} = render({selected: 0});
    expect(maybeFindByTestID(tree, 'grill-card-rubric')).toBeNull();
  });
});
