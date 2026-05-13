// Full-screen sub-flow that wraps EncryptionSettings with a header
// bar (title + back button). Reached from the main SettingsView via
// a single nav row when the vault is encrypted — declutters the
// main Settings page on small e-ink overlays.
//
// Matches the established PinSetup / CleanupPrompt sub-flow pattern:
// the parent (SettingsView) sets subFlow.kind === 'encryption' and
// renders this in place of the main settings tree.

import React from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import EncryptionSettings, {type EncryptionSettingsProps} from './EncryptionSettings';

export type EncryptionScreenProps = EncryptionSettingsProps & {
  onBack: () => void;
};

export default function EncryptionScreen(
  props: EncryptionScreenProps,
): React.JSX.Element {
  const {onBack, ...rest} = props;
  return (
    <ScrollView testID="encryption-screen" style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="encryption-screen-back"
          accessibilityLabel="Back to settings"
          onPress={onBack}
          style={styles.backBtn}>
          <Text style={styles.backBtnText}>{'‹  Back'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Encryption</Text>
      </View>
      <EncryptionSettings {...rest} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'transparent'},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#000000',
    marginBottom: 4,
  },
  backBtn: {paddingHorizontal: 4, paddingVertical: 4, marginRight: 8},
  backBtnText: {fontSize: 14, color: '#000000', fontWeight: '600'},
  title: {fontSize: 22, fontWeight: '600', color: '#000000'},
});
