// PIN entry + confirm. Used during opt-in migration AND during a
// "change PIN" flow in settings.
//
// PIN policy:
//   - Numeric only, 6–12 digits.
//   - Two inputs (PIN + confirm) must match before "Continue" enables.
//   - "Show" toggle reveals the PIN in case the user mistypes — useful
//     on an e-ink soft keyboard where input feedback is lossy.
//
// We also accept an optional `passphraseMode` prop for users who want
// a stronger credential. In passphrase mode the validation rules
// switch to "≥ 12 chars" with no numeric restriction.

import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';

const PIN_MIN_DIGITS = 6;
const PIN_MAX_DIGITS = 12;
const PASSPHRASE_MIN_CHARS = 12;
const PIN_DIGIT_RE = /^[0-9]*$/;

export type PinSetupMode = 'pin' | 'passphrase';

export type PinSetupProps = {
  // 'create'  — first-time setup; show "no recovery" warning.
  // 'change'  — already have a PIN; less alarming wording.
  intent: 'create' | 'change';
  initialMode?: PinSetupMode;
  onSubmit: (secret: string) => void | Promise<void>;
  onCancel?: () => void;
};

const validate = (
  mode: PinSetupMode,
  primary: string,
  confirm: string,
): {ok: boolean; reason?: string} => {
  if (primary.length === 0) {
    return {ok: false};
  }
  if (mode === 'pin') {
    if (!PIN_DIGIT_RE.test(primary)) {
      return {ok: false, reason: 'PIN must contain digits only.'};
    }
    if (primary.length < PIN_MIN_DIGITS) {
      return {ok: false, reason: `PIN must be at least ${PIN_MIN_DIGITS} digits.`};
    }
    if (primary.length > PIN_MAX_DIGITS) {
      return {ok: false, reason: `PIN must be at most ${PIN_MAX_DIGITS} digits.`};
    }
  } else {
    if (primary.length < PASSPHRASE_MIN_CHARS) {
      return {
        ok: false,
        reason: `Passphrase must be at least ${PASSPHRASE_MIN_CHARS} characters.`,
      };
    }
  }
  if (confirm !== primary) {
    return {ok: false, reason: 'The two entries do not match.'};
  }
  return {ok: true};
};

export default function PinSetup(props: PinSetupProps): React.JSX.Element {
  const {intent, initialMode = 'pin', onSubmit, onCancel} = props;

  const [mode, setMode] = useState<PinSetupMode>(initialMode);
  const [primary, setPrimary] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const validation = validate(mode, primary, confirm);
  // Only surface a validation error message once the user has actually
  // typed something in the confirm field; otherwise the empty form
  // shouts at them on first paint.
  const validationMessage =
    confirm.length > 0 && validation.reason ? validation.reason : null;

  const handleSubmit = useCallback(async () => {
    if (!validation.ok || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(primary);
    } finally {
      setSubmitting(false);
    }
  }, [validation.ok, submitting, onSubmit, primary]);

  const switchMode = useCallback((next: PinSetupMode) => {
    setMode(next);
    setPrimary('');
    setConfirm('');
  }, []);

  return (
    <ScrollView testID="pin-setup" style={styles.root}>
      <Text style={styles.title}>
        {intent === 'create' ? 'Create a PIN' : 'Change your PIN'}
      </Text>

      {intent === 'create' ? (
        <Text style={styles.warn}>
          You'll type this each time you open Copilot. There is no recovery if
          you forget it — you'd need to drop a new key file to start over.
        </Text>
      ) : null}

      <View style={styles.modeRow}>
        <TouchableOpacity
          testID="pin-mode-pin"
          accessibilityLabel="Use a numeric PIN"
          onPress={() => switchMode('pin')}
          style={[styles.modeBtn, mode === 'pin' && styles.modeBtnActive]}>
          <Text style={[styles.modeBtnText, mode === 'pin' && styles.modeBtnTextActive]}>
            Numeric PIN ({PIN_MIN_DIGITS}–{PIN_MAX_DIGITS} digits)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="pin-mode-passphrase"
          accessibilityLabel="Use a passphrase"
          onPress={() => switchMode('passphrase')}
          style={[styles.modeBtn, mode === 'passphrase' && styles.modeBtnActive]}>
          <Text
            style={[
              styles.modeBtnText,
              mode === 'passphrase' && styles.modeBtnTextActive,
            ]}>
            Passphrase (≥ {PASSPHRASE_MIN_CHARS} chars)
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>{mode === 'pin' ? 'PIN' : 'Passphrase'}</Text>
      <TextInput
        testID="pin-input-primary"
        value={primary}
        onChangeText={setPrimary}
        secureTextEntry={!show}
        keyboardType={mode === 'pin' ? 'number-pad' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        accessibilityLabel="Enter PIN or passphrase"
      />

      <Text style={styles.label}>Confirm</Text>
      <TextInput
        testID="pin-input-confirm"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry={!show}
        keyboardType={mode === 'pin' ? 'number-pad' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        accessibilityLabel="Confirm PIN or passphrase"
      />

      <TouchableOpacity
        testID="pin-toggle-show"
        accessibilityLabel="Show or hide PIN"
        onPress={() => setShow((s) => !s)}
        style={styles.showRow}>
        <Text style={styles.showText}>{show ? '◉ Hide' : '◯ Show'}</Text>
      </TouchableOpacity>

      {validationMessage !== null ? (
        <Text testID="pin-validation-message" style={styles.error}>
          {validationMessage}
        </Text>
      ) : null}

      <View style={styles.actionsRow}>
        {onCancel ? (
          <TouchableOpacity
            testID="pin-cancel"
            accessibilityLabel="Cancel"
            onPress={onCancel}
            style={styles.button}>
            <Text style={styles.buttonText}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          testID="pin-submit"
          accessibilityLabel="Continue"
          disabled={!validation.ok || submitting}
          onPress={handleSubmit}
          style={[
            styles.button,
            styles.primaryButton,
            (!validation.ok || submitting) && styles.btnDisabled,
          ]}>
          <Text style={[styles.buttonText, styles.primaryButtonText]}>
            {submitting ? 'Working…' : 'Continue'}
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, padding: 16, backgroundColor: 'transparent'},
  title: {fontSize: 22, fontWeight: '600', color: '#000000', marginBottom: 12},
  warn: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    marginBottom: 16,
    lineHeight: 18,
  },
  modeRow: {flexDirection: 'row', marginBottom: 16, flexWrap: 'wrap'},
  modeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    marginRight: 8,
    marginBottom: 8,
  },
  modeBtnActive: {backgroundColor: '#000000'},
  modeBtnText: {fontSize: 12, color: '#000000'},
  modeBtnTextActive: {color: '#FFFFFF', fontWeight: '600'},
  label: {fontSize: 13, color: '#000000', fontWeight: '600', marginBottom: 4},
  input: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    color: '#000000',
    marginBottom: 12,
  },
  showRow: {alignSelf: 'flex-start', paddingVertical: 4},
  showText: {fontSize: 13, color: '#000000'},
  error: {
    fontSize: 13,
    color: '#000000',
    marginTop: 8,
    marginBottom: 8,
    fontWeight: '600',
  },
  actionsRow: {flexDirection: 'row', marginTop: 16, justifyContent: 'flex-end'},
  button: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    marginLeft: 8,
  },
  primaryButton: {backgroundColor: '#000000'},
  buttonText: {fontSize: 14, color: '#000000'},
  primaryButtonText: {color: '#FFFFFF', fontWeight: '600'},
  btnDisabled: {opacity: 0.4},
});
