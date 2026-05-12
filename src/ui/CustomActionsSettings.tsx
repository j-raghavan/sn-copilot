/**
 * Settings section for user-defined quick actions (Req 3b).
 *
 * Lists saved actions and exposes Add / Edit / Delete flows. Adding
 * an action persists immediately on Save; deletes prompt for nothing
 * (the list is short and small enough that this is recoverable —
 * the user just re-creates).
 *
 * Edit/Add share one inline form so the surface fits on the e-ink
 * panel without a separate sub-screen. The form persists when Save
 * is tapped; Cancel discards the in-flight draft.
 *
 * Caller persists via onSave(actions[]) — we pass the full list each
 * time (last-write-wins). The actual cap + sanitization lives in
 * src/storage/prefs.ts.
 */

import React, {useCallback, useMemo, useState} from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  CUSTOM_ACTION_ICON_MAX,
  CUSTOM_ACTION_LABEL_MAX,
  CUSTOM_ACTION_LIMIT,
  CUSTOM_ACTION_PROMPT_MAX,
  type CustomAction,
} from '../types';
import {newConversationId} from '../storage/conversations';

export type CustomActionsSettingsProps = {
  // Current persisted list — may be undefined when none are configured.
  current: CustomAction[] | undefined;
  // Persist the full replacement list. Caller routes through
  // setCustomActions in prefs.ts so the sanitizer / cap apply.
  onSave: (next: CustomAction[]) => Promise<void>;
};

type Editing =
  | {kind: 'none'}
  | {
      kind: 'edit';
      // null id = adding a new action; otherwise editing in place.
      id: string | null;
      label: string;
      icon: string;
      prompt: string;
    };

