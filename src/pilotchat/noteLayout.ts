// Lays the PilotChat's conversation onto notebook pages, set out so it
// reads as a PilotChat entry rather than plain copied text:
//
//   PilotChat · Oct 3, 2026
//
//   Q    <the handwritten question>
//
//   A  ┃ The answer, paragraph by
//      ┃ paragraph, indented under A.
//
// Bold Q and A labels in a gutter, the handwriting and the answer indented
// past them, and a light-gray bar down the answer's left. The bar sits
// beside the text, never under it: the note draws strokes over text boxes,
// so anything shaded behind an answer hides it (seen on device). A question
// that does not fit what is left of a page starts the next one; an answer
// longer than a page carries on there, its bar too.
//
// Pure: the page export (PilotChatPageView.exportForNote) supplies the
// strokes and the measured paragraph heights; writeToNote does the writing.

import type {ExportPayload} from '../native/PilotChatPageView';

export type Size = {width: number; height: number};
export type Rect = {left: number; top: number; right: number; bottom: number};

export type NoteText = {
  text: string;
  rect: Rect;
  fontSize: number;
  bold: boolean;
};

/** One notebook page's worth of content, in page pixels. */
export type NotePageContent = {
  // The answers' bars, each a vertical line flat [x, top, x, bottom].
  bars: number[][];
  // The user's handwriting, each stroke flat [x0, y0, x1, y1, …].
  strokes: number[][];
  texts: NoteText[];
};

// The notebook firmware clips text that overflows its box and does not
// grow the box to fit (seen on device by sn-mindmap and sn-formula). Each
// paragraph is measured in Android's sans-serif, Roboto, which is what the
// note draws text in, and on device it wraps to the measured lines. Its box
// is still made taller than measured, so a line wrapped differently is not
// lost; the next paragraph follows the measured text, not the box, so the
// gaps between paragraphs stay even (seen on device when it followed the
// box: the spare height showed as gaps that grew with each paragraph).
export const TEXT_HEIGHT_SAFETY = 1.3;

// A text line's box height as a multiple of its font size.
const LINE_BOX = 1.6;

/** Every measure of the design, for a notebook page of a given size. */
export type NoteStyle = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  // The answer's bar: its centre line, and how far its pen's round ends
  // reach past the line's ends.
  barX: number;
  barCap: number;
  contentLeft: number;
  contentRight: number;
  // Between a question and its answer, between paragraphs, between entries.
  questionGap: number;
  paragraphGap: number;
  entryGap: number;
  fontSize: number;
  labelSize: number;
  headerSize: number;
};

/**
 * The design's measures for a page of [page] size. The note's toolbar runs
 * down the left edge over the page (116 px of a 1920 px page on a Nomad, its
 * disabled area), so the labels start well clear of it.
 */
export const noteStyle = (page: Size): NoteStyle => {
  const w = page.width;
  const h = page.height;
  const left = Math.round(w * 0.085);
  const contentLeft = left + Math.round(w * 0.06);
  return {
    left,
    right: Math.round(w * 0.05),
    top: Math.round(h * 0.05),
    bottom: Math.round(h * 0.05),
    barX: contentLeft - Math.round(w * 0.016),
    // The bar pen draws 24 px wide on a 1920 px page (measured on device).
    barCap: Math.round(w * 0.00625),
    contentLeft,
    contentRight: w - Math.round(w * 0.05),
    questionGap: Math.round(h * 0.015),
    paragraphGap: Math.round(h * 0.01),
    entryGap: Math.round(h * 0.03),
    fontSize: Math.round(w * 0.023),
    labelSize: Math.round(w * 0.027),
    headerSize: Math.round(w * 0.016),
  };
};

/**
 * The answers' text size and box width on a page of [page] size, for
 * measuring them, and the most text one page holds: a paragraph taller is
 * cut into pieces, since a text box clips what overflows it.
 */
export const noteTextStyle = (
  page: Size,
): {fontSize: number; textWidth: number; maxHeight: number} => {
  const style = noteStyle(page);
  return {
    fontSize: style.fontSize,
    textWidth: style.contentRight - style.contentLeft,
    maxHeight: page.height - style.top - style.bottom,
  };
};

/** The header's date, as "Oct 3, 2026" (Hermes has no Intl date formatting). */
export const headerDate = (date: Date): string => {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
};

type Extent = {left: number; top: number; right: number; bottom: number};

const extentOf = (strokes: number[][]): Extent => {
  const e = {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  };
  for (const flat of strokes) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      e.left = Math.min(e.left, flat[i]);
      e.right = Math.max(e.right, flat[i]);
      e.top = Math.min(e.top, flat[i + 1]);
      e.bottom = Math.max(e.bottom, flat[i + 1]);
    }
  }
  return e;
};

// A row of an entry: the handwritten question, or one answer paragraph.
type Row =
  | {
      kind: 'question';
      strokes: number[][];
      extent: Extent;
      fit: number;
      height: number;
    }
  | {
      kind: 'paragraph';
      text: string;
      // The text's own height, which the next row follows, and its box's.
      height: number;
      boxHeight: number;
      first: boolean;
    };

