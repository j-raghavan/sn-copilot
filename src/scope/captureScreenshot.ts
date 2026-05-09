// Captures the current page as a PNG and base64-encodes it for
// attachment to a provider request.
//
// Two paths share the same bytes-from-disk read step but use
// different SDK entrypoints:
//   .note         → PluginFileAPI.generateNotePng + getElements +
//                   recognizeElements (typed text + handwriting OCR).
//   .pdf / .epub  → PluginDocAPI.generateDocImage + getCurrentDocText.
// Other extensions are logged and skipped so the chat degrades
// gracefully to text-only mode without claiming context it doesn't
// have.

import {arrayBufferToBase64} from './base64';
import type {PageContext} from './pageContext';

const TAG = '[captureScreenshot]';

// Doc renders take a required size; Supernote 7.8" portrait is the
// most common form factor and produces a readable page at this
// resolution. Callers can override via CaptureDeps.docImageSize.
const DEFAULT_DOC_IMAGE_SIZE = {width: 1404, height: 1872};

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

export type DocApiLike = {
  generateDocImage: (
    docPath: string,
    page: number,
    pngPath: string,
    size: {width: number; height: number},
  ) => Promise<unknown>;
  getCurrentDocText: (page: number) => Promise<unknown>;
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
  doc: DocApiLike;
  manager: ManagerLike;
  fetchFn?: typeof fetch;
  logger?: Logger;
  docImageSize?: {width: number; height: number};
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

type FileKind = 'note' | 'doc' | 'unsupported';

const classifyFile = (path: string): FileKind => {
  if (/\.note$/i.test(path)) {
    return 'note';
  }
  if (/\.(pdf|epub)$/i.test(path)) {
    return 'doc';
  }
  return 'unsupported';
};

const readPngAsBase64 = async (
  fetchFn: typeof fetch,
  pngPath: string,
  logger: Logger,
): Promise<{base64: string; byteLength: number} | null> => {
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
  return {
    base64: arrayBufferToBase64(bytes),
    byteLength: bytes.byteLength,
  };
};

const resolveScratchPath = async (
  manager: ManagerLike,
  logger: Logger,
): Promise<string | null> => {
  let pluginDir: string | null | undefined;
  try {
    pluginDir = await manager.getPluginDirPath();
  } catch (e) {
    logger.warn(`${TAG} getPluginDirPath threw: ${(e as Error).message}`);
    return null;
  }
  // Some firmware builds return null/undefined for getPluginDirPath
  // before any plugin file has been written — fall back to a known-
  // writable Android-data path the SDK uses internally.
  const dir = pluginDir && pluginDir.length > 0 ? pluginDir : '/sdcard/Android/data';
  return `${dir}/${nextScratchFilename()}`;
};

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

const captureNotePage = async (
  deps: CaptureDeps,
  notePath: string,
  page: number,
  pngPath: string,
  fetchFn: typeof fetch,
  logger: Logger,
): Promise<PageContext | null> => {
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

  const png = await readPngAsBase64(fetchFn, pngPath, logger);
  if (png === null) {
    return null;
  }
  // Best-effort transcription of the page text. If extraction fails
  // we still return the screenshot — image-capable providers can
  // work from that alone; DeepSeek will get an empty pageText and
  // log a warning at send time.
  const pageText = await buildPageText(deps, notePath, page);

  logger.log(
    `${TAG} captured note=${notePath} page=${page} ` +
      `bytes=${png.byteLength} base64.length=${png.base64.length} ` +
      `pageText.length=${pageText.length}`,
  );
  return {
    notePath,
    page,
    screenshotPath: pngPath,
    screenshotBase64: png.base64,
    pageText,
  };
};

const captureDocPage = async (
  deps: CaptureDeps,
  docPath: string,
  page: number,
  pngPath: string,
  fetchFn: typeof fetch,
  logger: Logger,
): Promise<PageContext | null> => {
  const size = deps.docImageSize ?? DEFAULT_DOC_IMAGE_SIZE;

  let renderResp: unknown;
  try {
    renderResp = await deps.doc.generateDocImage(docPath, page, pngPath, size);
  } catch (e) {
    logger.warn(`${TAG} generateDocImage threw: ${(e as Error).message}`);
    return null;
  }
  if (
    !renderResp ||
    typeof renderResp !== 'object' ||
    (renderResp as {success?: unknown}).success !== true
  ) {
    logger.warn(
      `${TAG} generateDocImage failed: ${JSON.stringify(renderResp)}`,
    );
    return null;
  }

  const png = await readPngAsBase64(fetchFn, pngPath, logger);
  if (png === null) {
    return null;
  }
  // PluginDocAPI.getCurrentDocText already returns extracted text for
  // the page (PDFs ship with text layers; EPUBs are HTML). Treat it
  // as best-effort like the note path — a failure shouldn't drop the
  // screenshot.
  let pageText = '';
  try {
    pageText = unwrapString(await deps.doc.getCurrentDocText(page)) ?? '';
  } catch (e) {
    logger.warn(
      `${TAG} getCurrentDocText threw: ${(e as Error).message} — text path skipped`,
    );
  }

  logger.log(
    `${TAG} captured doc=${docPath} page=${page} ` +
      `bytes=${png.byteLength} base64.length=${png.base64.length} ` +
      `pageText.length=${pageText.length}`,
  );
  return {
    notePath: docPath,
    page,
    screenshotPath: pngPath,
    screenshotBase64: png.base64,
    pageText,
  };
};

export const captureCurrentPage = async (
  deps: CaptureDeps,
): Promise<PageContext | null> => {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const noop = (): void => {};
  const logger: Logger = deps.logger ?? {log: noop, warn: noop};

  let filePath: string | null;
  let page: number | null;
  try {
    filePath = unwrapString(await deps.comm.getCurrentFilePath());
    page = unwrapNumber(await deps.comm.getCurrentPageNum());
  } catch (e) {
    logger.warn(`${TAG} comm probe threw: ${(e as Error).message}`);
    return null;
  }
  if (filePath === null || page === null) {
    logger.log(`${TAG} no current file/page — skipping screenshot`);
    return null;
  }
  const kind = classifyFile(filePath);
  if (kind === 'unsupported') {
    logger.log(
      `${TAG} unsupported file type (${filePath}) — skipping screenshot`,
    );
    return null;
  }

  const pngPath = await resolveScratchPath(deps.manager, logger);
  if (pngPath === null) {
    return null;
  }

  if (kind === 'note') {
    return captureNotePage(deps, filePath, page, pngPath, fetchFn, logger);
  }
  return captureDocPage(deps, filePath, page, pngPath, fetchFn, logger);
};
