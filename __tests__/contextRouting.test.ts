/**
 * Tests for src/ui/contextRouting. Pins:
 *   1. Quick-action source always attaches the page.
 *   2. Empty / whitespace-only freeform → no attach (heuristic
 *      returns false for empty text).
 *   3. Page-referential cues match (demonstratives, summarize verbs,
 *      "my notes", "what is this", etc.).
 *   4. Off-topic generic queries do NOT match (general knowledge,
 *      personal small talk, code unrelated to the page).
 *   5. Case-insensitive matching.
 *   6. Questions about the user's own annotations (handwriting, margin
 *      notes, highlights) attach the page; look-alike general queries
 *      ("profit margin", "match highlights") do not.
 */
import {
  isPageReferential,
  shouldAttachPageContext,
} from '../src/ui/contextRouting';

describe('isPageReferential — referential signals', () => {
  it.each([
    'summarize this page',
    'Explain the diagram above',
    'what is this paragraph about?',
    'Clarify these notes for me',
    'Translate the handwriting',
    'Rewrite this section in plain English',
    'what are the key points?',
    'paraphrase the topic here',
    'Who wrote this?',
    'What is missing from these notes?',
    'Outline the document',
    'Extract action items from my notes',
  ])('matches: %p', (text) => {
    expect(isPageReferential(text)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPageReferential('SUMMARIZE THIS PAGE')).toBe(true);
    expect(isPageReferential('what IS this PARAGRAPH about')).toBe(true);
  });
});

describe('isPageReferential — off-topic', () => {
  it.each([
    "what's the capital of France?",
    'tell me a joke about cats',
    'how does quicksort work?',
    'write a Python function to reverse a list',
    'who won the 2022 world cup',
    'recommend a good book on metallurgy',
    'plan a 3-day trip to Lisbon',
  ])('does NOT match: %p', (text) => {
    expect(isPageReferential(text)).toBe(false);
  });

  it('empty / whitespace-only returns false', () => {
    expect(isPageReferential('')).toBe(false);
    expect(isPageReferential('   ')).toBe(false);
    expect(isPageReferential('\n  \t')).toBe(false);
  });
});

describe('isPageReferential — the user\'s annotations', () => {
  it.each([
    'What did I write on THE margin',
    'what did i write here',
    'What have I highlighted?',
    "what I've underlined so far",
    'explain what I wrote',
    'what did I circle',
    'summarise my annotations',
    'explain my highlights',
    'what do these scribbles say',
    'read the markings',
    'expand on the note in the margin',
    'turn my margin notes into a list',
    'why is the highlighted passage important?',
    'define the underlined words',
  ])('matches: %p', (text) => {
    expect(isPageReferential(text)).toBe(true);
  });

  it.each([
    "what's the profit margin on coffee?",
    'explain margin of error in polling',
    'show me the highlights of the 2022 world cup',
    'how do I underline text in Word?',
    'what did they write in the constitution?',
  ])('does NOT match: %p', (text) => {
    expect(isPageReferential(text)).toBe(false);
  });
});

describe('shouldAttachPageContext', () => {
  it('always attaches for quick actions, regardless of text', () => {
    expect(shouldAttachPageContext('quick-action', 'whatever')).toBe(true);
    expect(shouldAttachPageContext('quick-action', '')).toBe(true);
    expect(
      shouldAttachPageContext('quick-action', 'how does quicksort work'),
    ).toBe(true);
  });

  it('routes freeform through isPageReferential', () => {
    expect(shouldAttachPageContext('freeform', 'summarize this page')).toBe(
      true,
    );
    expect(shouldAttachPageContext('freeform', 'tell me a joke')).toBe(false);
  });
});
