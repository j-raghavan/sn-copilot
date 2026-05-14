// User-managed custom quick-action templates.
//
// Path: `<DEFAULT_KEY_ROOT>/custom_actions.txt`
//   (`/storage/emulated/0/MyStyle/SnCopilot/custom_actions.txt`)
//
// Format — one action per line:
//
//     label: prompt
//
//   - Whitespace is trimmed around `label` and `prompt`.
//   - The FIRST `:` is the separator. The prompt may contain colons.
//   - Lines starting with `#` are comments and skipped.
//   - Blank lines are skipped.
//   - Lines without a `:` are skipped with a warn log.
//   - At most CUSTOM_ACTION_LIMIT actions are accepted; the rest are
//     dropped with one warn log.
//
// Example file:
//   # Notes assistant quick actions — labels under 16 chars
//   Glossary: Define every technical term on this page.
//   Risks: List the risks implied by these notes.
//   Translate: Translate the page content into French.
//
// The plugin only READS this file; the user edits it externally
// (USB, WebDAV, any cloud sync). No CRUD UI inside the app — the
// CustomActionsSettings section shows a read-only preview.

import {decodeUtf8} from '../sdk/utf8';
import type {Logger} from '../sdk/types';
import {
  CUSTOM_ACTION_LABEL_MAX,
  CUSTOM_ACTION_LIMIT,
  CUSTOM_ACTION_PROMPT_MAX,
  type CustomAction,
} from '../types';
import {DEFAULT_KEY_ROOT} from './keyFiles';
import type {FileIo} from './fileIo';

const TAG = '[customActionsFile]';
export const CUSTOM_ACTIONS_FILENAME = 'custom_actions.txt';
export const CUSTOM_ACTIONS_PATH = `${DEFAULT_KEY_ROOT}/${CUSTOM_ACTIONS_FILENAME}`;

const NOOP = (): void => undefined;
const noopLogger: Logger = {log: NOOP, warn: NOOP, error: NOOP};

export type CustomActionsDeps = {
  io: FileIo;
  // Override only used in tests; production wires CUSTOM_ACTIONS_PATH.
  customActionsPath?: string;
  logger?: Logger;
};

const pathOf = (deps: CustomActionsDeps): string =>
  deps.customActionsPath ?? CUSTOM_ACTIONS_PATH;

// Parses one trimmed, non-comment line into a CustomAction. Returns
// null when the line can't be parsed; caller decides whether to warn
// or silently skip.
const parseLine = (
  raw: string,
  index: number,
): CustomAction | {error: string} => {
  const sep = raw.indexOf(':');
  if (sep === -1) {
    return {error: 'missing `:` separator'};
  }
  const label = raw.slice(0, sep).trim();
  const prompt = raw.slice(sep + 1).trim();
  if (label.length === 0) {
    return {error: 'blank label'};
  }
  if (prompt.length === 0) {
    return {error: 'blank prompt'};
  }
  if (label.length > CUSTOM_ACTION_LABEL_MAX) {
    return {error: `label > ${CUSTOM_ACTION_LABEL_MAX} chars`};
  }
  if (prompt.length > CUSTOM_ACTION_PROMPT_MAX) {
    return {error: `prompt > ${CUSTOM_ACTION_PROMPT_MAX} chars`};
  }
  return {
    // File-derived id: stable across runs (no random suffix) so the
    // history bubbles keep matching the action that was tapped.
    id: `file-${index}`,
    // Numbered display icon — the user said "user custom actions
    // 1, 2, 3…", so we render the 1-based index as the glyph.
    icon: String(index + 1),
    label,
    prompt,
  };
};

// Parses raw file text into an action list. Caps at
// CUSTOM_ACTION_LIMIT; never throws. Pure — exported for direct test
// coverage without an FS round-trip.
export const parseCustomActionsText = (
  text: string,
  logger: Logger = noopLogger,
): CustomAction[] => {
  const actions: CustomAction[] = [];
  let overflowWarned = false;
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }
    if (actions.length >= CUSTOM_ACTION_LIMIT) {
      if (!overflowWarned) {
        logger.warn(
          `${TAG} > ${CUSTOM_ACTION_LIMIT} actions — extras ignored`,
        );
        overflowWarned = true;
      }
      continue;
    }
    const result = parseLine(line, actions.length);
    if ('error' in result) {
      logger.warn(`${TAG} skipping line "${line}": ${result.error}`);
      continue;
    }
    actions.push(result);
  }
  return actions;
};

// Reads + parses the custom-actions file. Missing / unreadable file
// resolves to an empty list — the user simply has no customs.
export const readCustomActions = async (
  deps: CustomActionsDeps,
): Promise<CustomAction[]> => {
  const logger = deps.logger ?? noopLogger;
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.io.readBytes(pathOf(deps));
  } catch (e) {
    logger.warn(`${TAG} read failed (${(e as Error).message}) — empty list`);
    return [];
  }
  if (bytes === null || bytes.length === 0) {
    return [];
  }
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch (e) {
    logger.warn(`${TAG} utf-8 decode failed (${(e as Error).message})`);
    return [];
  }
  return parseCustomActionsText(text, logger);
};
