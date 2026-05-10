// Settings section for the secure-key-store. Shown inside SettingsView.
//
// State variants the section renders:
//   - plaintext: "Enable encryption" CTA + plain-text honesty warning.
//   - encrypted, locked: should not occur — Settings is only reachable
//     after unlock — but defensively show a "locked" indicator.
//   - encrypted, unlocked: Lock now / Change PIN / Disable / Reset +
//     idle-timeout picker.

import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import type {EncryptionMode} from '../types';

const IDLE_PRESETS: ReadonlyArray<{minutes: number; label: string}> = [
  {minutes: 5, label: '5 min'},
  {minutes: 10, label: '10 min'},
  {minutes: 30, label: '30 min'},
  {minutes: 60, label: '1 hour'},
];

export type EncryptionSettingsProps = {
  encryptionMode: EncryptionMode;
  unlocked: boolean;
  idleTimeoutMin: number;
  // Plaintext-mode call-to-action.
  onEnableEncryption: () => void;
  // Encrypted-mode actions.
  onLockNow: () => void;
  onChangePin: () => void;
  onDisableEncryption: () => void;
  onResetVault: () => void;
  onIdleTimeoutChange: (minutes: number) => void;
};

export default function EncryptionSettings(
  props: EncryptionSettingsProps,
): React.JSX.Element {
  const {
    encryptionMode,
    unlocked,
    idleTimeoutMin,
    onEnableEncryption,
    onLockNow,
    onChangePin,
    onDisableEncryption,
    onResetVault,
    onIdleTimeoutChange,
  } = props;

  if (encryptionMode === 'plaintext' || encryptionMode === 'undecided') {
    return (
      <View testID="encryption-settings-plaintext" style={styles.section}>
        <Text style={styles.sectionTitle}>Key encryption</Text>
        <Text style={styles.bodyWarn}>
          Your key file lives as plaintext in MyStyle/SnCopilot/. Any other
          plugin you install on this Supernote can read it.
        </Text>
        <TouchableOpacity
          testID="encryption-enable"
          accessibilityLabel="Enable encryption"
          onPress={onEnableEncryption}
          style={[styles.button, styles.primaryButton]}>
          <Text style={[styles.buttonText, styles.primaryButtonText]}>
            Encrypt with a PIN
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!unlocked) {
    return (
      <View testID="encryption-settings-locked" style={styles.section}>
        <Text style={styles.sectionTitle}>Key encryption</Text>
        <Text style={styles.body}>Encrypted vault is currently locked.</Text>
      </View>
    );
  }

  return (
    <View testID="encryption-settings-encrypted" style={styles.section}>
      <Text style={styles.sectionTitle}>Key encryption</Text>
      <Text style={styles.body}>
        Vault unlocked. Auto-lock fires after {idleTimeoutMin} min of inactivity
        or when Copilot is closed.
      </Text>

      <Text style={styles.subTitle}>Auto-lock after</Text>
      <View style={styles.idleRow}>
        {IDLE_PRESETS.map((p) => {
          const active = p.minutes === idleTimeoutMin;
          return (
            <TouchableOpacity
              key={p.minutes}
              testID={`encryption-idle-${p.minutes}`}
              accessibilityLabel={`Set idle timeout to ${p.label}`}
              onPress={() => onIdleTimeoutChange(p.minutes)}
              style={[styles.pillBtn, active && styles.pillBtnActive]}>
              <Text style={[styles.pillBtnText, active && styles.pillBtnTextActive]}>
                {p.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.actionsCol}>
        <TouchableOpacity
          testID="encryption-lock-now"
          accessibilityLabel="Lock Copilot now"
          onPress={onLockNow}
          style={styles.button}>
          <Text style={styles.buttonText}>Lock now</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="encryption-change-pin"
          accessibilityLabel="Change PIN"
          onPress={onChangePin}
          style={styles.button}>
          <Text style={styles.buttonText}>Change PIN</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="encryption-disable"
          accessibilityLabel="Disable encryption"
          onPress={onDisableEncryption}
          style={styles.button}>
          <Text style={styles.buttonText}>Disable encryption (write back to plaintext)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="encryption-reset"
          accessibilityLabel="Reset Copilot key"
          onPress={onResetVault}
          style={styles.button}>
          <Text style={styles.buttonText}>Reset key (delete vault)</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {paddingTop: 16, paddingBottom: 8},
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  subTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#000000',
    marginTop: 12,
    marginBottom: 6,
  },
  body: {fontSize: 13, color: '#000000', marginBottom: 8, lineHeight: 18},
  bodyWarn: {
    fontSize: 13,
    color: '#000000',
    marginBottom: 12,
    lineHeight: 18,
    fontWeight: '600',
  },
  idleRow: {flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8},
  pillBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 12,
    marginRight: 8,
    marginBottom: 8,
  },
  pillBtnActive: {backgroundColor: '#000000'},
  pillBtnText: {fontSize: 12, color: '#000000'},
  pillBtnTextActive: {color: '#FFFFFF', fontWeight: '600'},
  actionsCol: {marginTop: 4},
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    marginVertical: 4,
    alignSelf: 'flex-start',
  },
  primaryButton: {backgroundColor: '#000000'},
  buttonText: {fontSize: 13, color: '#000000'},
  primaryButtonText: {color: '#FFFFFF', fontWeight: '600'},
});
