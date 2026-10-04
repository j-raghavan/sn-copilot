// Writes the PilotChat's content into the note it was opened from, on new
// pages inserted right after the page the user was on, so nothing already
// in the note is touched.
//
// The sequence follows what is proven on device: sn-mindmap writes into an
// open note with createElement per element, one additive insertElements
// per page and then reloadFile; the SDK asks for saveCurrentNote before
// file-level writes to the open note. Stroke points go through the SDK's
// own PointUtils (page pixels to the pen sensor's EMR frame), and the pen
// fields copy a stroke already in the note, so inserted writing is drawn
// the way the device draws the user's own.

import type {NotePageContent, Size} from './noteLayout';

type Point = {x: number; y: number};

/** ElementType.TYPE_STROKE and TYPE_TEXT in sn-plugin-lib. */
const TYPE_STROKE = 0;
const TYPE_TEXT = 500;

// Used when the page has no stroke to copy: the fields of the device's own
// strokes in the handwriting-recognition test.
export const DEFAULT_PEN = {penType: 15, penColor: 0, thickness: 877};

// Pressure for each inserted point; the device's own strokes sample around
// 2000-3500.
const PRESSURE = 2800;

// The answers' bars: a wide light-gray needle, 24 px across on a 1920 px
// page (seen on device).
const BAR_PEN = {penType: 10, penColor: 0xc9, thickness: 2500};

// System page templates ship under a bare name plus device variants
// (style_white, style_white_a5x, style_white_a5x2 in /vendor/etc/notestyle
// on a Nomad). getNotePageTemplate reports the device variant, but
// insertNotePage refused both that name and the SDK example's
// 'style_blank' with "Background template file does not exist!", while
// every template exists under its bare name. So the bare name is passed.
const DEVICE_SUFFIX = /_a5x2?$/;

// The fallback page template: plain white, present in every variant.
const BLANK_TEMPLATE = 'style_white';

export type NoteTarget = {notePath: string; page: number; pageSize: Size};

type PenProfile = typeof DEFAULT_PEN;

export type NoteWriterDeps = {
  getCurrentFilePath: () => Promise<unknown>;
  getCurrentPageNum: () => Promise<unknown>;
  getPageSize: (notePath: string, page: number) => Promise<unknown>;
  saveCurrentNote: () => Promise<unknown>;
  getNotePageTemplate: (notePath: string, page: number) => Promise<unknown>;
  insertNotePage: (params: {
    notePath: string;
    page: number;
    template: string;
  }) => Promise<unknown>;
  removeNotePage: (notePath: string, page: number) => Promise<unknown>;
  getElements: (page: number, notePath: string) => Promise<unknown>;
  createElement: (type: number) => Promise<unknown>;
  insertElements: (
    notePath: string,
    page: number,
    elements: object[],
  ) => Promise<unknown>;
  reloadFile: () => Promise<unknown>;
  jumpToPage: (page: number) => Promise<unknown>;
  toEmr: (point: Point, pageSize: Size) => Point;
  maxX: (pageSize: Size) => number;
  maxY: (pageSize: Size) => number;
};

/** Writing into the note failed; nothing after the failing step was written. */
export class NoteWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteWriteError';
  }
}

type Envelope = {
  success?: unknown;
  result?: unknown;
  error?: {message?: unknown};
};

const envelope = (raw: unknown): Envelope =>
  raw !== null && typeof raw === 'object' ? (raw as Envelope) : {};

const resultOf = (raw: unknown): unknown => envelope(raw).result;

/** The envelope's result, or a NoteWriteError naming [step]. */
const required = (raw: unknown, step: string): unknown => {
  const e = envelope(raw);
  if (e.success !== true) {
    const why =
      typeof e.error?.message === 'string' ? `: ${e.error.message}` : '';
    throw new NoteWriteError(`${step} failed${why}`);
  }
  return e.result;
};

const isSize = (v: unknown): v is Size =>
  v !== null &&
  typeof v === 'object' &&
  typeof (v as Size).width === 'number' &&
  typeof (v as Size).height === 'number';

/** The note and page the PilotChat was opened from, and that page's pixel size. */
export const resolveNoteTarget = async (
  deps: NoteWriterDeps,
): Promise<NoteTarget> => {
  const notePath = resultOf(await deps.getCurrentFilePath());
  const page = resultOf(await deps.getCurrentPageNum());
  if (
    typeof notePath !== 'string' ||
    !/\.note$/i.test(notePath) ||
    typeof page !== 'number'
  ) {
    throw new NoteWriteError('No open note to write into');
  }
  const pageSize = required(
    await deps.getPageSize(notePath, page),
    'getPageSize',
  );
  if (!isSize(pageSize)) {
    throw new NoteWriteError('getPageSize returned no size');
  }
  return {
    notePath,
    page,
    pageSize: {width: pageSize.width, height: pageSize.height},
  };
};

