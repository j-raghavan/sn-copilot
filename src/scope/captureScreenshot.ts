// Captures the current page as a PNG and base64-encodes it for
// attachment to a provider request.
//
// Two paths share the same bytes-from-disk read step but use
// different SDK entrypoints:
//   .note         → PluginFileAPI.generateNotePng + getElements +
//                   recognizeElements (typed text + handwriting OCR).
//   .pdf / .epub  → PluginDocAPI.generateCurrentDocImage +
//                   getCurrentDocText.
// Other extensions are logged and skipped so the chat degrades
// gracefully to text-only mode without claiming context it doesn't
// have.

import {infoLog} from '../diagnostics/log';
import {arrayBufferToBase64} from './base64';
import type {PageContext} from './pageContext';

const TAG = '[captureScreenshot]';

// Doc renders take a required size; Supernote 7.8" portrait is the
// most common form factor and produces a readable page at this
// resolution. Callers can override via CaptureDeps.docImageSize.
const DEFAULT_DOC_IMAGE_SIZE = {width: 1404, height: 1872};

// generateCurrentDocImage image type: 0 renders the page without
// text-selection styles, 1 includes them (highlight, underline, …).
// We want the render to match what the reader actually sees, and a
// user's highlights are page content a copilot is routinely asked
// about ("summarise what I marked"), so we ask for type 1.
const DOC_IMAGE_TYPE_WITH_SELECTION = 1;

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
  // Renders a page of the *currently open* document; unlike the
  // pre-0.1.65 generateDocImage it takes no docPath.
  generateCurrentDocImage: (
    page: number,
    pngPath: string,
    size: {width: number; height: number},
    type: number,
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
  // Optional so tests and legacy call sites keep working. When
  // provided (production wiring passes FileUtils.deleteFile), the
  // scratch PNG is removed as soon as its bytes are in memory — the
  // rendered page never persists on disk beyond the capture call.
  deleteFile?: (path: string) => Promise<boolean>;
};

// Each capture writes to a unique scratch path so two captures kicked
// off in quick succession (rapid sidebar reopens) cannot read each
// other's bytes mid-render. The counter disambiguates within a
// single millisecond; Date.now() keeps filenames human-skimmable.
const SCRATCH_PREFIX = 'copilot-page';
let scratchCounter = 0;
const nextScratchFilename = (): string =>
  `${SCRATCH_PREFIX}-${Date.now()}-${scratchCounter++}.png`;

// Matches every filename nextScratchFilename can produce — used by the
// startup sweep to recognise orphans left by crashes or by versions
// that predate scratch deletion. Anchored and digit-strict so a
// user file that merely contains "copilot-page" can never match.
const SCRATCH_FILENAME_RE = /^copilot-page-\d+-\d+\.png$/;

// Last path segment. Comparing by basename rather than full path keeps
// the in-flight check immune to shape differences between the path we
// mint and the one listFiles reports (a trailing slash on the plugin
// dir would otherwise yield '/dir//file.png' vs '/dir/file.png').
const baseNameOf = (path: string): string =>
  path.slice(path.lastIndexOf('/') + 1);

// Scratch files handed out by resolveScratchPath and not yet
// discarded, tracked by basename.
//
// The bootstrap sweep is fired fire-and-forget at module load while
// the sidebar button listener is registered moments later, so a tap
// can be rendering into a scratch file while the sweep is still
// resolving its directory. getPluginDirPath + listFiles are slow
// round-trips on e-ink storage, so the sweep's snapshot can legitimately
// include a file written after it started. Deleting that file makes
// readPngAsBase64 fetch a missing path, capture returns null, and the
// send goes out with no page context at all — a silent loss of the
// plugin's core feature with only a warn to show for it.
const inFlightScratch = new Set<string>();

