/**
 * Tests for src/pilotchat/noteLayout — the PilotChat conversation set out
 * on notebook pages.
 *
 * Pins:
 *   1. noteStyle / noteTextStyle: the design's measures scale with the page,
 *      the labels clear of the note's toolbar, the answer width the content
 *      column.
 *   2. A header "PilotChat · <date>" opens the first page.
 *   3. Each question: a bold Q level with the handwriting, indented to the
 *      content column, nothing behind it. Each answer: a bold A level with
 *      its first paragraph, the paragraphs in the column closer together
 *      than question and answer, and one light bar beside them, never
 *      under the text.
 *   4. Handwriting wider than the column, or taller than a page, is scaled
 *      down to fit.
 *   5. A question that does not fit what is left of a page starts the next;
 *      an answer longer than a page carries on there with its bar, without
 *      a second A.
 *   6. Everything is in whole pixels (the firmware rejects fractions).
 *   7. headerDate formats without Intl.
 */
import {
  headerDate,
  layoutForNote,
  noteStyle,
  noteTextStyle,
  TEXT_HEIGHT_SAFETY,
  type NotePageContent,
  type NoteText,
} from '../src/pilotchat/noteLayout';
import type {ExportPayload} from '../src/native/PilotChatPageView';

const PAGE = {width: 1920, height: 2560};
const S = noteStyle(PAGE);
const DATE = 'Oct 3, 2026';

const writing = (...strokes: number[][]) => ({
  kind: 'writing' as const,
  strokes,
});
const paragraph = (text: string, height: number) => ({
  kind: 'paragraph' as const,
  text,
  height,
});
const payload = (...items: ExportPayload['items']): ExportPayload => ({
  pageWidth: 1920,
  items,
});

const textsNamed = (page: NotePageContent, text: string): NoteText[] =>
  page.texts.filter(t => t.text === text);

describe('noteStyle', () => {
  it('scales with the page and keeps the card clear of the toolbar', () => {
    expect(S).toEqual({
      left: 163,
      right: 96,
      top: 128,
      bottom: 128,
      barX: 278 - 31,
      barCap: 12,
      contentLeft: 278,
      contentRight: 1920 - 96,
      questionGap: 38,
      paragraphGap: 26,
      entryGap: 77,
      fontSize: 44,
      labelSize: 52,
      headerSize: 31,
    });
    // The note's toolbar covers the first 116 px of the page.
    expect(S.left).toBeGreaterThan(116);
  });

  it('gives the measuring width of the answer column', () => {
    expect(noteTextStyle(PAGE)).toEqual({
      fontSize: 44,
      textWidth: S.contentRight - S.contentLeft,
      maxHeight: 2560 - S.top - S.bottom,
    });
  });
});

