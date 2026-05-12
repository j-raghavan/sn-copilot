/**
 * The React root mounted inside the native overlay
 * (CopilotOverlayModule.kt's ReactRootView).
 *
 *   - Owns navigation between ChatView (default) and SettingsView
 *     (settings cog).
 *   - Bootstraps the secure-key-store wiring and feeds the resulting
 *     state machine. When the vault is locked, the panel shows
 *     UnlockScreen instead of any chat surface.
 *   - Plaintext / undecided users see today's behaviour unchanged
 *     (the chat sidebar does NOT interrupt them with the migration
 *     prompt — that surfaces inside Settings).
 *
 * Note: the chat state (messages) is reset across the Settings
 * round-trip because we mount/unmount ChatView rather than
 * conditionally hiding it. Acceptable trade-off; can be revisited
 * by promoting state into this component.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import CopilotOverlay from '../native/CopilotOverlay';
import {resolveActiveProvider} from '../storage/activeProvider';
import {useCopilotState} from '../storage/useCopilotState';
import {mergeIntoVault, unlock as unlockFlow, resetVault} from '../storage/secureFlows';
import {buildWiringBundle, type WiringBundle} from '../storage/wiring';
import {setPageContext} from '../scope/pageContext';
import type {KeyFile} from '../types';
import ChatView from './ChatView';
import SettingsView from './SettingsView';
import UnlockScreen from './UnlockScreen';

type View = 'chat' | 'settings';

export type CopilotPanelProps = {
  // Initial scope label shown in the chat header. Currently fixed to
  // "Current Page"; placeholder for richer scope resolution.
  initialScopeLabel?: string;
};

const DEFAULT_SCOPE_LABEL = 'Current Page';
const PROVIDER_LABEL_FALLBACK = 'Demo (no key)';

const PROVIDER_LABEL_FOR_ACTIVE: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
};

export default function CopilotPanel(
  props: CopilotPanelProps,
): React.JSX.Element {
  const {initialScopeLabel = DEFAULT_SCOPE_LABEL} = props;

  const [view, setView] = useState<View>('chat');
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

  const closeOverlay = useCallback(() => {
    setPageContext(null);
    CopilotOverlay.close().then((result) => {
      console.log(
        '[COPILOT_PANEL] CopilotOverlay.close result',
        JSON.stringify(result),
      );
    });
  }, []);

  // While the wiring bundle resolves (one host call) render today's
  // chat fallback so first paint isn't a spinner. No persistence
  // wiring yet — conversationsDeps comes from the bundle.
  if (bundle === null) {
    return (
      <ChatView
        scopeLabel={initialScopeLabel}
        provider={PROVIDER_LABEL_FALLBACK}
        keyFile={undefined}
        onSettingsTap={() => setView('settings')}
        onClose={closeOverlay}
      />
    );
  }

  return (
    <CopilotPanelInner
      view={view}
      setView={setView}
      initialScopeLabel={initialScopeLabel}
      bundle={bundle}
      closeOverlay={closeOverlay}
    />
  );
}

type InnerProps = {
  view: View;
  setView: (v: View) => void;
  initialScopeLabel: string;
  bundle: WiringBundle;
  closeOverlay: () => void;
};

function CopilotPanelInner(props: InnerProps): React.JSX.Element {
  const {view, setView, initialScopeLabel, bundle, closeOverlay} = props;

  // useCopilotState hangs an effect off the deps object's identity,
  // so a fresh literal each render would re-run discovery. Memoize on
  // bundle (which is set once after the wiring resolves).
  const stateDeps = useMemo(
    () => ({
      prefsDeps: bundle.prefsDeps,
      vaultDeps: bundle.vaultDeps,
      discoveryDeps: bundle.discoveryDeps,
      logger: bundle.vaultDeps.logger,
    }),
    [bundle],
  );
  const {state, refresh} = useCopilotState(stateDeps);

  const onUnlockAttempt = useCallback(
    async (secret: string) => {
      const r = await unlockFlow(
        {vault: bundle.vaultDeps, prefs: bundle.prefsDeps},
        secret,
      );
      if (r.kind === 'wrong-pin') {
        return {kind: 'wrong-pin' as const};
      }
      if (r.kind === 'corrupt') {
        return {kind: 'corrupt' as const, reason: r.reason};
      }
      if (r.kind === 'not-found') {
        return {kind: 'corrupt' as const, reason: 'vault disappeared'};
      }
      // ok — but if state was 'merge' (plaintext present alongside the
      // vault), fold the new key files into the vault under the same
      // PIN so we don't loop on the unlock screen.
      if (state !== null && state.kind === 'merge') {
        await mergeIntoVault(
          {vault: bundle.vaultDeps, prefs: bundle.prefsDeps},
          secret,
          r.files,
          state.plaintextFiles,
        );
        await refresh();
      }
      return {kind: 'ok' as const};
    },
    [bundle.prefsDeps, bundle.vaultDeps, refresh, state],
  );

  const onUnlockReset = useCallback(async () => {
    await resetVault({vault: bundle.vaultDeps, prefs: bundle.prefsDeps});
    await refresh();
  }, [bundle.prefsDeps, bundle.vaultDeps, refresh]);

  // 'locked' or 'merge' (vault present, can't proceed without unlock)
  // fully gate the chat surface. The settings cog is hidden because
  // there's nothing actionable in settings until unlock.
  if (state !== null && (state.kind === 'locked' || state.kind === 'merge')) {
    return (
      <UnlockScreen onAttempt={onUnlockAttempt} onReset={onUnlockReset} />
    );
  }

  if (view === 'settings') {
    return <SettingsView onClose={() => setView('chat')} />;
  }

  const activeKeyFile = activeKeyFromState(state);
  const providerLabel = activeKeyFile
    ? PROVIDER_LABEL_FOR_ACTIVE[activeKeyFile.provider]
    : PROVIDER_LABEL_FALLBACK;

  return (
    <ChatView
      scopeLabel={initialScopeLabel}
      provider={providerLabel}
      keyFile={activeKeyFile}
      conversationsDeps={bundle.conversationsDeps}
      onSettingsTap={() => setView('settings')}
      onClose={closeOverlay}
    />
  );
}

const activeKeyFromState = (
  state: ReturnType<typeof useCopilotState>['state'],
): KeyFile | undefined => {
  if (state === null) {
    return undefined;
  }
  let files: KeyFile[];
  if (state.kind === 'unlocked') {
    files = state.files;
  } else if (state.kind === 'plaintext' || state.kind === 'migrate') {
    files = state.files;
  } else {
    return undefined;
  }
  const r = resolveActiveProvider(files);
  return r.kind === 'ok' ? r.active : undefined;
};