// A stroke's pen fields, taken from the first stroke on [page] that has them.
const penOf = async (
  deps: NoteWriterDeps,
  target: NoteTarget,
): Promise<PenProfile> => {
  try {
    const elements = resultOf(
      await deps.getElements(target.page, target.notePath),
    );
    if (Array.isArray(elements)) {
      for (const e of elements) {
        const stroke = (e as {stroke?: {penType?: unknown; penColor?: unknown}})
          ?.stroke;
        const thickness = (e as {thickness?: unknown})?.thickness;
        if (
          (e as {type?: unknown}).type === TYPE_STROKE &&
          typeof stroke?.penType === 'number' &&
          typeof stroke.penColor === 'number' &&
          typeof thickness === 'number' &&
          thickness > 0
        ) {
          return {
            penType: stroke.penType,
            penColor: stroke.penColor,
            thickness,
          };
        }
      }
    }
  } catch {
    // The defaults are the fields the device's own strokes carried.
  }
  return DEFAULT_PEN;
};

// The template of the page the user was on, so the new pages match it.
// Custom templates are not addressable by name, so they get the blank one.
const templateOf = async (
  deps: NoteWriterDeps,
  target: NoteTarget,
): Promise<string> => {
  try {
    const info = resultOf(
      await deps.getNotePageTemplate(target.notePath, target.page),
    ) as {name?: unknown; md5?: unknown} | undefined;
    const isSystem = info?.md5 === '0' || info?.md5 === 0;
    if (isSystem && typeof info?.name === 'string' && info.name.length > 0) {
      return info.name.replace(DEVICE_SUFFIX, '');
    }
  } catch {
    // Fall through to the blank page.
  }
  return BLANK_TEMPLATE;
};

type StrokeElement = {
  pageNum: number;
  layerNum: number;
  maxX: number;
  maxY: number;
  thickness: number;
  stroke: {
    penType: number;
    penColor: number;
    points: {setRange: (s: number, e: number, v: Point[]) => Promise<boolean>};
    pressures: {
      setRange: (s: number, e: number, v: number[]) => Promise<boolean>;
    };
  };
  recycle?: () => Promise<void>;
};

type TextElement = {
  pageNum: number;
  layerNum: number;
  textBox: object;
  recycle?: () => Promise<void>;
};

const created = async <T>(deps: NoteWriterDeps, type: number): Promise<T> =>
  required(await deps.createElement(type), 'createElement') as T;

const buildStroke = async (
  deps: NoteWriterDeps,
  flat: number[],
  page: number,
  target: NoteTarget,
  pen: PenProfile,
  elements: Array<StrokeElement | TextElement>,
): Promise<void> => {
  const element = await created<StrokeElement>(deps, TYPE_STROKE);
  elements.push(element);
  element.pageNum = page;
  element.layerNum = 0;
  element.maxX = deps.maxX(target.pageSize);
  element.maxY = deps.maxY(target.pageSize);
  element.thickness = pen.thickness;
  element.stroke.penType = pen.penType;
  element.stroke.penColor = pen.penColor;
  const points: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const emr = deps.toEmr({x: flat[i], y: flat[i + 1]}, target.pageSize);
    points.push({x: Math.round(emr.x), y: Math.round(emr.y)});
  }
  await element.stroke.points.setRange(0, points.length, points);
  await element.stroke.pressures.setRange(
    0,
    points.length,
    points.map(() => PRESSURE),
  );
};

// Builds [content]'s elements into [elements], which the caller owns so it
// can recycle every one made, even when building stops part way.
const buildPage = async (
  deps: NoteWriterDeps,
  content: NotePageContent,
  page: number,
  target: NoteTarget,
  pen: PenProfile,
  elements: Array<StrokeElement | TextElement>,
): Promise<void> => {
  for (const bar of content.bars) {
    await buildStroke(deps, bar, page, target, BAR_PEN, elements);
  }
  for (const flat of content.strokes) {
    await buildStroke(deps, flat, page, target, pen, elements);
  }
  for (const {text, rect, fontSize, bold} of content.texts) {
    const element = await created<TextElement>(deps, TYPE_TEXT);
    elements.push(element);
    element.pageNum = page;
    // Text boxes live on the main layer only.
    element.layerNum = 0;
    element.textBox = {
      textContentFull: text,
      textRect: rect,
      fontSize,
      textAlign: 0,
      textBold: bold ? 1 : 0,
      textItalics: 0,
      textFrameWidthType: 0,
      textFrameStyle: 0,
      textEditable: 0,
    };
  }
};

/** What one written page holds, to know it again: its texts and stroke count. */
export type PageSignature = {texts: string[]; strokes: number};

/** Where a conversation was written into a note, and what each page held. */
export type Insertion = {
  notePath: string;
  firstPage: number;
  pages: PageSignature[];
};

/** The signature of each of [pages], as writeToNote writes it. */
export const signaturesOf = (pages: NotePageContent[]): PageSignature[] =>
  pages.map(p => ({
    texts: p.texts.map(t => t.text),
    strokes: p.bars.length + p.strokes.length,
  }));

