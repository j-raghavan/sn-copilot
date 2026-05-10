// Shown on the first run after a plaintext copilot-key-*.txt is found
// AND the user hasn't yet decided whether to encrypt it.
//
// Three exits:
//   - "Encrypt with a PIN"  → caller swaps in PinSetup.
//   - "Keep plaintext file" → prefs.encryptionMode='plaintext'; today's
//                              behaviour continues unchanged.
//   - "Decide later"        → no prefs change; we ask again next open.
//
// Wording emphasises the threat (a co-installed plugin can read the
// key file as it sits today) without scaring the user away from the
// "decide later" path.

import React from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

export type MigrationPromptProps = {
  // sourcePaths of the discovered plaintext key files; the prompt
  // surfaces them so the user knows what's about to be encrypted.
  detectedFiles: ReadonlyArray<string>;
  onEncrypt: () => void;
  onKeepPlaintext: () => void;
  onDecideLater: () => void;
};

export default function MigrationPrompt(
  props: MigrationPromptProps,
): React.JSX.Element {
  const {detectedFiles, onEncrypt, onKeepPlaintext, onDecideLater} = props;

  return (
    <ScrollView testID="migration-prompt" style={styles.root}>
      <Text style={styles.title}>Protect your API key</Text>

      <Text style={styles.body}>
        Copilot found {detectedFiles.length === 1 ? 'a key file' : 'key files'} in
        MyStyle/SnCopilot/. Right now this file sits as plaintext on shared
        storage — any other plugin you install on this Supernote can read it.
      </Text>

      <View testID="migration-detected-list" style={styles.fileList}>
        {detectedFiles.map((p) => (
          <Text key={p} style={styles.fileLine}>
            • {p}
          </Text>
        ))}
      </View>

      <Text style={styles.bodyEmphasis}>
        You can encrypt the key with a PIN you choose. Other plugins will only
        see ciphertext. You'll type the PIN once each time you open Copilot.
      </Text>

      <TouchableOpacity
        testID="migration-encrypt"
        accessibilityLabel="Encrypt the key file with a PIN"
        onPress={onEncrypt}
        style={[styles.button, styles.primaryButton]}>
        <Text style={[styles.buttonText, styles.primaryButtonText]}>
          Encrypt with a PIN  (recommended)
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        testID="migration-keep-plaintext"
        accessibilityLabel="Keep the key file as plaintext"
        onPress={onKeepPlaintext}
        style={styles.button}>
        <Text style={styles.buttonText}>Keep plaintext file</Text>
      </TouchableOpacity>

      <TouchableOpacity
        testID="migration-decide-later"
        accessibilityLabel="Decide later"
        onPress={onDecideLater}
        style={styles.button}>
        <Text style={styles.buttonText}>Decide later</Text>
      </TouchableOpacity>

      <Text style={styles.footnote}>
        If you forget the PIN, you'll need to drop a new key file to start
        over. There is no recovery.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, padding: 16, backgroundColor: 'transparent'},
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 12,
  },
  body: {
    fontSize: 14,
    color: '#000000',
    lineHeight: 20,
    marginBottom: 12,
  },
  bodyEmphasis: {
    fontSize: 14,
    color: '#000000',
    lineHeight: 20,
    marginTop: 8,
    marginBottom: 16,
    fontWeight: '600',
  },
  fileList: {
    paddingLeft: 4,
    paddingVertical: 4,
    marginBottom: 8,
  },
  fileLine: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#000000',
    paddingVertical: 2,
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    marginVertical: 6,
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: '#000000',
  },
  buttonText: {
    fontSize: 14,
    color: '#000000',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  footnote: {
    fontSize: 12,
    color: '#000000',
    marginTop: 16,
    fontStyle: 'italic',
  },
});
