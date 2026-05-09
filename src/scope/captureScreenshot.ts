// Captures the current note page as a PNG and base64-encodes it for
// attachment to a provider request.
//
// Two-step: PluginCommAPI tells us which file/page is current;
// PluginFileAPI.generateNotePng renders it (white background, 1x);
// the bytes are read back via fetch('file://...').
//
// Only `.note` files are supported. Documents (`.pdf` / `.epub`)
// would need a different SDK entrypoint; we log + skip them so the
// chat degrades gracefully to text-only mode.

import {arrayBufferToBase64} from './base64';
import type {PageContext} from './pageContext';

const TAG = '[captureScreenshot]';

export type CommLike = {
  getCurrentFilePath: () => Promise<unknown>;
  getCurrentPageNum: () => Promise<unknown>;
  // Accepts an Element[] and the page size; resolves to the
  // recognized text in `result`.
  recognizeElements: (
    elements: unknown[],
    size: {width: number; height: number},
  ) => Promise<unknown>;
};

export type FileApiLike = {
  generateNotePng: (params: {
    notePath: string;
    page: number;
    times: number;
    pngPath: string;
    type: number;
  }) => Promise<unknown>;
  getElements: (page: number, notePath: string) => Promise<unknown>;
  getPageSize: (notePath: string, page: number) => Promise<unknown>;
};

export type ManagerLike = {
  getPluginDirPath: () => Promise<string | null | undefined>;
};

export type Logger = {
  log: (msg: string) => void;
  warn: (msg: string) => void;
};

export type CaptureDeps = {
  comm: CommLike;
  file: FileApiLike;
  manager: ManagerLike;
  fetchFn?: typeof fetch;
  logger?: Logger;
};

// Each capture writes to a unique scratch path so two captures kicked
// off in quick succession (rapid sidebar reopens) cannot read each
// other's bytes mid-render. The counter disambiguates within a
// single millisecond; Date.now() keeps filenames human-skimmable.
const SCRATCH_PREFIX = 'copilot-page';
let scratchCounter = 0;
const nextScratchFilename = (): string =>
  `${SCRATCH_PREFIX}-${Date.now()}-${scratchCounter++}.png`;

// Both APIs return the SDK's APIResponse envelope: {success, result, error}.
// Unwrap defensively — the field names and shapes are runtime-loose.
const unwrapString = (raw: unknown): string | null => {
  if (raw && typeof raw === 'object' && 'result' in raw) {
    const r = (raw as {result?: unknown}).result;
    if (typeof r === 'string' && r.length > 0) {
      return r;
    }
  }
  return null;
};

const unwrapNumber = (raw: unknown): number | null => {
  if (raw && typeof raw === 'object' && 'result' in raw) {
    const r = (raw as {result?: unknown}).result;
    if (typeof r === 'number' && Number.isFinite(r)) {
      return r;
    }
  }
  return null;
};

const isNoteFile = (path: string): boolean => /\.note$/i.test(path);

// Walks an Element[] and returns concatenated typed-text content
// (textBox.textContentFull). Defensive against shape drift — the SDK
// runtime types are loose (Object), so we narrow at every step.
const extractTypedText = (elements: unknown): string => {
  if (!Array.isArray(elements)) {
    return '';
  }
  const parts: string[] = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') {
      continue;
    }
    const tb = (el as {textBox?: unknown}).textBox;
    if (tb && typeof tb === 'object') {
      const content = (tb as {textContentFull?: unknown}).textContentFull;
      if (typeof content === 'string' && content.length > 0) {
        parts.push(content);
      }
    }
  }
  return parts.join('\n');
};

const unwrapPageSize = (
  raw: unknown,
): {width: number; height: number} | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = (raw as {result?: unknown}).result;
  if (!r || typeof r !== 'object') {
    return null;
  }
  const w = (r as {width?: unknown}).width;
  const h = (r as {height?: unknown}).height;
  if (typeof w !== 'number' || typeof h !== 'number') {
    return null;
  }
  return {width: w, height: h};
};

const unwrapElements = (raw: unknown): unknown[] => {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const r = (raw as {result?: unknown}).result;
  return Array.isArray(r) ? r : [];
};