const sorted = (texts: string[]): string => JSON.stringify([...texts].sort());

// Why [page] no longer holds exactly what [signature] says was written
// there, or null if it does: the same texts and as many strokes. Anything
// the user wrote or erased on it since changes one or the other.
const differenceOn = async (
  deps: NoteWriterDeps,
  notePath: string,
  page: number,
  signature: PageSignature,
): Promise<string | null> => {
  const elements = resultOf(await deps.getElements(page, notePath));
  if (!Array.isArray(elements)) {
    return `page ${page} unreadable`;
  }
  const texts: string[] = [];
  let strokes = 0;
  for (const e of elements as Array<{
    type?: unknown;
    textBox?: {textContentFull?: unknown};
  }>) {
    if (e?.type === TYPE_STROKE) {
      strokes++;
    } else if (e?.type === TYPE_TEXT) {
      const text = e.textBox?.textContentFull;
      texts.push(typeof text === 'string' ? text : '');
    } else {
      return `page ${page} holds an element of type ${String(e?.type)}`;
    }
  }
  if (strokes !== signature.strokes) {
    return `page ${page} has ${strokes} strokes, ${signature.strokes} written`;
  }
  if (sorted(texts) !== sorted(signature.texts)) {
    return `page ${page} texts differ (${texts.length}, ${signature.texts.length} written)`;
  }
  return null;
};

export type Removal = {removed: true} | {removed: false; why: string};

/**
 * Takes an earlier [insertion] out of its note, but only if every page of
 * it is still exactly as written: a page the user has written on, or that
 * has moved, is never removed. Says why when it was not.
 */
export const removeInsertion = async (
  insertion: Insertion,
  deps: NoteWriterDeps,
): Promise<Removal> => {
  const {notePath, firstPage, pages} = insertion;
  if (pages.length === 0) {
    return {removed: false, why: 'nothing inserted'};
  }
  // Reading the file needs the open note's in-memory edits saved first.
  required(await deps.saveCurrentNote(), 'saveCurrentNote');
  for (let i = 0; i < pages.length; i++) {
    const page = firstPage + i;
    const why = await differenceOn(deps, notePath, page, pages[i]).catch(
      (e: unknown) => `page ${page} unreadable: ${String(e)}`,
    );
    if (why !== null) {
      return {removed: false, why};
    }
  }
  // Last first, so the earlier pages keep their numbers. The open note
  // still holds removed pages in memory until it re-reads the file, and
  // saving it before then would write them back: so it re-reads after any
  // page went, even when a later one could not be removed.
  let removed = 0;
  try {
    for (let i = pages.length - 1; i >= 0; i--) {
      required(
        await deps.removeNotePage(notePath, firstPage + i),
        'removeNotePage',
      );
      removed++;
    }
  } finally {
    if (removed > 0) {
      await deps.reloadFile().catch(() => undefined);
    }
  }
  return {removed: true};
};

/**
 * Writes [pages] into the note on new pages after the target page, then
 * shows the [show]n one of them. Returns how many pages were written.
 */
export const writeToNote = async (
  pages: NotePageContent[],
  target: NoteTarget,
  deps: NoteWriterDeps,
  show: 'first' | 'last' = 'first',
): Promise<number> => {
  if (pages.length === 0) {
    return 0;
  }
  // File-level writes to the open note need its in-memory edits saved first.
  required(await deps.saveCurrentNote(), 'saveCurrentNote');
  const [template, pen] = await Promise.all([
    templateOf(deps, target),
    penOf(deps, target),
  ]);
  // Pages added so far, so a failure part way leaves no empty page behind.
  const added: number[] = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      const page = target.page + 1 + i;
      const params = {notePath: target.notePath, page, template};
      if (envelope(await deps.insertNotePage(params)).success !== true) {
        required(
          await deps.insertNotePage({...params, template: BLANK_TEMPLATE}),
          'insertNotePage',
        );
      }
      added.push(page);
      const elements: Array<StrokeElement | TextElement> = [];
      try {
        await buildPage(deps, pages[i], page, target, pen, elements);
        required(
          await deps.insertElements(
            target.notePath,
            page,
            elements as object[],
          ),
          'insertElements',
        );
      } finally {
        // Element data lives in a native cache until recycled.
        await Promise.all(
          elements.map(e => e.recycle?.().catch(() => undefined)),
        );
      }
    }
  } catch (err) {
    // Last added first, so the earlier pages keep their numbers.
    for (const page of added.reverse()) {
      await deps.removeNotePage(target.notePath, page).catch(() => undefined);
    }
    if (added.length > 0) {
      await deps.reloadFile().catch(() => undefined);
    }
    throw err;
  }
  // The open note shows the new pages only after it re-reads the file.
  await deps.reloadFile();
  // Showing the pages is a courtesy: they are written whether or not it works.
  await deps
    .jumpToPage(target.page + (show === 'first' ? 1 : pages.length))
    .catch(() => undefined);
  return pages.length;
};
