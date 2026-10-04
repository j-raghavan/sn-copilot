// Whether PilotChat can answer at all, decided as it opens: without a key
// it can use, the writing page is not shown, so nothing is written that
// cannot be answered.

import type {AppState} from '../storage/appState';
import {isImageCapableProvider, type KeyFile} from '../types';

export const NEEDS_KEY =
  'PilotChat needs an AI provider key. Open Copilot from the sidebar and follow its setup, then open PilotChat again.';
export const NEEDS_UNLOCK =
  'Your key is locked. Open Copilot from the sidebar and enter your PIN, then open PilotChat again.';
export const NEEDS_KEY_SETUP =
  'Copilot has new key files to finish setting up. Open Copilot from the sidebar, then open PilotChat again.';
export const NEEDS_VISION =
  "PilotChat reads your handwriting with an AI that can see images, and DeepSeek can't. Switch Copilot to Anthropic, OpenAI or Gemini to use PilotChat.";

/**
 * Why PilotChat cannot answer with [state] and its active [keyFile], or
 * null if it can. [state] null is still loading: not yet known, so null.
 */
export const unavailableReason = (
  state: AppState | null,
  keyFile: KeyFile | undefined,
): string | null => {
  if (state === null) {
    return null;
  }
  if (keyFile === undefined) {
    switch (state.kind) {
      case 'locked':
        return NEEDS_UNLOCK;
      case 'merge':
        return NEEDS_KEY_SETUP;
      default:
        return NEEDS_KEY;
    }
  }
  return isImageCapableProvider(keyFile.provider) ? null : NEEDS_VISION;
};
