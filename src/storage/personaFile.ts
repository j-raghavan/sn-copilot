// User-managed persona override file.
//
// Path: `<DEFAULT_KEY_ROOT>/system_prompt.txt`
//   (`/storage/emulated/0/MyStyle/SnCopilot/system_prompt.txt`)
//
// The whole file content IS the persona prompt — no special syntax,
// no envelope, no key/value pairs. The user can drop a text file in
// via USB or any cloud-sync provider, or edit it through the Persona
// section in Settings (Save writes the file back).
//
// Empty / missing file → ChatView falls back to the built-in
// SYSTEM_PROMPT. Trimmed file content is what gets sent on the wire;
// a file containing only whitespace is treated as "no override".
//
// Privacy: persona content lives plaintext alongside the key files,
// regardless of vault encryption. The user explicitly opted into
// this file-managed model so they can edit it externally — moving
// it into the encrypted vault would defeat that.

import {decodeUtf8, encodeUtf8} from '../sdk/utf8';
import type {Logger} from '../sdk/types';
import {DEFAULT_KEY_ROOT} from './keyFiles';
import type {FileIo} from './fileIo';

const TAG = '[personaFile]';
export const PERSONA_FILENAME = 'system_prompt.txt';
export const PERSONA_PATH = `${DEFAULT_KEY_ROOT}/${PERSONA_FILENAME}`;
// Same cap as the previous prefs-based persona — prompts longer than
// this are dropped at read time rather than silently bloating every
// outbound request.
export const PERSONA_MAX_CHARS = 2000;

const NOOP = (): void => undefined;
const noopLogger: Logger = {log: NOOP, warn: NOOP, error: NOOP};

export type PersonaDeps = {
  io: FileIo;
  // Override only used in tests; production wires PERSONA_PATH.
  personaPath?: string;
  logger?: Logger;
};

const pathOf = (deps: PersonaDeps): string =>
  deps.personaPath ?? PERSONA_PATH;

// Reads the persona override. Returns `null` when no override is
// present (missing file, empty/whitespace-only content, or content
// past the length cap). Callers fall back to SYSTEM_PROMPT.
export const readPersona = async (
  deps: PersonaDeps,
): Promise<string | null> => {
  const logger = deps.logger ?? noopLogger;
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.io.readBytes(pathOf(deps));
  } catch (e) {
    logger.warn(`${TAG} read failed (${(e as Error).message}) — no override`);
    return null;
  }
  if (bytes === null || bytes.length === 0) {
    return null;
  }
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch (e) {
    logger.warn(`${TAG} utf-8 decode failed (${(e as Error).message})`);
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > PERSONA_MAX_CHARS) {
    logger.warn(
      `${TAG} persona over cap (${trimmed.length} > ${PERSONA_MAX_CHARS}) — using built-in`,
    );
    return null;
  }
  return trimmed;
};

// Writes the persona to disk. Whitespace-only / empty input clears
// the file (so the next read falls back to SYSTEM_PROMPT).
export const writePersona = async (
  deps: PersonaDeps,
  next: string | null,
): Promise<void> => {
  const logger = deps.logger ?? noopLogger;
  if (next === null || next.trim().length === 0) {
    await deps.io.remove(pathOf(deps));
    logger.log(`${TAG} cleared`);
    return;
  }
  if (next.length > PERSONA_MAX_CHARS) {
    throw new RangeError(
      `${TAG} writePersona: content > ${PERSONA_MAX_CHARS} chars`,
    );
  }
  await deps.io.writeBytes(pathOf(deps), encodeUtf8(next));
  logger.log(`${TAG} wrote ${next.length} chars`);
};

export const clearPersona = async (deps: PersonaDeps): Promise<void> => {
  await deps.io.remove(pathOf(deps));
};
