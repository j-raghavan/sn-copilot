// Composes the user-facing message that gets sent to the provider.
// When a page-context capture is available with non-empty
// transcribed text, the text is appended under a clearly-labelled
// section so:
//   - Image-capable providers see a clean transcription alongside
//     the rendered PNG (often easier to parse than handwriting).
//   - Text-only providers (DeepSeek) get a usable signal without
//     needing the image attachment.

import type {PageContext} from '../scope/pageContext';

export const composeUserText = (
  trimmedUserInput: string,
  pageContext: PageContext | null,
): string => {
  if (pageContext === null || pageContext.pageText.length === 0) {
    return trimmedUserInput;
  }
  return (
    `${trimmedUserInput}\n\n` +
    `--- Page content (transcribed) ---\n${pageContext.pageText}`
  );
};