describe('layoutForNote', () => {
  it('produces nothing for no content', () => {
    expect(layoutForNote(payload(), PAGE, DATE)).toEqual([]);
  });

  it('opens with a dated PilotChat header', () => {
    const [page] = layoutForNote(
      payload(writing([300, 0, 400, 50])),
      PAGE,
      DATE,
    );
    expect(page.texts[0]).toEqual({
      text: 'PilotChat · Oct 3, 2026',
      rect: {
        left: S.left,
        top: S.top,
        right: 1920 - S.right,
        bottom: S.top + 50,
      },
      fontSize: S.headerSize,
      bold: false,
    });
  });

  it('labels the question and the answer, with a bar beside the answer only', () => {
    const [page] = layoutForNote(
      payload(writing([900, 400, 1100, 500]), paragraph('A qubit…', 100)),
      PAGE,
      DATE,
    );
    const qTop = S.top + 50 + S.questionGap;
    // Handwriting indented to the content column, its top at the row's.
    expect(page.strokes).toEqual([
      [S.contentLeft, qTop, S.contentLeft + 200, qTop + 100],
    ]);
    const label = (text: string, top: number) => ({
      text,
      rect: {
        left: S.left,
        top,
        right: S.barX - S.barCap,
        bottom: top + Math.ceil(S.labelSize * 1.6),
      },
      fontSize: S.labelSize,
      bold: true,
    });
    expect(textsNamed(page, 'Q')).toEqual([label('Q', qTop)]);
    const aTop = qTop + 100 + S.questionGap;
    expect(textsNamed(page, 'A')).toEqual([label('A', aTop)]);
    const height = Math.ceil(100 * TEXT_HEIGHT_SAFETY);
    expect(textsNamed(page, 'A qubit…')[0]).toEqual({
      text: 'A qubit…',
      rect: {
        left: S.contentLeft,
        top: aTop,
        right: S.contentRight,
        bottom: aTop + height,
      },
      fontSize: S.fontSize,
      bold: false,
    });
    // One bar, left of the text, the text's own height, its round ends inside.
    expect(page.bars).toEqual([
      [S.barX, aTop + S.barCap, S.barX, aTop + 100 - S.barCap],
    ]);
    expect(S.barX + S.barCap).toBeLessThan(S.contentLeft);
  });

  it('sets paragraphs of one answer closer than question and answer, with one A', () => {
    const [page] = layoutForNote(
      payload(
        writing([300, 0, 300, 40]),
        paragraph('one', 100),
        paragraph('two', 100),
      ),
      PAGE,
      DATE,
    );
    const one = textsNamed(page, 'one')[0].rect;
    const two = textsNamed(page, 'two')[0].rect;
    // The gap follows the measured text, not its taller box, so it is the
    // same after a paragraph of any length.
    expect(two.top - (one.top + 100)).toBe(S.paragraphGap);
    expect(one.bottom - one.top).toBe(Math.ceil(100 * TEXT_HEIGHT_SAFETY));
    expect(textsNamed(page, 'A')).toHaveLength(1);
    expect(page.bars).toEqual([
      [S.barX, one.top + S.barCap, S.barX, two.top + 100 - S.barCap],
    ]);
  });

  it('sets each question and answer apart from the one before', () => {
    const [page] = layoutForNote(
      payload(
        writing([300, 0, 300, 40]),
        paragraph('first', 100),
        writing([300, 0, 300, 40]),
        paragraph('second', 100),
      ),
      PAGE,
      DATE,
    );
    expect(page.bars).toHaveLength(2);
    const [, second] = textsNamed(page, 'Q');
    expect(
      second.rect.top - (textsNamed(page, 'first')[0].rect.top + 100),
    ).toBe(S.entryGap);
    expect(textsNamed(page, 'Q')).toHaveLength(2);
    expect(textsNamed(page, 'A')).toHaveLength(2);
  });

  it('scales handwriting wider than the column down to fit it', () => {
    const width = S.contentRight - S.contentLeft;
    const [page] = layoutForNote(
      payload(writing([0, 0, width * 2, 100])),
      PAGE,
      DATE,
    );
    const [stroke] = page.strokes;
    expect(stroke[2] - stroke[0]).toBe(width);
    expect(stroke[3] - stroke[1]).toBe(50);
  });

  it('scales handwriting taller than a page down to fit one', () => {
    const [page] = layoutForNote(
      payload(writing([300, 0, 300, 9000])),
      PAGE,
      DATE,
    );
    const usable = 2560 - S.top - S.bottom - 50 - S.questionGap;
    const [stroke] = page.strokes;
    expect(stroke[3] - stroke[1]).toBeLessThanOrEqual(usable);
  });

  it('scales writing from the PilotChat width to the page width', () => {
    const [page] = layoutForNote(
      {pageWidth: 960, items: [writing([100, 50, 200, 150])]},
      PAGE,
      DATE,
    );
    const [stroke] = page.strokes;
    expect(stroke[2] - stroke[0]).toBe(200);
    expect(stroke[3] - stroke[1]).toBe(200);
  });

  it('treats a zero PilotChat width as unscaled', () => {
    const [page] = layoutForNote(
      {pageWidth: 0, items: [writing([10, 20, 30, 40])]},
      PAGE,
      DATE,
    );
    expect(page.strokes[0][2] - page.strokes[0][0]).toBe(20);
  });

  it('skips strokes without a point and writing with none left', () => {
    const [page] = layoutForNote(
      payload(writing([], [5]), writing([10, 300, 20, 310], [])),
      PAGE,
      DATE,
    );
    expect(page.strokes).toHaveLength(1);
    expect(textsNamed(page, 'Q')).toHaveLength(1);
  });

  it('moves a question that does not fit what is left to the next page', () => {
    const pages = layoutForNote(
      payload(writing([300, 0, 300, 1500]), writing([300, 0, 300, 1000])),
      PAGE,
      DATE,
    );
    expect(pages).toHaveLength(2);
    expect(textsNamed(pages[1], 'Q')[0].rect.top).toBe(S.top);
    expect(pages[1].strokes[0][1]).toBe(S.top);
  });

  it('carries a long answer on to the next page with its bar, without a second A', () => {
    const pages = layoutForNote(
      payload(
        writing([300, 0, 300, 40]),
        paragraph('p1', 1200),
        paragraph('p2', 1200),
      ),
      PAGE,
      DATE,
    );
    expect(pages).toHaveLength(2);
    expect(textsNamed(pages[0], 'A')).toHaveLength(1);
    expect(textsNamed(pages[1], 'A')).toHaveLength(0);
    expect(textsNamed(pages[1], 'p2')[0].rect.top).toBe(S.top);
    expect(pages[0].bars).toHaveLength(1);
    expect(pages[1].bars).toEqual([
      [S.barX, S.top + S.barCap, S.barX, S.top + 1200 - S.barCap],
    ]);
  });

  it("keeps paragraph gaps even whatever the paragraphs' lengths", () => {
    const [page] = layoutForNote(
      payload(
        writing([300, 0, 300, 40]),
        paragraph('long', 400),
        paragraph('short', 100),
        paragraph('last', 100),
      ),
      PAGE,
      DATE,
    );
    const [long, short, last] = ['long', 'short', 'last'].map(
      t => textsNamed(page, t)[0].rect,
    );
    expect(short.top - (long.top + 400)).toBe(S.paragraphGap);
    expect(last.top - (short.top + 100)).toBe(S.paragraphGap);
  });

  it('sets out an answer with no question before it on its own', () => {
    const [page] = layoutForNote(payload(paragraph('orphan', 100)), PAGE, DATE);
    expect(textsNamed(page, 'Q')).toHaveLength(0);
    expect(textsNamed(page, 'A')).toHaveLength(1);
    expect(page.bars).toHaveLength(1);
  });

  it('keeps everything in whole pixels when writing scales to fractions', () => {
    const pages = layoutForNote(
      {pageWidth: 1920, items: [writing([10, 0, 10, 101]), paragraph('A', 77)]},
      {width: 1404, height: 1872},
      DATE,
    );
    for (const page of pages) {
      const values = [
        ...page.texts.flatMap(t => [
          t.rect.left,
          t.rect.top,
          t.rect.right,
          t.rect.bottom,
        ]),
        ...page.bars.flat(),
        ...page.strokes.flat(),
      ];
      values.forEach(v => expect(Number.isInteger(v)).toBe(true));
    }
  });
});

describe("layoutForNote — a page's worth of text", () => {
  it('keeps a paragraph that fills a page inside the page', () => {
    const {maxHeight} = noteTextStyle(PAGE);
    const pages = layoutForNote(
      payload(writing([300, 0, 300, 40]), paragraph('long', maxHeight)),
      PAGE,
      DATE,
    );
    const [long] = textsNamed(pages[pages.length - 1], 'long');
    expect(long.rect.top).toBe(S.top);
    expect(long.rect.bottom).toBeLessThanOrEqual(PAGE.height);
  });
});

describe('headerDate', () => {
  it('formats a date as "Mon D, YYYY" without Intl', () => {
    expect(headerDate(new Date(2026, 9, 3))).toBe('Oct 3, 2026');
    expect(headerDate(new Date(2027, 0, 15))).toBe('Jan 15, 2027');
  });
});
