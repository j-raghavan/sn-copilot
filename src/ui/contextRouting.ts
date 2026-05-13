// Heuristic for whether a freeform user message is page-referential.
//
// Built-in quick actions and user-defined custom actions ALWAYS get
// the page context attached (image + OCR text) — the user picking
// "Summarize" is an explicit "do this with the page" intent. This
// module's job is only the freeform-input case: when the user types
// a question, decide whether to attach the page or treat the message
// as a general AI assistant query.
//
// Default-attach is intentional. Detection here is conservative:
// many obvious page-referential cues match, but plenty of edge
// cases (typos, languages, idioms) won't. When in doubt, attach —
// the relaxed SYSTEM_PROMPT lets the model ignore the page when the
// question is really off-topic, and the cost of an unnecessary
// attachment is a few hundred tokens.
//
// What we explicitly DROP: questions that look like generic chat
// ("what's the capital of france", "tell me a joke", "explain
// quicksort") — sending the user's handwritten page as context for
// a quicksort question is privacy waste with no upside.

// Patterns that strongly signal "ask about this content". Matches
// are case-insensitive (we lowercase the input first).
const REFERENTIAL_PATTERNS: readonly RegExp[] = [
  // Demonstratives + content nouns (the most reliable signals).
  /\b(this|the|that) (page|note|notebook|document|content|text|writing|handwriting|image|diagram|figure|table|chart|graph|equation|formula|paragraph|section|heading|list|sketch|drawing)\b/,
  // Action verbs that imply "operate on the visible content".
  /\b(summari[sz]e|paraphrase|rewrite|simplify|translate|outline|extract|annotate|critique|review|clarify|snapshot)\b/,
  // Spatial / locational cues (what's above/below/here).
  /\b(above|below|here|on (the )?page|on screen|on display)\b/,
  // Direct references to the captured visual or recognised text.
  /\b(my notes?|the notes?|these notes?|my handwriting|the handwriting)\b/,
  // Common "what is this …" framings.
  /\b(what (is|are) (this|these|that)|what does (this|that)|what'?s (this|here|on))\b/,
  // Open-ended page-targeted asks.
  /\b(what (is|are) missing|anything missing|unclear|ambiguous|inconsistent)\b/,
  // Question-about-author / source intents.
  /\b(who wrote|who is the author|what is the topic|main idea|key (points?|takeaways?))\b/,
];

export const isPageReferential = (rawText: string): boolean => {
  const text = rawText.trim().toLowerCase();
  if (text.length === 0) {
    return false;
  }
  return REFERENTIAL_PATTERNS.some((re) => re.test(text));
};

// Source of a send invocation. Quick actions (built-in or custom)
// always attach the page; freeform messages route through
// isPageReferential to decide.
export type SendSource = 'quick-action' | 'freeform';

export const shouldAttachPageContext = (
  source: SendSource,
  text: string,
): boolean => {
  if (source === 'quick-action') {
    return true;
  }
  return isPageReferential(text);
};
