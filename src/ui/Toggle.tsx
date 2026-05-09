/**
 * High-contrast on/off switch for e-ink.
 *
 * RN's default `Switch` renders a coloured slider whose blue/white
 * cues compress to similar greys on monochrome e-ink, and partial-
 * refresh ghosting on the slider thumb can look broken. This Toggle
 * replaces it with a bordered pill: ON is a solid-black pill with
 * white text; OFF is a white pill with a black border and black
 * text. Geometry is fixed, so no ghosting.
 */
import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';

export type ToggleProps = {
  value: boolean;
  onValueChange: (next: boolean) => void;
  testID?: string;
  accessibilityLabel?: string;
};

export default function Toggle(props: ToggleProps): React.JSX.Element {
  const {value, onValueChange, testID, accessibilityLabel} = props;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{checked: value}}
      onPress={() => onValueChange(!value)}
      style={[styles.pill, value ? styles.pillOn : styles.pillOff]}>
      <Text style={value ? styles.textOn : styles.textOff}>
        {value ? 'ON' : 'OFF'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    minWidth: 64,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillOn: {
    backgroundColor: '#000000',
  },
  pillOff: {
    backgroundColor: '#FFFFFF',
  },
  textOn: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 13,
    letterSpacing: 1,
  },
  textOff: {
    color: '#000000',
    fontWeight: '600',
    fontSize: 13,
    letterSpacing: 1,
  },
});
