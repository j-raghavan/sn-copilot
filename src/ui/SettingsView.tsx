/**
 * Read-only settings view: key-file configuration + Test Connection.
 *
 * On mount it reads `MyStyle/SnCopilot/copilot-key-*.txt` via
 * `FileUtils`, parses them, and resolves the active provider. The
 * key is shown masked. Test Connection sends a real "Hello" to the
 * provider and reports OK or the error message.
 */

import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {FileUtils} from 'sn-plugin-lib';
import {discoverKeyFiles, type FileUtilsLike} from '../storage/keyFiles';
import {resolveActiveProvider} from '../storage/activeProvider';
import {createProviderClient} from '../providers';
import type {KeyFile, ProviderId, ProviderResolution} from '../types';
import Toggle from './Toggle';

export type SettingsViewProps = {
  initialPiiRedaction?: boolean;
  initialVision?: boolean;
  onClose: () => void;
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google (Gemini)',
  deepseek: 'DeepSeek',
};

type TestStatus =
  | {kind: 'idle'}
  | {kind: 'running'}
  | {kind: 'ok'; latencyMs: number; modelId: string}
  | {kind: 'error'; message: string};

const maskKey = (raw: string): string => {
  if (raw.length <= 7) {
    return raw.replace(/./g, '•');
  }
  return `${raw.slice(0, 7)}${'•'.repeat(Math.min(raw.length - 7, 12))}…`;
};

