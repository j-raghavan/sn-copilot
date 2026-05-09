// Singleton holding the most recent page-context capture.
//
// Captured at sidebar-button tap (BEFORE the overlay opens — see
// index.js subscribeToButtonEvents). The capture is fired
// asynchronously: the button handler kicks it off and stores the
// PROMISE here, then immediately opens the overlay so the popup
// renders without waiting for screenshot + OCR (700-2000ms on
// device). ChatView awaits the promise inside its send flow — by
// then capture is usually done; if not, the existing "thinking"
// placeholder covers the wait.
//
// Lifetime: replaced on every sidebar tap; cleared on overlay close.

export type PageContext = {
  notePath: string;
  page: number;
  // Absolute path on the device (file:// URL drops the prefix).
  screenshotPath: string;
  // Base64-encoded PNG bytes, ready for direct inclusion in provider
  // request bodies (Anthropic image block, OpenAI image_url data URL,
  // Gemini inline_data). Pre-encoded so the per-action send is a
  // pure construction step.
  screenshotBase64: string;
  // Concatenated transcribed text — typed text from TextBox elements
  // plus the firmware's handwriting-recognition output for any
  // strokes on the page. Empty string when neither is present.
  // Sent alongside the image to give text-only providers (DeepSeek)
  // a useful signal, and to give image-capable providers a cleaner
  // backup transcription that's often easier for the LLM to read
  // than rendered handwriting.
  pageText: string;
};

let currentPromise: Promise<PageContext | null> | null = null;

// Used by index.js: stores the in-flight capture promise. The button
// handler does NOT await this — it just hands the promise off so the
// overlay can open immediately. Chat send awaits later.
export const setPageContextPromise = (
  p: Promise<PageContext | null>,
): void => {
  currentPromise = p;
};

// Convenience for callers who already have a resolved value (tests
// and the overlay-close path). Wraps in a resolved Promise so the
// async getter can stay uniform.
export const setPageContext = (ctx: PageContext | null): void => {
  currentPromise = ctx === null ? null : Promise.resolve(ctx);
};

// Async — resolves to the captured context (or null if no capture
// is in flight or the capture failed). Awaiting a settled promise
// is essentially free; awaiting an in-flight one yields naturally.
export const getPageContext = async (): Promise<PageContext | null> => {
  return currentPromise ?? null;
};

// Test-only — a fresh module under jest is the same singleton, and we
// don't want test ordering to leak state.
export const __testing__ = {
  reset(): void {
    currentPromise = null;
  },
};