// Best-effort extraction. Each step is tolerant of failure — if any
// SDK call throws or returns junk, we just skip its contribution and
// keep going. The page-text is a "nice to have" addition; the chat
// still works image-only or even prompt-only when it's missing.
const buildPageText = async (
  deps: CaptureDeps,
  notePath: string,
  page: number,
): Promise<string> => {
  let elements: unknown[] = [];
  try {
    elements = unwrapElements(await deps.file.getElements(page, notePath));
  } catch (e) {
    deps.logger?.warn(
      `${TAG} getElements threw: ${(e as Error).message} — text path skipped`,
    );
    return '';
  }

  const typedText = extractTypedText(elements);

  let recognized = '';
  if (elements.length > 0) {
    try {
      const sizeResp = await deps.file.getPageSize(notePath, page);
      const pageSize = unwrapPageSize(sizeResp);
      if (pageSize !== null) {
        const recogResp = await deps.comm.recognizeElements(
          elements,
          pageSize,
        );
        if (recogResp && typeof recogResp === 'object') {
          const r = (recogResp as {result?: unknown}).result;
          if (typeof r === 'string') {
            recognized = r;
          }
        }
      }
    } catch (e) {
      deps.logger?.warn(
        `${TAG} recognizeElements threw: ${(e as Error).message} — handwriting skipped`,
      );
    }
  }

  // Compose: typed text first (it's the most reliable signal), then
  // recognized handwriting beneath, separated so the LLM can tell
  // them apart if needed.
  const parts: string[] = [];
  if (typedText.length > 0) {
    parts.push(typedText);
  }
  if (recognized.trim().length > 0) {
    parts.push(recognized.trim());
  }
  return parts.join('\n\n');
};

export const captureCurrentPage = async (
  deps: CaptureDeps,
): Promise<PageContext | null> => {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const noop = (): void => {};
  const logger: Logger = deps.logger ?? {log: noop, warn: noop};

  let notePath: string | null;
  let page: number | null;
  try {
    notePath = unwrapString(await deps.comm.getCurrentFilePath());
    page = unwrapNumber(await deps.comm.getCurrentPageNum());
  } catch (e) {
    logger.warn(`${TAG} comm probe threw: ${(e as Error).message}`);
    return null;
  }
  if (notePath === null || page === null) {
    logger.log(`${TAG} no current file/page — skipping screenshot`);
    return null;
  }
  if (!isNoteFile(notePath)) {
    logger.log(
      `${TAG} current file is not a .note (${notePath}) — skipping screenshot`,
    );
    return null;
  }

  let pluginDir: string | null | undefined;
  try {
    pluginDir = await deps.manager.getPluginDirPath();
  } catch (e) {
    logger.warn(`${TAG} getPluginDirPath threw: ${(e as Error).message}`);
    return null;
  }
  // Some firmware builds return null/undefined for getPluginDirPath
  // before any plugin file has been written — fall back to a known-
  // writable Android-data path the SDK uses internally.
  const dir = pluginDir && pluginDir.length > 0 ? pluginDir : '/sdcard/Android/data';
  const pngPath = `${dir}/${nextScratchFilename()}`;

  let renderResp: unknown;
  try {
    renderResp = await deps.file.generateNotePng({
      notePath,
      page,
      times: 1,
      pngPath,
      type: 1, // 1 = white background; 0 = transparent
    });
  } catch (e) {
    logger.warn(`${TAG} generateNotePng threw: ${(e as Error).message}`);
    return null;
  }
  if (
    !renderResp ||
    typeof renderResp !== 'object' ||
    (renderResp as {success?: unknown}).success !== true
  ) {
    logger.warn(
      `${TAG} generateNotePng failed: ${JSON.stringify(renderResp)}`,
    );
    return null;
  }

  let bytes: ArrayBuffer;
  try {
    const res = await fetchFn(`file://${pngPath}`);
    if (!res.ok) {
      logger.warn(`${TAG} png fetch returned status ${res.status}`);
      return null;
    }
    bytes = await res.arrayBuffer();
  } catch (e) {
    logger.warn(`${TAG} png fetch threw: ${(e as Error).message}`);
    return null;
  }

  const screenshotBase64 = arrayBufferToBase64(bytes);
  // Best-effort transcription of the page text. If extraction fails
  // we still return the screenshot — image-capable providers can
  // work from that alone; DeepSeek will get an empty pageText and
  // log a warning at send time.
  const pageText = await buildPageText(deps, notePath, page);

  logger.log(
    `${TAG} captured note=${notePath} page=${page} ` +
      `bytes=${bytes.byteLength} base64.length=${screenshotBase64.length} ` +
      `pageText.length=${pageText.length}`,
  );
  return {
    notePath,
    page,
    screenshotPath: pngPath,
    screenshotBase64,
    pageText,
  };
};
