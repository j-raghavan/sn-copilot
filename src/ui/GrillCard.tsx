// Single grill card — pure presentational. Owns no state of its own.
// Two display modes driven by props:
//
//   selected === null  → "question"  : show stem + 4 tappable choices
//   selected !== null  → "revealed"  : choices disabled with correct/
//                                      wrong markers; explanation +
//                                      source quote become the "tap
//                                      to advance" surface
//
// This is the entire interaction surface for a card. No Next button,
// no menus, no sub-screens. Tapping the reveal panel fires onAdvance.
//
// The ✓/✗ markers plus the explanation + source quote already convey
// everything a learner needs about this card. The deck-quality
// rubric is intentionally NOT shown here — it's a backstage signal
// that drives the auto-regen of weak cards (see GrillView). Surveyed
// learning apps (Quizlet, Khan, Duolingo, NotebookLM) all treat
// question-generation quality as telemetry, not chrome.

import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import type {Card, CardChoiceIndex} from '../grill/deckTypes';

export type GrillCardProps = {
  card: Card;
  selected: CardChoiceIndex | null;
  position: number;
  total: number;
  onAnswer: (index: CardChoiceIndex) => void;
  onAdvance: () => void;
};

const CHOICE_LETTERS = ['A', 'B', 'C', 'D'] as const;

const isCorrect = (selected: CardChoiceIndex | null, card: Card): boolean =>
  selected !== null && selected === card.correctIndex;

export default function GrillCard(props: GrillCardProps): React.JSX.Element {
  const {card, selected, position, total, onAnswer, onAdvance} = props;
  const answered = selected !== null;
  const correct = isCorrect(selected, card);

  return (
    <View testID={`grill-card-${card.id}`} style={styles.root}>
      <Text testID="grill-card-position" style={styles.position}>
        {`Card ${position} of ${total}`}
      </Text>
      <Text testID="grill-card-stem" style={styles.stem}>
        {card.stem}
      </Text>
      <View style={styles.choices}>
        {card.choices.map((choice, idx) => {
          const isThisCorrect = idx === card.correctIndex;
          const isThisSelected = selected === idx;
          const choiceStyle = [
            styles.choice,
            answered && isThisSelected && isThisCorrect && styles.choiceRight,
            answered && isThisSelected && !isThisCorrect && styles.choiceWrong,
            answered && !isThisSelected && isThisCorrect && styles.choiceReveal,
          ];
          const marker = answered
            ? isThisCorrect
              ? '✓'
              : isThisSelected
              ? '✗'
              : ''
            : '';
          return (
            <TouchableOpacity
              key={idx}
              testID={`grill-card-choice-${idx}`}
              accessibilityLabel={`Choice ${CHOICE_LETTERS[idx]}`}
              onPress={() => onAnswer(idx as CardChoiceIndex)}
              disabled={answered}
              style={choiceStyle}>
              <Text style={styles.choiceLetter}>{CHOICE_LETTERS[idx]}</Text>
              <Text style={styles.choiceText}>{choice}</Text>
              {marker.length > 0 ? (
                <Text testID={`grill-card-marker-${idx}`} style={styles.choiceMarker}>
                  {marker}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>
      {answered ? (
        <TouchableOpacity
          testID="grill-card-reveal"
          accessibilityLabel="Tap to continue"
          onPress={onAdvance}
          style={styles.reveal}>
          <Text testID="grill-card-verdict" style={styles.verdict}>
            {correct ? 'Correct' : 'Not quite'}
          </Text>
          <Text testID="grill-card-explanation" style={styles.explanation}>
            {card.explanation}
          </Text>
          {card.sourceQuote.length > 0 ? (
            <Text testID="grill-card-source" style={styles.source}>
              {`Source: ${card.sourceQuote}`}
            </Text>
          ) : null}
          <Text style={styles.advanceHint}>
            {position < total ? 'Tap to continue →' : 'Tap to see results →'}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingVertical: 8,
  },
  position: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  stem: {
    fontSize: 19,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 16,
  },
  choices: {
    marginBottom: 12,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 8,
    marginBottom: 8,
  },
  choiceRight: {
    borderWidth: 2,
  },
  choiceWrong: {
    borderStyle: 'dashed',
  },
  choiceReveal: {
    borderWidth: 2,
    borderStyle: 'dashed',
  },
  choiceLetter: {
    fontSize: 17,
    fontWeight: '700',
    color: '#000000',
    minWidth: 28,
  },
  choiceText: {
    fontSize: 17,
    color: '#000000',
    flex: 1,
  },
  choiceMarker: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000000',
    marginLeft: 8,
  },
  reveal: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#000000',
    borderStyle: 'dashed',
    borderRadius: 8,
    marginTop: 4,
  },
  verdict: {
    fontSize: 17,
    fontWeight: '700',
    color: '#000000',
    marginBottom: 6,
  },
  explanation: {
    fontSize: 15,
    color: '#000000',
    marginBottom: 6,
  },
  source: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  advanceHint: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    textAlign: 'right',
  },
});
