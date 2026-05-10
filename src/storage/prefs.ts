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

import {DEFAULT_PREFS, type CopilotPrefs, type EncryptionMode} from '../types';
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
  return {
    version: 1,
    encryptionMode: mode,
    idleTimeoutMin: idle,
  };
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
