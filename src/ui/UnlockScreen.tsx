// Unlock screen — shown when an encrypted vault exists and the
// in-memory key is empty (cold start, idle wipe, or explicit Lock).
//
// Single PIN/passphrase input. On wrong PIN the input is disabled for
// an exponentially-growing window (1s, 2s, 4s, 8s …, capped) so a
// hostile process that already exfiltrated the .enc and is calling
// our decrypt path can't grind. Offline brute-force on the exfil
// copy is still possible, which is why we ship spend-cap docs.
//
// After RESET_AFTER_FAILS failures the screen surfaces a "Forgot
// PIN — reset Copilot" action that deletes the vault.

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, TouchableOpacity} from 'react-native';

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const RESET_AFTER_FAILS = 5;

export type UnlockResult =
  | {kind: 'ok'}
  | {kind: 'wrong-pin'}
  | {kind: 'corrupt'; reason: string};

export type UnlockScreenProps = {
  // Caller wires this to vault.readVault → on ok, also calls
  // sessionKey.setActiveKeys.
  onAttempt: (secret: string) => Promise<UnlockResult>;
  onReset: () => void;
};

export default function UnlockScreen(
  props: UnlockScreenProps,
): React.JSX.Element {
  const {onAttempt, onReset} = props;

  const [secret, setSecret] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failures, setFailures] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [lockUntilMs, setLockUntilMs] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());

  // Tick once per second so the visible countdown updates.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (lockUntilMs <= now) {
      if (tickRef.current !== null) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    tickRef.current = setInterval(() => setNow(Date.now()), 250);
    return () => {
      if (tickRef.current !== null) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [lockUntilMs, now]);

  const remainingMs = Math.max(0, lockUntilMs - now);
  const locked = remainingMs > 0;

  const submit = useCallback(async () => {
    if (locked || submitting || secret.length === 0) {
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const r = await onAttempt(secret);
      if (r.kind === 'ok') {
        setSecret('');
        setFailures(0);
        return;
      }
      if (r.kind === 'corrupt') {
        setMessage(`Vault file is unreadable (${r.reason}). Reset to start over.`);
        return;
      }
      const next = failures + 1;
      setFailures(next);
      const backoff = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, next - 1),
        MAX_BACKOFF_MS,
      );
      setLockUntilMs(Date.now() + backoff);
      setMessage(
        next >= RESET_AFTER_FAILS
          ? `${next} wrong attempts. Reset Copilot if you've forgotten the PIN.`
          : `Wrong PIN. Try again in ${Math.ceil(backoff / 1_000)}s.`,
      );
    } finally {
      setSubmitting(false);
      setSecret('');
    }
  }, [failures, locked, onAttempt, secret, submitting]);

  return (
    <ScrollView testID="unlock-screen" style={styles.root}>
      <Text style={styles.title}>Unlock Copilot</Text>
      <Text style={styles.body}>
        Enter the PIN you set when you encrypted your key file.
      </Text>

      <Text style={styles.label}>PIN or passphrase</Text>
      <TextInput
        testID="unlock-input"
        value={secret}
        onChangeText={setSecret}
        secureTextEntry={!show}
        editable={!locked && !submitting}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, locked && styles.inputLocked]}
        accessibilityLabel="Enter PIN to unlock"
      />

      <TouchableOpacity
        testID="unlock-toggle-show"
        accessibilityLabel="Show or hide PIN"
        onPress={() => setShow((s) => !s)}
        style={styles.showRow}>
        <Text style={styles.showText}>{show ? '◉ Hide' : '◯ Show'}</Text>
      </TouchableOpacity>

      {message !== null ? (
        <Text testID="unlock-message" style={styles.error}>
          {message}
        </Text>
      ) : null}

      {locked ? (
        <Text testID="unlock-countdown" style={styles.countdown}>
          Locked for {Math.ceil(remainingMs / 1_000)}s…
        </Text>
      ) : null}

      <TouchableOpacity
        testID="unlock-submit"
        accessibilityLabel="Unlock"
        disabled={locked || submitting || secret.length === 0}
        onPress={submit}
        style={[
          styles.button,
          styles.primaryButton,
          (locked || submitting || secret.length === 0) && styles.btnDisabled,
        ]}>
        <Text style={[styles.buttonText, styles.primaryButtonText]}>
          {submitting ? 'Unlocking…' : 'Unlock'}
        </Text>
      </TouchableOpacity>

      {failures >= RESET_AFTER_FAILS ? (
        <TouchableOpacity
          testID="unlock-reset"
          accessibilityLabel="Reset Copilot key"
          onPress={onReset}
          style={styles.button}>
          <Text style={styles.buttonText}>
            Forgot PIN — reset Copilot key
          </Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, padding: 16, backgroundColor: 'transparent'},
  title: {fontSize: 22, fontWeight: '600', color: '#000000', marginBottom: 12},
  body: {fontSize: 14, color: '#000000', marginBottom: 16, lineHeight: 20},
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
  inputLocked: {opacity: 0.4},
  showRow: {alignSelf: 'flex-start', paddingVertical: 4},
  showText: {fontSize: 13, color: '#000000'},
  error: {fontSize: 13, color: '#000000', marginTop: 8, fontWeight: '600'},
  countdown: {fontSize: 13, color: '#000000', marginTop: 4, fontStyle: 'italic'},
  button: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    marginTop: 12,
    alignItems: 'center',
  },
  primaryButton: {backgroundColor: '#000000'},
  buttonText: {fontSize: 14, color: '#000000'},
  primaryButtonText: {color: '#FFFFFF', fontWeight: '600'},
  btnDisabled: {opacity: 0.4},
});