type Entry = Row[];

/** Groups the export into entries: each question with the answer after it. */
const entriesOf = (
  payload: ExportPayload,
  style: NoteStyle,
  page: Size,
): Entry[] => {
  const scale = payload.pageWidth > 0 ? page.width / payload.pageWidth : 1;
  const contentWidth = style.contentRight - style.contentLeft;
  // Room for a question under the header, so even the tallest one fits on
  // the first page rather than leaving the header there alone.
  const header = Math.ceil(style.headerSize * LINE_BOX) + style.questionGap;
  const usable = page.height - style.top - style.bottom - header;
  const entries: Entry[] = [];
  let current: Entry | null = null;
  let answerStarted = false;
  for (const item of payload.items) {
    if (item.kind === 'writing') {
      const written = item.strokes
        .filter(s => s.length >= 2)
        .map(s => s.map(v => v * scale));
      if (written.length === 0) {
        continue;
      }
      const extent = extentOf(written);
      const width = extent.right - extent.left;
      const natural = extent.bottom - extent.top;
      // Too wide for the column, or taller than a page: scaled down to fit.
      const fit = Math.min(
        width > contentWidth ? contentWidth / width : 1,
        natural > usable ? usable / natural : 1,
      );
      current = [
        {
          kind: 'question',
          strokes: written,
          extent,
          fit,
          height: Math.ceil(natural * fit),
        },
      ];
      entries.push(current);
      answerStarted = false;
      continue;
    }
    if (current === null) {
      current = [];
      entries.push(current);
    }
    current.push({
      kind: 'paragraph',
      text: item.text,
      height: Math.ceil(item.height),
      boxHeight: Math.ceil(item.height * TEXT_HEIGHT_SAFETY),
      first: !answerStarted,
    });
    answerStarted = true;
  }
  return entries;
};

/**
 * [payload]'s conversation on as many notebook pages of [page] size as it
 * needs, under a header dated [date].
 */
export const layoutForNote = (
  payload: ExportPayload,
  page: Size,
  date: string,
): NotePageContent[] => {
  const style = noteStyle(page);
  const pageBottom = page.height - style.bottom;
  const labelHeight = Math.ceil(style.labelSize * LINE_BOX);
  const entries = entriesOf(payload, style, page);
  if (entries.length === 0) {
    return [];
  }

  const pages: NotePageContent[] = [];
  let content: NotePageContent = {bars: [], strokes: [], texts: []};
  let y = style.top;
  // The answer's bar so far on this page: from its first paragraph's top
  // to its last paragraph's text, or null between answers.
  let bar: {top: number; bottom: number} | null = null;
  const endBar = () => {
    if (bar !== null) {
      const x = style.barX;
      content.bars.push([
        x,
        bar.top + style.barCap,
        x,
        bar.bottom - style.barCap,
      ]);
      bar = null;
    }
  };
  const newPage = () => {
    endBar();
    pages.push(content);
    content = {bars: [], strokes: [], texts: []};
    y = style.top;
  };

  const headerHeight = Math.ceil(style.headerSize * LINE_BOX);
  content.texts.push({
    text: `PilotChat · ${date}`,
    rect: {
      left: style.left,
      top: y,
      right: style.contentRight,
      bottom: y + headerHeight,
    },
    fontSize: style.headerSize,
    bold: false,
  });
  y += headerHeight + style.questionGap;
  let pageHasRows = false;

  const label = (text: string, top: number): NoteText => ({
    text,
    rect: {
      left: style.left,
      top,
      right: style.barX - style.barCap,
      bottom: top + labelHeight,
    },
    fontSize: style.labelSize,
    bold: true,
  });

  entries.forEach((entry, e) => {
    entry.forEach((row, r) => {
      let gap = 0;
      if (r > 0) {
        gap =
          row.kind === 'paragraph' && !row.first
            ? style.paragraphGap
            : style.questionGap;
      } else if (e > 0) {
        gap = style.entryGap;
      }
      let top = pageHasRows ? y + gap : y;
      if (pageHasRows && top + row.height > pageBottom) {
        newPage();
        top = y;
      }
      if (row.kind === 'question') {
        const {extent, fit} = row;
        content.texts.push(label('Q', top));
        content.strokes.push(
          ...row.strokes.map(stroke =>
            stroke.map((v, i) =>
              Math.round(
                i % 2 === 0
                  ? style.contentLeft + (v - extent.left) * fit
                  : top + (v - extent.top) * fit,
              ),
            ),
          ),
        );
      } else {
        if (row.first) {
          content.texts.push(label('A', top));
        }
        content.texts.push({
          text: row.text,
          rect: {
            left: style.contentLeft,
            top,
            right: style.contentRight,
            // Never past the page's edge, where the note would cut it off.
            bottom: Math.min(top + row.boxHeight, page.height),
          },
          fontSize: style.fontSize,
          bold: false,
        });
        bar = {top: bar === null ? top : bar.top, bottom: top + row.height};
      }
      y = top + row.height;
      pageHasRows = true;
    });
    endBar();
  });
  pages.push(content);
  return pages;
};
