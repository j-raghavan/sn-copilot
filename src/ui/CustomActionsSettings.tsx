// Read-only preview of the user-managed custom-actions file.
//
// Custom actions are no longer edited in the app — the user drops a
// plain-text file at <DEFAULT_KEY_ROOT>/custom_actions.txt (one
// `label: prompt` per line) and the app parses it on boot + after
// every Settings close. This component exists purely to surface
// what the parser found, plus a Reload button so the user can
// verify their edits without restarting the plugin.

import React, {useCallback, useState} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {CUSTOM_ACTION_LIMIT, type CustomAction} from '../types';

export type CustomActionsSettingsProps = {
  // Current parsed actions, in display order.
  actions: CustomAction[];
  // Absolute path to the custom_actions.txt file, surfaced so the
  // user knows WHERE to drop their edits.
  filePath: string;
  // Re-runs the parser; the parent re-supplies `actions` once the
  // read settles.
  onReload: () => Promise<void>;
};

export default function CustomActionsSettings(
  props: CustomActionsSettingsProps,
): React.JSX.Element {
  const {actions, filePath, onReload} = props;
  const [busy, setBusy] = useState(false);
  const onPressReload = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onReload();
    } finally {
      setBusy(false);
    }
  }, [busy, onReload]);

  return (
    <View testID="custom-actions-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>Custom quick actions</Text>
      <Text style={styles.hint}>
        Edit the file below to add your own quick-action buttons. Up to{' '}
        {CUSTOM_ACTION_LIMIT} per file, one `label: prompt` per line.
        Lines starting with `#` are comments.
      </Text>
      <Text testID="custom-actions-path" style={styles.pathLine} selectable>
        {filePath}
      </Text>

      {actions.length === 0 ? (
        <Text testID="custom-actions-empty" style={styles.emptyHint}>
          No custom actions parsed. The file is missing, empty, or has
          no parseable lines.
        </Text>
      ) : (
        <View style={styles.grid}>
          {actions.map((a) => (
            <View
              key={a.id}
              testID={`custom-action-preview-${a.id}`}
              style={styles.tile}>
              <View style={styles.tileHeader}>
                <Text style={styles.icon}>{a.icon}</Text>
                <Text style={styles.label} numberOfLines={1}>
                  {a.label}
                </Text>
              </View>
              <Text style={styles.promptPreview} numberOfLines={2}>
                {a.prompt}
              </Text>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity
        testID="custom-actions-reload"
        accessibilityLabel="Reload custom actions from disk"
        onPress={onPressReload}
        disabled={busy}
        style={[styles.btn, busy && styles.btnDisabled]}>
        <Text style={styles.btnText}>
          {busy ? 'Reloading…' : 'Reload from disk'}
        </Text>
      </TouchableOpacity>
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
  hint: {fontSize: 12, color: '#000000', marginBottom: 6, fontStyle: 'italic'},
  pathLine: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#000000',
    marginBottom: 8,
  },
  emptyHint: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  // 2-column grid matches the chat empty-state SuggestionCards
  // density so what the user sees in Settings is exactly what
  // they'll get on the chat surface.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  tile: {
    width: '48%',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 8,
    marginBottom: 8,
    minHeight: 60,
  },
  tileHeader: {flexDirection: 'row', alignItems: 'center', marginBottom: 4},
  icon: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000000',
    minWidth: 20,
    textAlign: 'center',
    marginRight: 6,
  },
  label: {fontSize: 13, color: '#000000', fontWeight: '600', flex: 1},
  promptPreview: {fontSize: 11, color: '#000000', fontStyle: 'italic'},
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
  btnDisabled: {opacity: 0.4},
});