export default function CustomActionsSettings(
  props: CustomActionsSettingsProps,
): React.JSX.Element {
  const {current, onSave} = props;
  // Memoize so useCallback deps below stay stable when `current` is
  // the same reference. A fresh `current ?? []` on every render would
  // bust the memo + cause the eslint react-hooks/exhaustive-deps rule
  // to flag every callback that closes over it.
  const actions = useMemo<CustomAction[]>(() => current ?? [], [current]);
  const [editing, setEditing] = useState<Editing>({kind: 'none'});
  const [busy, setBusy] = useState(false);

  const remaining = CUSTOM_ACTION_LIMIT - actions.length;
  const canAdd = remaining > 0 && editing.kind === 'none';

  const startAdd = useCallback(() => {
    setEditing({kind: 'edit', id: null, label: '', icon: '', prompt: ''});
  }, []);

  const startEdit = useCallback((a: CustomAction) => {
    setEditing({
      kind: 'edit',
      id: a.id,
      label: a.label,
      icon: a.icon,
      prompt: a.prompt,
    });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing({kind: 'none'});
  }, []);

  const saveEdit = useCallback(async () => {
    if (editing.kind !== 'edit' || busy) {
      return;
    }
    const label = editing.label.trim();
    const icon = editing.icon.trim();
    const prompt = editing.prompt.trim();
    if (label.length === 0 || icon.length === 0 || prompt.length === 0) {
      return;
    }
    if (
      label.length > CUSTOM_ACTION_LABEL_MAX ||
      icon.length > CUSTOM_ACTION_ICON_MAX ||
      prompt.length > CUSTOM_ACTION_PROMPT_MAX
    ) {
      return;
    }
    setBusy(true);
    try {
      let next: CustomAction[];
      if (editing.id === null) {
        if (actions.length >= CUSTOM_ACTION_LIMIT) {
          return;
        }
        next = [
          ...actions,
          {id: newConversationId(), label, icon, prompt},
        ];
      } else {
        next = actions.map((a) =>
          a.id === editing.id ? {...a, label, icon, prompt} : a,
        );
      }
      await onSave(next);
      setEditing({kind: 'none'});
    } finally {
      setBusy(false);
    }
  }, [actions, busy, editing, onSave]);

  const deleteAction = useCallback(
    async (id: string) => {
      if (busy) {
        return;
      }
      setBusy(true);
      try {
        await onSave(actions.filter((a) => a.id !== id));
      } finally {
        setBusy(false);
      }
    },
    [actions, busy, onSave],
  );

  return (
    <View testID="custom-actions-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>Custom quick actions</Text>
      <Text style={styles.hint}>
        Add up to {CUSTOM_ACTION_LIMIT} custom actions. Each button
        sends its saved prompt to the model.
      </Text>

      {actions.length === 0 && editing.kind === 'none' ? (
        <Text testID="custom-actions-empty" style={styles.emptyHint}>
          No custom actions yet — tap "Add action" to create one.
        </Text>
      ) : null}

      {actions.map((a) => (
        <View
          key={a.id}
          testID={`custom-action-row-${a.id}`}
          style={styles.row}>
          <View style={styles.rowLeading}>
            <Text style={styles.icon}>{a.icon}</Text>
            <View style={styles.rowText}>
              <Text style={styles.label}>{a.label}</Text>
              <Text style={styles.promptPreview} numberOfLines={2}>
                {a.prompt}
              </Text>
            </View>
          </View>
          <View style={styles.rowActions}>
            <TouchableOpacity
              testID={`custom-action-edit-${a.id}`}
              accessibilityLabel={`Edit ${a.label}`}
              onPress={() => startEdit(a)}
              disabled={editing.kind === 'edit' || busy}
              style={[
                styles.smallBtn,
                (editing.kind === 'edit' || busy) && styles.btnDisabled,
              ]}>
              <Text style={styles.smallBtnText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID={`custom-action-delete-${a.id}`}
              accessibilityLabel={`Delete ${a.label}`}
              onPress={() => deleteAction(a.id)}
              disabled={editing.kind === 'edit' || busy}
              style={[
                styles.smallBtn,
                (editing.kind === 'edit' || busy) && styles.btnDisabled,
              ]}>
              <Text style={styles.smallBtnText}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}

      {editing.kind === 'edit' ? (
        <EditForm
          editing={editing}
          busy={busy}
          onChange={setEditing}
          onSave={saveEdit}
          onCancel={cancelEdit}
        />
      ) : (
        <TouchableOpacity
          testID="custom-actions-add"
          accessibilityLabel="Add custom action"
          onPress={startAdd}
          disabled={!canAdd}
          style={[styles.btn, !canAdd && styles.btnDisabled]}>
          <Text style={styles.btnText}>
            {remaining > 0
              ? `Add action (${remaining} slot${remaining === 1 ? '' : 's'} left)`
              : 'Limit reached'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function EditForm(props: {
  editing: Extract<Editing, {kind: 'edit'}>;
  busy: boolean;
  onChange: (next: Editing) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const {editing, busy, onChange, onSave, onCancel} = props;
  const update = useCallback(
    (patch: Partial<Extract<Editing, {kind: 'edit'}>>) => {
      onChange({...editing, ...patch});
    },
    [editing, onChange],
  );
  const labelOver = editing.label.length > CUSTOM_ACTION_LABEL_MAX;
  const iconOver = editing.icon.length > CUSTOM_ACTION_ICON_MAX;
  const promptOver = editing.prompt.length > CUSTOM_ACTION_PROMPT_MAX;
  const blank =
    editing.label.trim().length === 0 ||
    editing.icon.trim().length === 0 ||
    editing.prompt.trim().length === 0;
  const canSave = !busy && !blank && !labelOver && !iconOver && !promptOver;
  return (
    <View testID="custom-action-form" style={styles.form}>
      <Text style={styles.formTitle}>
        {editing.id === null ? 'New action' : 'Edit action'}
      </Text>
      <ScrollView contentContainerStyle={styles.formContent}>
        <Text style={styles.fieldLabel}>Icon (1 glyph)</Text>
        <TextInput
          testID="custom-action-icon"
          accessibilityLabel="Action icon"
          value={editing.icon}
          onChangeText={(v) => update({icon: v})}
          maxLength={CUSTOM_ACTION_ICON_MAX}
          style={styles.fieldInput}
          editable={!busy}
        />
        <Text style={styles.fieldLabel}>Label (max {CUSTOM_ACTION_LABEL_MAX})</Text>
        <TextInput
          testID="custom-action-label"
          accessibilityLabel="Action label"
          value={editing.label}
          onChangeText={(v) => update({label: v})}
          style={styles.fieldInput}
          editable={!busy}
        />
        <Text style={styles.fieldLabel}>
          Prompt (max {CUSTOM_ACTION_PROMPT_MAX})
        </Text>
        <TextInput
          testID="custom-action-prompt"
          accessibilityLabel="Action prompt"
          value={editing.prompt}
          onChangeText={(v) => update({prompt: v})}
          multiline
          style={[styles.fieldInput, styles.multiInput]}
          editable={!busy}
        />
      </ScrollView>
      <View style={styles.btnRow}>
        <TouchableOpacity
          testID="custom-action-save"
          accessibilityLabel="Save action"
          onPress={onSave}
          disabled={!canSave}
          style={[styles.btn, !canSave && styles.btnDisabled]}>
          <Text style={styles.btnText}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="custom-action-cancel"
          accessibilityLabel="Cancel editing"
          onPress={onCancel}
          disabled={busy}
          style={[styles.btn, busy && styles.btnDisabled]}>
          <Text style={styles.btnText}>Cancel</Text>
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
  emptyHint: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    marginBottom: 6,
  },
  rowLeading: {flexDirection: 'row', alignItems: 'center', flex: 1},
  rowText: {marginLeft: 8, flex: 1},
  icon: {fontSize: 18, color: '#000000', width: 24, textAlign: 'center'},
  label: {fontSize: 14, color: '#000000', fontWeight: '600'},
  promptPreview: {fontSize: 12, color: '#000000', marginTop: 2},
  rowActions: {flexDirection: 'row', gap: 4},
  smallBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
  },
  smallBtnText: {fontSize: 12, color: '#000000'},
  btn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
  },
  btnText: {fontSize: 13, color: '#000000'},
  btnRow: {flexDirection: 'row', gap: 8, marginTop: 8},
  btnDisabled: {opacity: 0.4},
  form: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderStyle: 'dashed',
    borderRadius: 4,
  },
  formTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
  },
  formContent: {paddingVertical: 4},
  fieldLabel: {fontSize: 12, color: '#000000', marginTop: 6},
  fieldInput: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: '#000000',
    marginTop: 2,
  },
  multiInput: {minHeight: 60, textAlignVertical: 'top'},
});
