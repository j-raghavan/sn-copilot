// The native `<PilotChatPageView>` (android/.../pilotchat/PilotChatPageViewManager.kt):
// its props, the event it raises, and the commands
// UIManager.dispatchViewManagerCommand delivers to it by name.

import type React from 'react';
import {
  findNodeHandle,
  requireNativeComponent,
  UIManager,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';

/**
 * A written question: each stroke as flat screen-pixel pairs [x0, y0, x1, y1, …],
 * and a base64 PNG of just those strokes (absent if it could not be drawn).
 */
export type QuestionPayload = {strokes: number[][]; image?: string};

/** One item of the page's content for the notebook, top to bottom. */
export type ExportItem =
  | {kind: 'writing'; strokes: number[][]}
  | {kind: 'paragraph'; text: string; height: number};

/**
 * The page's content for the notebook: the user's writing in PilotChat page
 * pixels (each stroke flat [x0, y0, …]) and the answers' paragraphs with
 * their heights as measured for the notebook (see exportForNote).
 */
export type ExportPayload = {pageWidth: number; items: ExportItem[]};

/** The pen the note writes with, in the SDK's codes (getPenInfo), set back as the PilotChat closes. */
export type NotePen = {type: number; width: number; color: number};

type NativeProps = ViewProps & {
  notePen?: NotePen | null;
  // Ink on the page (default); false while something covers it, so pen taps
  // there leave no marks.
  inkEnabled?: boolean;
  onQuestion?: (event: NativeSyntheticEvent<QuestionPayload>) => void;
  onExport?: (event: NativeSyntheticEvent<ExportPayload>) => void;
};

export const PilotChatPageNativeView =
  requireNativeComponent<NativeProps>('PilotChatPageView');

export type PilotChatPageRef = React.ComponentRef<
  typeof PilotChatPageNativeView
>;

const dispatch = (
  view: PilotChatPageRef | null,
  command:
    | 'ask'
    | 'appendAnswer'
    | 'appendNote'
    | 'exportForNote'
    | 'clearPage'
    | 'scrollPage',
  args: Array<string | number> = [],
): void => {
  const node = findNodeHandle(view);
  if (node == null) {
    return;
  }
  UIManager.dispatchViewManagerCommand(node, command, args);
};

/** Takes what was written since the last question as a question now, without waiting for the pen to rest. */
export const askNow = (view: PilotChatPageRef | null): void =>
  dispatch(view, 'ask');

/** Writes [text] onto the page under the question it answers. */
export const appendAnswer = (
  view: PilotChatPageRef | null,
  text: string,
): void => dispatch(view, 'appendAnswer', [text]);

/** Writes a note from the PilotChat itself (a failure, a hint): shown on the page, never put in the notebook. */
export const appendNote = (view: PilotChatPageRef | null, text: string): void =>
  dispatch(view, 'appendNote', [text]);

/**
 * Asks the page for its content for the notebook, with each answer paragraph
 * measured at [fontSize] across [textWidth], and one taller than [maxHeight]
 * cut into pieces that fit; it arrives as onExport.
 */
export const exportForNote = (
  view: PilotChatPageRef | null,
  fontSize: number,
  textWidth: number,
  maxHeight: number,
): void => dispatch(view, 'exportForNote', [fontSize, textWidth, maxHeight]);

/** Starts a new, empty page: everything written and answered goes. */
export const clearPage = (view: PilotChatPageRef | null): void =>
  dispatch(view, 'clearPage');

/** Scrolls the page by most of a screen: down for 1, up for -1. Touch never scrolls it. */
export const scrollPage = (
  view: PilotChatPageRef | null,
  direction: 1 | -1,
): void => dispatch(view, 'scrollPage', [direction]);
