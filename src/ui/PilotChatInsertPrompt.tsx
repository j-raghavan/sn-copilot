// The offer to insert the PilotChat's conversation into the note, shown
// over the page on Close and New, and the buttons it shares with the
// PilotChat's header.

import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

type InsertPromptProps = {
  title: string;
  // An earlier copy of this conversation is in the note.
  replaces: boolean;
  leaveLabel: string;
  busy: boolean;
  onInsert: () => void;
  onDiscard: () => void;
  onKeepWriting: () => void;
};

export function InsertPrompt(props: InsertPromptProps): React.JSX.Element {
  const {
    title,
    replaces,
    leaveLabel,
    busy,
    onInsert,
    onDiscard,
    onKeepWriting,
  } = props;
  return (
    <View style={styles.promptShade} testID="pilotchat-insert-prompt">
      <View style={styles.promptCard}>
        <Text style={styles.promptTitle} testID="pilotchat-prompt-title">
          {title}
        </Text>
        <Text style={styles.promptBody}>
          {replaces
            ? 'It replaces the copy you inserted earlier, unless you have written on that copy since.'
            : 'Your handwriting and the answers go on new pages after the page you were on. Nothing is written unless you choose Insert.'}
        </Text>
        {busy ? (
          <Text style={styles.promptBody} testID="pilotchat-inserting">
            Writing into your note…
          </Text>
        ) : (
          <View style={styles.promptActions}>
            <Pressable
              onPress={onKeepWriting}
              style={controls.button}
              testID="pilotchat-keep-writing">
              <Text style={controls.buttonText}>Keep writing</Text>
            </Pressable>
            <Pressable
              onPress={onDiscard}
              style={controls.button}
              testID="pilotchat-discard">
              <Text style={controls.buttonText}>{leaveLabel}</Text>
            </Pressable>
            <Pressable
              onPress={onInsert}
              style={[controls.button, controls.primary]}
              testID="pilotchat-insert">
              <Text style={[controls.buttonText, controls.primaryText]}>
                Insert
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

/** The PilotChat's buttons, in its header and in the offer. */
export const controls = StyleSheet.create({
  button: {
    borderWidth: 2,
    borderColor: '#000',
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 8,
    marginLeft: 12,
  },
  buttonText: {fontSize: 20, color: '#000'},
  primary: {backgroundColor: '#000'},
  primaryText: {color: '#fff'},
});

const styles = StyleSheet.create({
  promptShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  promptCard: {
    width: '80%',
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: '#000',
    borderRadius: 12,
    padding: 32,
  },
  promptTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: '#000',
    marginBottom: 12,
  },
  promptBody: {fontSize: 20, color: '#000', marginBottom: 24},
  promptActions: {flexDirection: 'row', justifyContent: 'flex-end'},
});