const consoleLogger = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export default function SettingsView(
  props: SettingsViewProps,
): React.JSX.Element {
  const {initialPiiRedaction = true, initialVision = false, onClose} = props;

  const [resolution, setResolution] = useState<ProviderResolution | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [piiRedaction, setPiiRedaction] = useState<boolean>(initialPiiRedaction);
  const [vision, setVision] = useState<boolean>(initialVision);
  const [testStatus, setTestStatus] = useState<TestStatus>({kind: 'idle'});

  // discoverKeyFiles already self-catches IO errors (per-entry +
  // listFiles); resolveActiveProvider is pure. So no outer catch is
  // needed here — any throw would be a genuine bug and should bubble.
  const refresh = useCallback(async () => {
    setResolution(null);
    setErrors([]);
    const result = await discoverKeyFiles({
      // SDK declares listFiles as Promise<string[]> but native returns
      // FileEntry[] — see keyFiles.ts FileUtilsLike note.
      fileUtils: FileUtils as unknown as FileUtilsLike,
      logger: consoleLogger,
    });
    const active = resolveActiveProvider(result.files);
    setResolution(active);
    setErrors(result.errors.map(e => `${e.path}: ${e.reason}`));
    console.log(
      '[COPILOT_SETTINGS] discovery',
      JSON.stringify({
        activeKind: active.kind,
        fileCount: result.files.length,
        errorCount: result.errors.length,
      }),
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onTestConnection = useCallback(async () => {
    if (!resolution || resolution.kind !== 'ok') {
      return;
    }
    const active: KeyFile = resolution.active;
    setTestStatus({kind: 'running'});
    const start = Date.now();
    try {
      const client = createProviderClient(active.provider);
      const ctl = new AbortController();
      const timeout = setTimeout(() => ctl.abort(), 30_000);
      try {
        const r = await client.send(
          {
            systemPrompt:
              'You are a helpful assistant. Respond briefly to confirm the connection works.',
            userText: 'Hello',
            maxTokens: 64,
            signal: ctl.signal,
          },
          {apiKey: active.key, model: active.model},
        );
        setTestStatus({
          kind: 'ok',
          latencyMs: r.latencyMs,
          modelId: r.modelId,
        });
        console.log(
          `[COPILOT_SETTINGS] test connection ok latencyMs=${r.latencyMs} ` +
            `replyLength=${r.text.length}`,
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      const msg = (e as Error).message;
      setTestStatus({kind: 'error', message: msg});
      console.log(
        `[COPILOT_SETTINGS] test connection failed elapsedMs=${Date.now() - start} err=${msg}`,
      );
    }
  }, [resolution]);

  return (
    <ScrollView testID="settings-view" style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Copilot — Settings</Text>
        <TouchableOpacity
          testID="settings-close"
          accessibilityLabel="Close Copilot settings"
          onPress={onClose}
          style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>×</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Provider configuration</Text>
        {resolution === null ? (
          <Text testID="settings-discovery-loading" style={styles.metaLine}>
            Loading…
          </Text>
        ) : null}
        {resolution !== null ? (
          <KeyFileBlock resolution={resolution} />
        ) : null}
        <TouchableOpacity
          testID="settings-refresh"
          accessibilityLabel="Re-scan key files"
          onPress={refresh}
          style={styles.refreshBtn}>
          <Text style={styles.refreshBtnText}>Refresh from disk</Text>
        </TouchableOpacity>
        {errors.length > 0 ? (
          <View testID="settings-errors" style={styles.errorBlock}>
            <Text style={styles.errorTitle}>Parse errors</Text>
            {errors.map((e, i) => (
              <Text key={i} style={styles.errorLine}>
                • {e}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Test connection</Text>
        <TouchableOpacity
          testID="settings-test-connection"
          accessibilityLabel="Test connection"
          onPress={onTestConnection}
          disabled={
            resolution?.kind !== 'ok' || testStatus.kind === 'running'
          }
          style={[
            styles.testBtn,
            (resolution?.kind !== 'ok' || testStatus.kind === 'running') &&
              styles.btnDisabled,
          ]}>
          <Text style={styles.testBtnText}>Test Connection</Text>
        </TouchableOpacity>
        {testStatus.kind === 'running' ? (
          <View testID="settings-test-status" style={styles.testStatusRow}>
            <ActivityIndicator size="small" color="#000000" />
            <Text style={styles.testStatusText}>Testing…</Text>
          </View>
        ) : null}
        {testStatus.kind === 'ok' ? (
          <View testID="settings-test-status" style={styles.testOkBlock}>
            <Text style={styles.testStatusText}>
              ✓ Connection OK! ({testStatus.modelId} · {testStatus.latencyMs}ms)
            </Text>
          </View>
        ) : null}
        {testStatus.kind === 'error' ? (
          <View testID="settings-test-status" style={styles.testErrorBlock}>
            <Text style={styles.testErrorText}>
              ✕ Connection failed: {testStatus.message}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Privacy</Text>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>PII redaction (default on)</Text>
          <Toggle
            testID="settings-pii-toggle"
            accessibilityLabel="Toggle PII redaction"
            value={piiRedaction}
            onValueChange={setPiiRedaction}
          />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Send page image (vision; off)</Text>
          <Toggle
            testID="settings-vision-toggle"
            accessibilityLabel="Toggle vision mode"
            value={vision}
            onValueChange={setVision}
          />
        </View>
      </View>
    </ScrollView>
  );
}

function KeyFileBlock({
  resolution,
}: {
  resolution: ProviderResolution;
}): React.JSX.Element {
  if (resolution.kind === 'none') {
    return (
      <View testID="settings-resolution-none" style={styles.noKeyBlock}>
        <Text style={styles.noKeyText}>{resolution.message}</Text>
        <Text style={styles.noKeyHint}>
          Drop one of these files into{' '}
          <Text style={styles.mono}>/MyStyle/SnCopilot/</Text>:
        </Text>
        <Text style={styles.mono}>copilot-key-anthropic.txt</Text>
        <Text style={styles.mono}>copilot-key-openai.txt</Text>
        <Text style={styles.mono}>copilot-key-gemini.txt</Text>
        <Text style={styles.mono}>copilot-key-deepseek.txt</Text>
        <Text style={styles.noKeyHint}>
          Filename tolerance:{' '}
          <Text style={styles.mono}>copilot-key-claude.txt</Text> →
          anthropic;{' '}
          <Text style={styles.mono}>copilot-key-google.txt</Text> →
          gemini.
        </Text>
      </View>
    );
  }
  if (resolution.kind === 'ambiguous') {
    return (
      <View testID="settings-resolution-ambiguous" style={styles.noKeyBlock}>
        <Text style={styles.noKeyText}>{resolution.message}</Text>
        {resolution.candidates.map(c => (
          <Text key={c.sourcePath} style={styles.mono}>
            {c.sourcePath}
          </Text>
        ))}
      </View>
    );
  }
  return <ActiveProviderBlock active={resolution.active} />;
}

function ActiveProviderBlock({active}: {active: KeyFile}): React.JSX.Element {
  return (
    <View testID="settings-resolution-ok" style={styles.activeBlock}>
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Provider</Text>
        <Text style={styles.fieldValue}>{PROVIDER_LABEL[active.provider]}</Text>
      </View>
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Model</Text>
        <Text
          testID="settings-active-model"
          style={[styles.fieldValue, styles.mono]}>
          {active.model}
        </Text>
      </View>
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>API key</Text>
        <Text
          testID="settings-active-key"
          style={[styles.fieldValue, styles.mono]}>
          {maskKey(active.key)}
        </Text>
      </View>
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Mode</Text>
        <Text
          testID="settings-active-mode"
          style={[styles.fieldValue, styles.mono]}>
          {active.mode}
        </Text>
      </View>
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Source</Text>
        <Text
          testID="settings-active-source"
          style={[styles.fieldValue, styles.mono, styles.smallValue]}>
          {active.sourcePath}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#000000',
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#000000',
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  closeBtnText: {
    fontSize: 28,
    color: '#000000',
  },
  section: {
    paddingTop: 16,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  metaLine: {
    fontSize: 14,
    color: '#000000',
  },
  noKeyBlock: {
    paddingVertical: 8,
  },
  noKeyText: {
    fontSize: 14,
    color: '#000000',
    marginBottom: 8,
  },
  noKeyHint: {
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
  activeBlock: {
    paddingVertical: 4,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 4,
  },
  fieldLabel: {
    fontSize: 13,
    color: '#000000',
    width: 90,
    marginRight: 12,
    fontWeight: '600',
  },
  fieldValue: {
    flex: 1,
    fontSize: 14,
    color: '#000000',
  },
  smallValue: {
    fontSize: 11,
  },
  refreshBtn: {
    marginTop: 12,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
  },
  refreshBtnText: {
    fontSize: 13,
    color: '#000000',
  },
  errorBlock: {
    marginTop: 12,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderStyle: 'dashed',
    borderRadius: 4,
  },
  errorTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 4,
  },
  errorLine: {
    fontSize: 12,
    color: '#000000',
    marginBottom: 2,
  },
  testBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  testBtnText: {
    fontSize: 14,
    color: '#000000',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  testStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  testStatusText: {
    fontSize: 13,
    color: '#000000',
    marginLeft: 8,
  },
  testOkBlock: {
    marginTop: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
  },
  testErrorBlock: {
    marginTop: 8,
    padding: 8,
    borderWidth: 2,
    borderColor: '#000000',
    borderStyle: 'dashed',
    borderRadius: 4,
  },
  testErrorText: {
    fontSize: 13,
    color: '#000000',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  toggleLabel: {
    fontSize: 14,
    color: '#000000',
    flex: 1,
    marginRight: 16,
  },
});
