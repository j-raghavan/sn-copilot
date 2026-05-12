/**
 * Settings section for the global persona override (Req 3a).
 *
 * The user sees the current override (if any) in a multi-line text
 * field, a Save button that persists, and a Reset button that clears
 * the override and falls back to the built-in SYSTEM_PROMPT. Local
 * draft state is kept so the user can edit without persisting until
 * they tap Save — same UX as the rest of Settings.
 *
 * No truncation logic here: the underlying prefs sanitizer drops
 * over-length values on the way to disk, so the UI just shows the
 * user what they typed. The hint line tells them the cap.
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {CUSTOM_SYSTEM_PROMPT_MAX} from '../types';

export type PersonaSettingsProps = {
  // Current persisted persona, or undefined when none is set.
  current: string | undefined;
  // Save: caller persists via setCustomSystemPrompt. Passing null
  // tells the caller to clear the override.
  onSave: (next: string | null) => Promise<void>;
};

export default function PersonaSettings(
  props: PersonaSettingsProps,
): React.JSX.Element {
  const {current, onSave} = props;
  const [draft, setDraft] = useState<string>(current ?? '');
  const [busy, setBusy] = useState<boolean>(false);
  // Sync the draft when the persisted value changes from outside
  // (e.g., after a Reset that flowed through useCopilotState).
  useEffect(() => {
    setDraft(current ?? '');
  }, [current]);

  const isDirty = draft !== (current ?? '');
  const tooLong = draft.length > CUSTOM_SYSTEM_PROMPT_MAX;

  const onPressSave = useCallback(async () => {
    if (busy || tooLong) {
      return;
    }
    setBusy(true);
    try {
      await onSave(draft.trim().length === 0 ? null : draft);
    } finally {
      setBusy(false);
    }
  }, [busy, draft, onSave, tooLong]);

  const onPressReset = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onSave(null);
      setDraft('');
    } finally {
      setBusy(false);
    }
  }, [busy, onSave]);

  return (
    <View testID="persona-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>Persona (custom system prompt)</Text>
      <Text style={styles.hint}>
        Override the assistant's built-in steering. Leave empty to use
        the default. Max {CUSTOM_SYSTEM_PROMPT_MAX} characters.
      </Text>
      <TextInput
        testID="persona-input"
        accessibilityLabel="Custom system prompt"
        value={draft}
        onChangeText={setDraft}
        multiline
        editable={!busy}
        placeholder="You are a precise tutor who…"
        style={styles.input}
      />
      <Text testID="persona-counter" style={styles.counter}>
        {draft.length} / {CUSTOM_SYSTEM_PROMPT_MAX}
        {tooLong ? ' — too long; trim before saving' : ''}
      </Text>
      <View style={styles.btnRow}>
        <TouchableOpacity
          testID="persona-save"
          accessibilityLabel="Save persona"
          onPress={onPressSave}
          disabled={busy || tooLong || !isDirty}
          style={[
            styles.btn,
            (busy || tooLong || !isDirty) && styles.btnDisabled,
          ]}>
          <Text style={styles.btnText}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="persona-reset"
          accessibilityLabel="Reset persona to default"
          onPress={onPressReset}
          disabled={busy || (current === undefined && draft.length === 0)}
          style={[
            styles.btn,
            (busy || (current === undefined && draft.length === 0)) &&
              styles.btnDisabled,
          ]}>
          <Text style={styles.btnText}>Reset to default</Text>
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
  hint: {fontSize: 12, color: '#000000', marginBottom: 8, fontStyle: 'italic'},
  input: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    padding: 8,
    fontSize: 13,
    color: '#000000',
    textAlignVertical: 'top',
  },
  counter: {fontSize: 11, color: '#000000', marginTop: 4},
  btnRow: {flexDirection: 'row', marginTop: 8, gap: 8},
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
  },
  btnText: {fontSize: 13, color: '#000000'},
  btnDisabled: {opacity: 0.4},
});
