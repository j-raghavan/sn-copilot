// First-run setup checklist shown when no key file is resolved.
//
// Used in both the chat empty-state (so users who never open
// Settings can still onboard) and the Settings "no key file" block
// (so the cog path stays self-contained). Keep one source of truth.

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

const SETUP_STEPS: ReadonlyArray<{title: string; body: string}> = [
  {
    title: 'Pick a provider',
    body: 'Anthropic, OpenAI, Google Gemini, or DeepSeek. Grab an API key from their console.',
  },
  {
    title: 'Create the folder',
    body: '/MyStyle/SnCopilot/ on your Supernote (USB sync, WebDAV, or Cloud — whatever you already use).',
  },
  {
    title: 'Add the key file',
    body: 'Save copilot-key-<provider>.txt in that folder with three lines: provider=, model=, and key=<your API key>. Templates live in the templates/ folder of the GitHub repo.',
  },
  {
    title: 'Tap Refresh',
    body: 'Open ⚙ Settings and tap "Refresh from disk" — Copilot picks up the file without restarting.',
  },
];

export type SetupChecklistProps = {
  // Optional headline shown above the steps. Settings passes the
  // resolver's status message ("No key file found…" or
  // "default_provider mismatch…"); the chat passes a
  // user-friendly call-to-action.
  headline?: string;
  testID?: string;
};

export default function SetupChecklist(
  props: SetupChecklistProps,
): React.JSX.Element {
  const {headline, testID} = props;
  return (
    <View testID={testID} style={styles.block}>
      {headline !== undefined ? (
        <Text style={styles.headline}>{headline}</Text>
      ) : null}
      {SETUP_STEPS.map((step, i) => (
        <View
          key={i}
          testID={`setup-step-${i + 1}`}
          style={styles.stepRow}>
          <Text style={styles.stepNum}>{i + 1}.</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepText}>{step.body}</Text>
          </View>
        </View>
      ))}
      <Text style={styles.tolerance}>
        Filename tolerance:{' '}
        <Text style={styles.mono}>copilot-key-claude.txt</Text> →
        anthropic;{' '}
        <Text style={styles.mono}>copilot-key-google.txt</Text> →
        gemini.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    paddingVertical: 8,
  },
  headline: {
    fontSize: 14,
    color: '#000000',
    marginBottom: 8,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 6,
  },
  stepNum: {
    fontSize: 14,
    color: '#000000',
    fontWeight: '600',
    width: 22,
    paddingTop: 1,
  },
  stepBody: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 14,
    color: '#000000',
    fontWeight: '600',
    marginBottom: 2,
  },
  stepText: {
    fontSize: 13,
    color: '#000000',
    lineHeight: 18,
  },
  tolerance: {
    fontSize: 13,
    color: '#000000',
    marginTop: 8,
    marginBottom: 4,
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#000000',
  },
});
