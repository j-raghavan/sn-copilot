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
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import CopilotOverlay from '../native/CopilotOverlay';
import {resolveActiveProvider} from '../storage/activeProvider';
import {readCustomActions} from '../storage/customActionsFile';
import {readPersona} from '../storage/personaFile';
import {setHasSeenSettings} from '../storage/prefs';
import {useCopilotState} from '../storage/useCopilotState';
import {
  lockNow as lockNowFlow,
  mergeIntoVault,
  resetVault,
  unlock as unlockFlow,
} from '../storage/secureFlows';
import {buildWiringBundle, type WiringBundle} from '../storage/wiring';
import {
  getPageContext,
  setPageContext,
  type PageContext,
} from '../scope/pageContext';
import {classifyFileKind} from '../scope/fileKind';
import {redactPii} from '../privacy/redact';
import {isImageCapableProvider, type CustomAction, type KeyFile} from '../types';
import ChatView from './ChatView';
import GrillView from './GrillView';
import SettingsView from './SettingsView';
import UnlockScreen from './UnlockScreen';
import {useProviderClient} from './useProviderClient';

type View = 'chat' | 'settings' | 'drill';

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
  const {state, prefs, refresh} = useCopilotState(stateDeps);

  // Persona + custom actions are file-based now (read from
  // MyStyle/SnCopilot/system_prompt.txt and custom_actions.txt). We
  // keep them as panel state and reload after Settings closes so
  // user edits flow into ChatView without remount gymnastics.
  const [persona, setPersona] = useState<string | null>(null);
  const [customActions, setCustomActions] = useState<CustomAction[]>([]);
  const reloadFiles = useCallback(async () => {
    const [p, actions] = await Promise.all([
      readPersona({io: bundle.io}),
      readCustomActions({io: bundle.io}),
    ]);
    setPersona(p);
    setCustomActions(actions);
  }, [bundle.io]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, actions] = await Promise.all([
        readPersona({io: bundle.io}),
        readCustomActions({io: bundle.io}),
      ]);
      if (cancelled) {
        return;
      }
      setPersona(p);
      setCustomActions(actions);
    })();
    return () => {
      cancelled = true;
    };
  }, [bundle.io]);

  // First-run routing: until the user has SEEN Settings once, boot
  // directly into Settings instead of an empty ChatView. The flag
  // flips THE MOMENT we route to Settings — not on close — so
  // subsequent opens land on ChatView even when the user closes the
  // whole overlay via the host sidebar (instead of tapping × on
  // Settings). Decided ONCE per panel mount, after both state and
  // prefs have loaded from disk.
  const firstRouteDecidedRef = useRef(false);
  useEffect(() => {
    if (firstRouteDecidedRef.current) {
      return;
    }
    if (state === null) {
      return;
    }
    // Locked / merge / no-key states render their own screens above
    // the view-switcher; don't make a routing decision yet.
    if (
      state.kind === 'locked' ||
      state.kind === 'merge' ||
      state.kind === 'no-key'
    ) {
      return;
    }
    firstRouteDecidedRef.current = true;
    if (prefs.hasSeenSettings !== true) {
      setView('settings');
      // Flip the flag IMMEDIATELY (fire-and-forget). Whether the user
      // closes via × or via the host sidebar, the next boot lands on
      // ChatView. Refresh after to mirror disk back into useCopilotState.
      setHasSeenSettings(bundle.prefsDeps, true)
        .then(() => refresh())
        .catch(() => undefined);
    }
  }, [state, prefs.hasSeenSettings, setView, bundle.prefsDeps, refresh]);

  // Settings-close handler: just switches view + re-reads the persona
  // + custom-action files so ChatView picks up any edits. The first-
  // run flag is flipped on show, not here, so this stays trivial.
  const onCloseSettings = useCallback(() => {
    setView('chat');
    reloadFiles().catch(() => undefined);
  }, [reloadFiles, setView]);

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

  // Triggered by the chat header 🔒 icon. lockNowFlow wipes the
  // session + derived key; the next render of CopilotPanelInner sees
  // state.kind === 'locked' and swaps in UnlockScreen automatically.
  const onLockFromChat = useCallback(() => {
    lockNowFlow();
  }, []);

  // Resolve the page context once on mount so we know whether the
  // currently-open file is a PDF/EPUB (the substrate Grill Me
  // targets). Null while we haven't resolved yet OR the capture
  // failed (capture is best-effort by design).
  const [pageContext, setPageContextState] =
    useState<PageContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    getPageContext()
      .then((ctx) => {
        if (cancelled) {
          return;
        }
        setPageContextState(ctx);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The lock icon only makes sense when the vault is BOTH encrypted
  // AND currently unlocked — there's nothing to lock otherwise.
  const showLockButton =
    state !== null && state.kind === 'unlocked';

  // 'locked' or 'merge' (vault present, can't proceed without unlock)
  // fully gate the chat surface. The settings cog is hidden because
  // there's nothing actionable in settings until unlock.
  if (state !== null && (state.kind === 'locked' || state.kind === 'merge')) {
    return (
      <UnlockScreen onAttempt={onUnlockAttempt} onReset={onUnlockReset} />
    );
  }

  if (view === 'settings') {
    return <SettingsView onClose={onCloseSettings} />;
  }

  const activeKeyFile = activeKeyFromState(state);
  const providerLabel = activeKeyFile
    ? PROVIDER_LABEL_FOR_ACTIVE[activeKeyFile.provider]
    : PROVIDER_LABEL_FALLBACK;

  // Grill Me availability: needs a configured key file AND the open
  // file must be PDF/EPUB. .note (handwritten) is excluded for v1 —
  // OCR noise produces low-quality stems, and the locked plan
  // restricts v1 to the curated-text substrate.
  const fileKind =
    pageContext !== null ? classifyFileKind(pageContext.notePath) : null;
  const grillAvailable = activeKeyFile !== undefined && fileKind === 'doc';

  if (view === 'drill' && pageContext !== null && activeKeyFile !== undefined) {
    return (
      <GrillScreen
        keyFile={activeKeyFile}
        pageContext={pageContext}
        onBack={() => setView('chat')}
      />
    );
  }

  return (
    <ChatView
      scopeLabel={initialScopeLabel}
      provider={providerLabel}
      keyFile={activeKeyFile}
      conversationsDeps={bundle.conversationsDeps}
      customSystemPrompt={persona ?? undefined}
      customActions={customActions}
      showLockButton={showLockButton}
      onLockNow={onLockFromChat}
      onSettingsTap={() => setView('settings')}
      onClose={closeOverlay}
      onStartDrill={
        grillAvailable ? () => setView('drill') : undefined
      }
    />
  );
}

// Small wrapper around GrillView so we can call useProviderClient
// (a hook) only when we actually render the Grill screen. Keeps the
// inner-panel render hook order stable across view switches.
type GrillScreenProps = {
  keyFile: KeyFile;
  pageContext: PageContext;
  onBack: () => void;
};

function GrillScreen(props: GrillScreenProps): React.JSX.Element {
  const {keyFile, pageContext, onBack} = props;
  const {client, apiKey, model} = useProviderClient(keyFile);
  const attachImage = isImageCapableProvider(keyFile.provider);
  // Privacy contract parity with ChatView: vision providers ship the
  // page image, so scrubbing the text-side too would be theatre.
  // Text-only providers (DeepSeek) don't get an image channel, so the
  // page text is the only thing on the wire — scrub emails + long
  // digit runs before any grill module sees it.
  const sanitizedPageContext: PageContext = attachImage
    ? pageContext
    : {...pageContext, pageText: redactPii(pageContext.pageText)};
  return (
    <GrillView
      client={client}
      apiKey={apiKey}
      model={model}
      attachImage={attachImage}
      pageContext={sanitizedPageContext}
      onBack={onBack}
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
