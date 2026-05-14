/**
 * Settings view: key-file configuration + Test Connection +
 * encryption controls.
 *
 * On mount it reads `MyStyle/SnCopilot/copilot-key-*.txt` via
 * `FileUtils`, parses them, and resolves the active provider. The
 * key is shown masked. Test Connection sends a real "Hello" to the
 * provider and reports OK or the error message.
 *
 * Secure-key-store additions:
 *   - When plaintext files exist and encryptionMode='undecided',
 *     a banner at the top offers the migration to encrypted-with-PIN.
 *   - The Encryption section at the bottom shows current state and
 *     lock/change-PIN/disable/reset actions when encrypted+unlocked,
 *     or an "Enable encryption" CTA when in plaintext/undecided mode.
 *   - When the user opts into encryption, this view drives the
 *     PinSetup → write-vault → prompt-to-delete-txt flow inline.
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {resolveActiveProvider} from '../storage/activeProvider';
import {createProviderClient} from '../providers';
import {buildWiringBundle, type WiringBundle} from '../storage/wiring';
import {useCopilotState} from '../storage/useCopilotState';
import {
  readCustomActions,
  CUSTOM_ACTIONS_PATH,
} from '../storage/customActionsFile';
import {readPersona, writePersona} from '../storage/personaFile';
import {setEncryptionMode, setIdleTimeoutMin} from '../storage/prefs';
import * as idleTimer from '../storage/idleTimer';
import {
  changePin,
  disableEncryption,
  encryptInitial,
  lockNow,
  resetVault,
} from '../storage/secureFlows';
import {getActiveKeys} from '../storage/sessionKey';
import {encodeUtf8} from '../sdk/utf8';
import type {
  CustomAction,
  KeyFile,
  ProviderId,
  ProviderResolution,
} from '../types';
// (CustomAction stays imported for the read-only display below.)
import CustomActionsSettings from './CustomActionsSettings';
import EncryptionScreen from './EncryptionScreen';
import MigrationPrompt from './MigrationPrompt';
import PersonaSettings from './PersonaSettings';
import PinSetup from './PinSetup';
import SetupChecklist from './SetupChecklist';

export type SettingsViewProps = {
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

// Sub-screens stacked on top of the main settings — the "encryption
// flow" pseudo-modes. Selected by the user via the migration banner,
// the encryption nav row, or the actions inside the encryption screen.
type SubFlow =
  | {kind: 'idle'}
  | {kind: 'pin-setup'; intent: 'create' | 'change'}
  | {kind: 'post-encrypt-cleanup'; sourcePaths: string[]}
  // P2 UX cleanup: when the vault is encrypted, the dense list of
  // Auto-lock / Lock now / Change PIN / Disable / Reset lives behind
  // a single nav row on the main settings, opened as this sub-screen.
  | {kind: 'encryption'};

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
  const {onClose} = props;

  const [bundle, setBundle] = useState<WiringBundle | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const b = await buildWiringBundle();
      if (cancelled) {
        return;
      }
      setBundle(b);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (bundle === null) {
    return (
      <View testID="settings-view" style={styles.root}>
        <StickyTitle onClose={onClose} />
        <ScrollView style={styles.scrollBody}>
          <Text testID="settings-bootstrap-loading" style={styles.metaLine}>
            Loading…
          </Text>
        </ScrollView>
      </View>
    );
  }

  return <SettingsViewBody onClose={onClose} bundle={bundle} />;
}

function SettingsViewBody(props: {
  onClose: () => void;
  bundle: WiringBundle;
}): React.JSX.Element {
  const {onClose, bundle} = props;
  // useCopilotState's effects depend on the deps object's identity —
  // memoize so they only re-run when the bundle itself changes.
  const stateDeps = useMemo(
    () => ({
      prefsDeps: bundle.prefsDeps,
      vaultDeps: bundle.vaultDeps,
      discoveryDeps: bundle.discoveryDeps,
      logger: consoleLogger,
    }),
    [bundle],
  );
  const {state, prefs, discoveryErrors, refresh: refreshState} =
    useCopilotState(stateDeps);
  const errors = useMemo(
    () => discoveryErrors.map((e) => `${e.path}: ${e.reason}`),
    [discoveryErrors],
  );

  const [testStatus, setTestStatus] = useState<TestStatus>({kind: 'idle'});
  const [subFlow, setSubFlow] = useState<SubFlow>({kind: 'idle'});

  const mountedRef = useRef(true);
  const testCtlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      testCtlRef.current?.abort();
      testCtlRef.current = null;
    };
  }, []);

  // Derive the user-visible "resolution" + "errors" from the state
  // machine instead of running discovery a second time. This keeps
  // useCopilotState as the single source of truth for what's on disk
  // vs in the vault, and avoids racing two FileUtils.listFiles calls
  // against each other.
  const resolution = useMemo<ProviderResolution | null>(() => {
    if (state === null) {
      return null;
    }
    const filesForResolution =
      state.kind === 'unlocked'
        ? state.files
        : state.kind === 'plaintext' || state.kind === 'migrate'
        ? state.files
        : state.kind === 'merge'
        ? state.plaintextFiles
        : [];
    return resolveActiveProvider(filesForResolution);
  }, [state]);

  const refresh = useCallback(async () => {
    await refreshState();
  }, [refreshState]);

  const onTestConnection = useCallback(async () => {
    if (!resolution || resolution.kind !== 'ok') {
      return;
    }
    const active: KeyFile = resolution.active;
    setTestStatus({kind: 'running'});
    const start = Date.now();
    const ctl = new AbortController();
    testCtlRef.current = ctl;
    const timeout = setTimeout(() => ctl.abort(), 30_000);
    try {
      const client = createProviderClient(active.provider);
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
      if (!mountedRef.current) {
        return;
      }
      setTestStatus({
        kind: 'ok',
        latencyMs: r.latencyMs,
        modelId: r.modelId,
      });
    } catch (e) {
      if (!mountedRef.current) {
        return;
      }
      const msg = (e as Error).message;
      setTestStatus({kind: 'error', message: msg});
      console.log(
        `[COPILOT_SETTINGS] test connection failed elapsedMs=${Date.now() - start} err=${msg}`,
      );
    } finally {
      clearTimeout(timeout);
      if (testCtlRef.current === ctl) {
        testCtlRef.current = null;
      }
    }
  }, [resolution]);

  // ----- Encryption flows -----

  const onEncryptStart = useCallback(() => {
    setSubFlow({kind: 'pin-setup', intent: 'create'});
  }, []);

  const filesToEncrypt = useMemo<KeyFile[]>(
    () =>
      state !== null && (state.kind === 'plaintext' || state.kind === 'migrate')
        ? state.files
        : [],
    [state],
  );

  const onPinSubmitForCreate = useCallback(
    async (secret: string) => {
      const r = await encryptInitial(
        {vault: bundle.vaultDeps, prefs: bundle.prefsDeps},
        secret,
        filesToEncrypt,
      );
      if (!r.ok) {
        return;
      }
      setSubFlow({
        kind: 'post-encrypt-cleanup',
        sourcePaths: filesToEncrypt.map((f) => f.sourcePath),
      });
      await refresh();
    },
    [bundle.prefsDeps, bundle.vaultDeps, filesToEncrypt, refresh],
  );

  const onPinSubmitForChange = useCallback(
    async (secret: string) => {
      const unlocked = getActiveKeys() ?? [];
      await changePin(
        {vault: bundle.vaultDeps, prefs: bundle.prefsDeps},
        secret,
        unlocked,
      );
      setSubFlow({kind: 'idle'});
    },
    [bundle.prefsDeps, bundle.vaultDeps],
  );

  const onCleanupConfirmDelete = useCallback(async () => {
    const paths =
      subFlow.kind === 'post-encrypt-cleanup' ? subFlow.sourcePaths : [];
    for (const path of paths) {
      await bundle.io.remove(path);
    }
    setSubFlow({kind: 'idle'});
    await refresh();
  }, [bundle.io, refresh, subFlow]);

  const onCleanupSkipDelete = useCallback(async () => {
    setSubFlow({kind: 'idle'});
    await refresh();
  }, [refresh]);

  const onKeepPlaintext = useCallback(async () => {
    await setEncryptionMode(bundle.prefsDeps, 'plaintext');
    await refresh();
  }, [bundle.prefsDeps, refresh]);

  const onLockNow = useCallback(() => {
    lockNow();
    onClose();
  }, [onClose]);

  const onChangePinStart = useCallback(() => {
    setSubFlow({kind: 'pin-setup', intent: 'change'});
  }, []);

  const onDisable = useCallback(async () => {
    const unlocked = getActiveKeys() ?? [];
    // Write-back: re-create one .txt per provider in MyStyle/SnCopilot/.
    const writeBack = async (files: KeyFile[]): Promise<void> => {
      for (const f of files) {
        const lines = [
          `provider=${f.provider}`,
          `model=${f.model}`,
          `key=${f.key}`,
        ];
        if (f.defaultProvider !== undefined) {
          lines.push(`default_provider=${f.defaultProvider}`);
        }
        if (f.clarifyRedact !== undefined) {
          lines.push(`clarify_redact=${f.clarifyRedact ? 'on' : 'off'}`);
        }
        const path = `/storage/emulated/0/MyStyle/SnCopilot/copilot-key-${f.provider}.txt`;
        await bundle.io.writeBytes(path, encodeUtf8(lines.join('\n') + '\n'));
      }
    };
    await disableEncryption(
      {vault: bundle.vaultDeps, prefs: bundle.prefsDeps},
      writeBack,
      unlocked,
    );
    // Encryption is gone — exit the sub-screen so the user lands on
    // the main settings with the now-correct plaintext CTA. Idempotent
    // when the action was triggered from the main settings already.
    setSubFlow({kind: 'idle'});
    await refresh();
  }, [bundle.io, bundle.prefsDeps, bundle.vaultDeps, refresh]);

  const onResetVault = useCallback(async () => {
    await resetVault({vault: bundle.vaultDeps, prefs: bundle.prefsDeps});
    setSubFlow({kind: 'idle'});
    await refresh();
  }, [bundle.prefsDeps, bundle.vaultDeps, refresh]);

  const onIdleTimeoutChange = useCallback(
    async (minutes: number) => {
      await setIdleTimeoutMin(bundle.prefsDeps, minutes);
      // Reflect the new timeout immediately if a timer is running.
      idleTimer.configure({minutes});
      await refresh();
    },
    [bundle.prefsDeps, refresh],
  );

  // Persona is file-based now (MyStyle/SnCopilot/system_prompt.txt).
  // PersonaSettings still hands us a string-or-null on Save; we
  // round-trip it through the file. After write, re-read so the UI
  // reflects whatever the sanitiser actually persisted.
  const [personaDraft, setPersonaDraft] = useState<string | undefined>(
    undefined,
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await readPersona({io: bundle.io});
      if (cancelled) {
        return;
      }
      setPersonaDraft(current ?? undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [bundle.io]);
  const onSavePersona = useCallback(
    async (next: string | null) => {
      await writePersona({io: bundle.io}, next);
      const fresh = await readPersona({io: bundle.io});
      setPersonaDraft(fresh ?? undefined);
    },
    [bundle.io],
  );

  // Custom actions are file-based (custom_actions.txt). No CRUD UI —
  // we just surface a read-only preview + a Reload button so the
  // user can verify their edits without restarting the plugin.
  const [actionsPreview, setActionsPreview] = useState<CustomAction[]>([]);
  const reloadActionsPreview = useCallback(async () => {
    const list = await readCustomActions({io: bundle.io});
    setActionsPreview(list);
  }, [bundle.io]);
  useEffect(() => {
    reloadActionsPreview().catch(() => undefined);
  }, [reloadActionsPreview]);

  // Sub-flow renders take over the entire view.
  if (subFlow.kind === 'pin-setup') {
    return (
      <PinSetup
        intent={subFlow.intent}
        onSubmit={
          subFlow.intent === 'create' ? onPinSubmitForCreate : onPinSubmitForChange
        }
        onCancel={() => setSubFlow({kind: 'idle'})}
      />
    );
  }
  if (subFlow.kind === 'post-encrypt-cleanup') {
    return (
      <CleanupPrompt
        sourcePaths={subFlow.sourcePaths}
        onDelete={onCleanupConfirmDelete}
        onSkip={onCleanupSkipDelete}
      />
    );
  }
  if (subFlow.kind === 'encryption' && state !== null) {
    return (
      <EncryptionScreen
        encryptionMode={prefs.encryptionMode}
        unlocked={state.kind === 'unlocked'}
        idleTimeoutMin={prefs.idleTimeoutMin}
        onEnableEncryption={onEncryptStart}
        onLockNow={onLockNow}
        onChangePin={onChangePinStart}
        onDisableEncryption={onDisable}
        onResetVault={onResetVault}
        onIdleTimeoutChange={onIdleTimeoutChange}
        onBack={() => setSubFlow({kind: 'idle'})}
      />
    );
  }

  const showMigrationBanner = state?.kind === 'migrate';

  return (
    <View testID="settings-view" style={styles.root}>
      <StickyTitle onClose={onClose} />
      <ScrollView style={styles.scrollBody}>

      {showMigrationBanner && state?.kind === 'migrate' ? (
        <MigrationPrompt
          detectedFiles={state.files.map((f) => f.sourcePath)}
          onEncrypt={onEncryptStart}
          onKeepPlaintext={onKeepPlaintext}
          onDecideLater={onClose}
        />
      ) : null}

      {/* Compact action row at the top: Refresh / Test Connection /
          Encryption all on one line. Replaces the three separate
          sections that wasted vertical space on the e-ink overlay.
          Test Connection's status output (running spinner, OK, or
          error) renders BELOW the row as needed. */}
      <View testID="settings-action-row" style={styles.actionRow}>
        <TouchableOpacity
          testID="settings-refresh"
          accessibilityLabel="Re-scan key files"
          onPress={refresh}
          style={styles.actionBtn}>
          <Text style={styles.actionBtnText}>{'⟳ Refresh'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="settings-test-connection"
          accessibilityLabel="Test connection"
          onPress={onTestConnection}
          disabled={
            resolution?.kind !== 'ok' || testStatus.kind === 'running'
          }
          style={[
            styles.actionBtn,
            (resolution?.kind !== 'ok' || testStatus.kind === 'running') &&
              styles.btnDisabled,
          ]}>
          <Text style={styles.actionBtnText}>{'⚡ Test'}</Text>
        </TouchableOpacity>
        {state !== null ? (
          <TouchableOpacity
            testID="encryption-nav-open"
            accessibilityLabel="Open encryption settings"
            onPress={() => setSubFlow({kind: 'encryption'})}
            style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>
              {prefs.encryptionMode === 'encrypted'
                ? state.kind === 'unlocked'
                  ? '🔒 Unlocked'
                  : '🔒 Locked'
                : '🔒 Encrypt'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Inline test-connection status output. Stays just under the
          action row so the user sees the result without scrolling. */}
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

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Provider</Text>
        {resolution === null ? (
          <Text testID="settings-discovery-loading" style={styles.metaLine}>
            Loading…
          </Text>
        ) : null}
        {resolution !== null ? (
          <KeyFileBlock resolution={resolution} />
        ) : null}
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

      <PersonaSettings
        current={personaDraft}
        onSave={onSavePersona}
      />

      <CustomActionsSettings
        actions={actionsPreview}
        filePath={CUSTOM_ACTIONS_PATH}
        onReload={reloadActionsPreview}
      />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Privacy</Text>
        <Text testID="settings-privacy-note" style={styles.privacyNote}>
          On vision providers (Anthropic / OpenAI / Gemini) the page
          screenshot and any transcribed text are sent verbatim — no
          on-device redaction. On DeepSeek (text-only) emails and
          7+ digit runs are scrubbed from the outbound text. Either
          way, avoid opening sensitive pages while Copilot is active.
        </Text>
      </View>
      </ScrollView>
    </View>
  );
}

// Fixed title bar shared by both the bundle-loading state and the
// main settings render. Sits OUTSIDE the body ScrollView so it stays
// visible while the user scrolls through the long settings tree.
function StickyTitle({onClose}: {onClose: () => void}): React.JSX.Element {
  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Image
          testID="settings-title-icon"
          accessibilityLabel="Copilot icon"
          source={require('../../assets/copilot_icon.png')}
          style={styles.titleIcon}
          resizeMode="contain"
        />
        <Text style={styles.title}>Settings</Text>
      </View>
      <TouchableOpacity
        testID="settings-close"
        accessibilityLabel="Close Copilot settings"
        onPress={onClose}
        style={styles.closeBtn}>
        <Text style={styles.closeBtnText}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

function CleanupPrompt(props: {
  sourcePaths: string[];
  onDelete: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  const {sourcePaths, onDelete, onSkip} = props;
  return (
    <ScrollView testID="cleanup-prompt" style={styles.root}>
      <Text style={styles.title}>Migration complete</Text>
      <Text style={styles.body}>
        Your key is now encrypted in the plugin's private folder. The original
        plaintext file(s) can be deleted now — any other plugin can still read
        them until you do.
      </Text>
      <View style={styles.fileList}>
        {sourcePaths.map((p) => (
          <Text key={p} style={styles.fileLine}>
            • {p}
          </Text>
        ))}
      </View>
      <TouchableOpacity
        testID="cleanup-delete"
        accessibilityLabel="Delete plaintext key file"
        onPress={onDelete}
        style={[styles.refreshBtn, styles.dangerBtn]}>
        <Text style={[styles.refreshBtnText, styles.dangerBtnText]}>
          Delete plaintext file(s) now
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="cleanup-skip"
        accessibilityLabel="Keep plaintext file for now"
        onPress={onSkip}
        style={styles.refreshBtn}>
        <Text style={styles.refreshBtnText}>Skip — I'll delete it manually</Text>
      </TouchableOpacity>
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
      <SetupChecklist
        testID="settings-resolution-none"
        headline={resolution.message}
      />
    );
  }
  if (resolution.kind === 'ambiguous') {
    return (
      <View testID="settings-resolution-ambiguous" style={styles.noKeyBlock}>
        <Text style={styles.noKeyText}>{resolution.message}</Text>
        {resolution.candidates.map((c) => (
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
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#000000',
    // Body ScrollView lives below this header — the header itself is
    // a static View so it stays put while the body scrolls.
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  titleIcon: {
    width: 28,
    height: 28,
    marginRight: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#000000',
    flexShrink: 1,
  },
  scrollBody: {flex: 1},
  body: {fontSize: 14, color: '#000000', marginBottom: 12, lineHeight: 20},
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
  dangerBtn: {backgroundColor: '#000000'},
  dangerBtnText: {color: '#FFFFFF', fontWeight: '600'},
  fileList: {paddingLeft: 4, paddingVertical: 4, marginBottom: 8},
  fileLine: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#000000',
    paddingVertical: 2,
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
  // Compact top action row: three buttons fit on one line.
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {fontSize: 13, color: '#000000', fontWeight: '600'},
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
  privacyNote: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    paddingVertical: 4,
  },
});
