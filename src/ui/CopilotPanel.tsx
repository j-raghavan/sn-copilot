/**
 * The React root mounted inside the native overlay
 * (CopilotOverlayModule.kt's ReactRootView).
 *
 *  - Owns navigation between ChatView (default) and SettingsView
 *    (settings cog).
 *  - On mount, runs key-file discovery + activeProvider resolution
 *    so ChatView receives the resolved KeyFile (or undefined → fake
 *    provider).
 *
 * Note: the chat state (messages) is reset across the Settings
 * round-trip because we mount/unmount ChatView rather than
 * conditionally hiding it. Acceptable trade-off; can be revisited
 * by promoting state into this component.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {FileUtils} from 'sn-plugin-lib';
import CopilotOverlay from '../native/CopilotOverlay';
import {discoverKeyFiles, type FileUtilsLike} from '../storage/keyFiles';
import {resolveActiveProvider} from '../storage/activeProvider';
import {setPageContext} from '../scope/pageContext';
import type {KeyFile} from '../types';
import ChatView from './ChatView';
import SettingsView from './SettingsView';

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

// Bind, not wrap, so the function pointers stay stable for tests
// and don't introduce inline-arrow noise.
const consoleLogger = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export default function CopilotPanel(
  props: CopilotPanelProps,
): React.JSX.Element {
  const {initialScopeLabel = DEFAULT_SCOPE_LABEL} = props;

  const [view, setView] = useState<View>('chat');
  const [activeKeyFile, setActiveKeyFile] = useState<KeyFile | undefined>(
    undefined,
  );

  // discoverKeyFiles self-catches IO; resolveActiveProvider is pure.
  // No outer try/catch needed — any throw here is a genuine bug.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await discoverKeyFiles({
        // The SDK declares listFiles as Promise<string[]> but the
        // native module actually returns FileEntry[]. See keyFiles.ts
        // FileUtilsLike comment for the full story.
        fileUtils: FileUtils as unknown as FileUtilsLike,
        logger: consoleLogger,
      });
      if (cancelled) {
        return;
      }
      const resolution = resolveActiveProvider(result.files);
      if (resolution.kind === 'ok') {
        setActiveKeyFile(resolution.active);
        console.log(
          `[COPILOT_PANEL] active provider=${resolution.active.provider} ` +
            `model=${resolution.active.model} ` +
            `source=${resolution.active.sourcePath}`,
        );
      } else {
        // 'none' and 'ambiguous' both carry a `message` field.
        console.log(
          `[COPILOT_PANEL] no active provider (${resolution.kind}): ${resolution.message}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const closeOverlay = useCallback(() => {
    // Drop the captured page screenshot so the next sidebar tap
    // starts with a fresh capture. Without this, a prior session's
    // screenshot could leak into a new one if the user reopens
    // before the next button-tap capture completes.
    setPageContext(null);
    CopilotOverlay.close().then(result => {
      console.log(
        '[COPILOT_PANEL] CopilotOverlay.close result',
        JSON.stringify(result),
      );
    });
  }, []);

  if (view === 'settings') {
    return <SettingsView onClose={() => setView('chat')} />;
  }

  // The map is exhaustive over ProviderId — no fallback needed.
  const providerLabel = activeKeyFile
    ? PROVIDER_LABEL_FOR_ACTIVE[activeKeyFile.provider]
    : PROVIDER_LABEL_FALLBACK;

  return (
    <ChatView
      scopeLabel={initialScopeLabel}
      provider={providerLabel}
      keyFile={activeKeyFile}
      onSettingsTap={() => setView('settings')}
      onClose={closeOverlay}
    />
  );
}