// Best-effort removal of a scratch PNG. Capture must never fail
// because cleanup did — the bytes are already in memory when this
// runs — so failures log and move on.
const discardScratch = async (
  deps: CaptureDeps,
  pngPath: string,
  logger: Logger,
): Promise<void> => {
  // Released even when no deleteFile bridge is wired, and even when
  // the delete fails: once capture is done with the file the sweep is
  // the correct owner of it, and holding the name forever would make
  // an orphan permanently unsweepable.
  try {
    if (deps.deleteFile === undefined) {
      return;
    }
    try {
      const removed = await deps.deleteFile(pngPath);
      if (!removed) {
        logger.warn(`${TAG} scratch delete returned false: ${pngPath}`);
      }
    } catch (e) {
      logger.warn(`${TAG} scratch delete threw: ${(e as Error).message}`);
    }
  } finally {
    inFlightScratch.delete(baseNameOf(pngPath));
  }
};

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
  const filename = nextScratchFilename();
  inFlightScratch.add(filename);
  return `${dir}/${filename}`;
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
    // The render may have left a partial file behind — discard it.
    await discardScratch(deps, pngPath, logger);
    return null;
  }

  const png = await readPngAsBase64(fetchFn, pngPath, logger);
  // The PNG's job ends the moment its bytes are in memory. Deleting
  // here (success or not) keeps page renders from accumulating on
  // disk — they contain everything visible on the user's page.
  await discardScratch(deps, pngPath, logger);
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
  // Survives __DEV__=false so a logcat from a shipped build still
  // tells us "did capture work, did OCR yield text". No note path.
  infoLog(
    `${TAG} capture-note kind=note page=${page} ` +
      `pngBytes=${png.byteLength} base64.length=${png.base64.length} ` +
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
    renderResp = await deps.doc.generateCurrentDocImage(
      page,
      pngPath,
      size,
      DOC_IMAGE_TYPE_WITH_SELECTION,
    );
  } catch (e) {
    logger.warn(
      `${TAG} generateCurrentDocImage threw: ${(e as Error).message}`,
    );
    return null;
  }
  if (
    !renderResp ||
    typeof renderResp !== 'object' ||
    (renderResp as {success?: unknown}).success !== true
  ) {
    logger.warn(
      `${TAG} generateCurrentDocImage failed: ${JSON.stringify(renderResp)}`,
    );
    // The render may have left a partial file behind — discard it.
    await discardScratch(deps, pngPath, logger);
    return null;
  }

  const png = await readPngAsBase64(fetchFn, pngPath, logger);
  // Same policy as the note path: the rendered page never persists
  // on disk beyond the capture call.
  await discardScratch(deps, pngPath, logger);
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
  infoLog(
    `${TAG} capture-doc kind=doc page=${page} ` +
      `pngBytes=${png.byteLength} base64.length=${png.base64.length} ` +
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

// Startup sweep for scratch orphans. Captures interrupted by a crash
// (or written by plugin versions that predate scratch deletion) leave
// `copilot-page-<ts>-<n>.png` files behind; each one is a full render
// of a page the user had open. Called fire-and-forget at bootstrap.
//
// Sweeps the plugin's own private directory ONLY. It deliberately does
// not use resolveScratchPath's `/sdcard/Android/data` fallback: that is
// shared storage, and listing or deleting there needs FILE:READ +
// FILE:WRITE. On Chauvet firmware the framework throws SecurityException
// from inside RTNFileModule, synchronously, where no JS try/catch at the
// call site can catch it — the host then kills the plugin. Capture may
// still use the fallback (it writes a file it immediately reads back);
// an unattended bootstrap sweep must not.
//
// Deletion is filename-strict (SCRATCH_FILENAME_RE) and skips files a
// capture currently holds.
export type SweepDeps = {
  manager: ManagerLike;
  listFiles: (
    path: string,
  ) => Promise<Array<{path: string; type: number}> | null | undefined>;
  deleteFile: (path: string) => Promise<boolean>;
  logger?: Logger;
};

export const sweepScratchOrphans = async (deps: SweepDeps): Promise<number> => {
  const noop = (): void => {};
  const logger: Logger = deps.logger ?? {log: noop, warn: noop};
  let pluginDir: string | null | undefined;
  try {
    pluginDir = await deps.manager.getPluginDirPath();
  } catch (e) {
    logger.warn(`${TAG} sweep: getPluginDirPath threw: ${(e as Error).message}`);
    return 0;
  }
  if (!pluginDir || pluginDir.length === 0) {
    logger.log(`${TAG} sweep: no plugin dir — skipping (shared storage is out of scope)`);
    return 0;
  }
  const dir = pluginDir.endsWith('/') ? pluginDir.slice(0, -1) : pluginDir;
  let entries: Array<{path: string; type: number}> | null | undefined;
  try {
    entries = await deps.listFiles(dir);
  } catch (e) {
    logger.log(`${TAG} sweep: listFiles threw: ${(e as Error).message}`);
    return 0;
  }
  if (!entries || entries.length === 0) {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry.type !== 1) {
      continue;
    }
    const name = baseNameOf(entry.path);
    if (!SCRATCH_FILENAME_RE.test(name)) {
      continue;
    }
    if (inFlightScratch.has(name)) {
      continue; // a capture is writing or still reading this one
    }
    try {
      if (await deps.deleteFile(entry.path)) {
        removed++;
      }
    } catch (e) {
      logger.warn(`${TAG} sweep: delete threw: ${(e as Error).message}`);
    }
  }
  if (removed > 0) {
    // Count only — never file names or paths (log hygiene).
    infoLog(`${TAG} sweep removed ${removed} orphaned scratch file(s)`);
  }
  return removed;
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
