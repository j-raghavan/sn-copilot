// Persisted user-level preferences for Copilot.
//
// File: `<plugin-dir>/copilot-prefs.json` (or hidden fallback under
// MyStyle/SnCopilot if the host doesn't expose a private dir; see
// vaultPath.ts).
//
// Schema is intentionally tiny — we don't accumulate ephemeral state
// here. Today: encryption opt-in choice + idle timeout. Add fields
// only when they need to outlive a single chat session AND can't be
// derived from the filesystem.
//
// Read errors (missing file, malformed JSON, wrong shape) collapse
// to DEFAULT_PREFS so the user is never blocked from the chat
// surface by a corrupt prefs file. Writes are last-write-wins.

import {
  CUSTOM_ACTION_ICON_MAX,
  CUSTOM_ACTION_LABEL_MAX,
  CUSTOM_ACTION_LIMIT,
  CUSTOM_ACTION_PROMPT_MAX,
  CUSTOM_SYSTEM_PROMPT_MAX,
  DEFAULT_PREFS,
  type CopilotPrefs,
  type CustomAction,
  type EncryptionMode,
} from '../types';
import type {FileIo} from './fileIo';
import type {Logger} from '../sdk/types';
import {decodeUtf8, encodeUtf8} from '../sdk/utf8';

const TAG = '[prefs]';

const VALID_MODES: ReadonlySet<EncryptionMode> = new Set([
  'plaintext',
  'encrypted',
  'undecided',
]);

export type PrefsDeps = {
  io: FileIo;
  prefsPath: string;
  logger?: Logger;
};

const NOOP = (): void => undefined;
const noopLogger: Logger = {log: NOOP, warn: NOOP, error: NOOP};

const isShape = (v: unknown): v is Partial<CopilotPrefs> =>
  typeof v === 'object' && v !== null;

// Pulls a string field if it's a string and within the length cap;
// returns undefined to drop the field entirely (we don't persist a
// half-good value).
const safeString = (v: unknown, maxLen: number): string | undefined => {
  if (typeof v !== 'string') {
    return undefined;
  }
  if (v.length > maxLen) {
    return undefined;
  }
  return v;
};

const isValidAction = (v: unknown): v is CustomAction => {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) {
    return false;
  }
  if (typeof o.label !== 'string' || o.label.length === 0) {
    return false;
  }
  if (o.label.length > CUSTOM_ACTION_LABEL_MAX) {
    return false;
  }
  if (typeof o.icon !== 'string' || o.icon.length === 0) {
    return false;
  }
  if (o.icon.length > CUSTOM_ACTION_ICON_MAX) {
    return false;
  }
  if (typeof o.prompt !== 'string' || o.prompt.length === 0) {
    return false;
  }
  if (o.prompt.length > CUSTOM_ACTION_PROMPT_MAX) {
    return false;
  }
  return true;
};

const sanitizeCustomActions = (raw: unknown): CustomAction[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const accepted: CustomAction[] = [];
  for (const candidate of raw) {
    if (isValidAction(candidate)) {
      accepted.push({
        id: candidate.id,
        label: candidate.label,
        icon: candidate.icon,
        prompt: candidate.prompt,
      });
    }
    if (accepted.length >= CUSTOM_ACTION_LIMIT) {
      break;
    }
  }
  return accepted.length > 0 ? accepted : undefined;
};

const sanitize = (raw: Partial<CopilotPrefs>): CopilotPrefs => {
  const mode = VALID_MODES.has(raw.encryptionMode as EncryptionMode)
    ? (raw.encryptionMode as EncryptionMode)
    : DEFAULT_PREFS.encryptionMode;
  const idle =
    typeof raw.idleTimeoutMin === 'number' &&
    Number.isFinite(raw.idleTimeoutMin) &&
    raw.idleTimeoutMin >= 0
      ? raw.idleTimeoutMin
      : DEFAULT_PREFS.idleTimeoutMin;
  const sysPrompt = safeString(raw.customSystemPrompt, CUSTOM_SYSTEM_PROMPT_MAX);
  const actions = sanitizeCustomActions(raw.customActions);
  const out: CopilotPrefs = {
    version: 1,
    encryptionMode: mode,
    idleTimeoutMin: idle,
  };
  if (sysPrompt !== undefined && sysPrompt.trim().length > 0) {
    out.customSystemPrompt = sysPrompt;
  }
  if (actions !== undefined) {
    out.customActions = actions;
  }
  return out;
};

export const readPrefs = async (deps: PrefsDeps): Promise<CopilotPrefs> => {
  const logger = deps.logger ?? noopLogger;
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.io.readBytes(deps.prefsPath);
  } catch (e) {
    logger.warn(`${TAG} read failed (${(e as Error).message}) — using defaults`);
    return {...DEFAULT_PREFS};
  }
  if (bytes === null || bytes.length === 0) {
    return {...DEFAULT_PREFS};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch (e) {
    logger.warn(`${TAG} JSON parse failed (${(e as Error).message}) — using defaults`);
    return {...DEFAULT_PREFS};
  }
  if (!isShape(parsed)) {
    logger.warn(`${TAG} unexpected shape — using defaults`);
    return {...DEFAULT_PREFS};
  }
  return sanitize(parsed);
};

export const writePrefs = async (
  deps: PrefsDeps,
  prefs: CopilotPrefs,
): Promise<void> => {
  const sanitized = sanitize(prefs);
  const json = JSON.stringify(sanitized);
  await deps.io.writeBytes(deps.prefsPath, encodeUtf8(json));
};

export const setEncryptionMode = async (
  deps: PrefsDeps,
  mode: EncryptionMode,
): Promise<CopilotPrefs> => {
  const current = await readPrefs(deps);
  const next: CopilotPrefs = {...current, encryptionMode: mode};
  await writePrefs(deps, next);
  return next;
};

export const setIdleTimeoutMin = async (
  deps: PrefsDeps,
  minutes: number,
): Promise<CopilotPrefs> => {
  const current = await readPrefs(deps);
  const next: CopilotPrefs = {...current, idleTimeoutMin: minutes};
  await writePrefs(deps, next);
  return next;
};

// Sets (or clears) the global persona override. Passing null/empty
// drops the field — the chat falls back to the built-in SYSTEM_PROMPT.
export const setCustomSystemPrompt = async (
  deps: PrefsDeps,
  prompt: string | null,
): Promise<CopilotPrefs> => {
  const current = await readPrefs(deps);
  const next: CopilotPrefs = {...current};
  if (prompt === null || prompt.trim().length === 0) {
    delete next.customSystemPrompt;
  } else {
    next.customSystemPrompt = prompt;
  }
  await writePrefs(deps, next);
  return next;
};

// Replaces the user-defined quick action list (not a merge). The
// writer sanitizes shape + caps to CUSTOM_ACTION_LIMIT regardless.
export const setCustomActions = async (
  deps: PrefsDeps,
  actions: CustomAction[],
): Promise<CopilotPrefs> => {
  const current = await readPrefs(deps);
  const next: CopilotPrefs = {...current, customActions: actions};
  await writePrefs(deps, next);
  return next;
};
