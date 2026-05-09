/**
 * Tests for composeUserText — pure helper that decides whether the
 * page-context transcription gets appended to the user message.
 */
import {composeUserText} from '../src/ui/composePrompt';
import type {PageContext} from '../src/scope/pageContext';

const makeCtx = (pageText: string): PageContext => ({
  notePath: '/sd/x.note',
  page: 1,
  screenshotPath: '/sd/png',
  screenshotBase64: 'AAAA',
  pageText,
});

describe('composeUserText', () => {
  it('returns the user input verbatim when context is null', () => {
    expect(composeUserText('Summarize this', null)).toBe('Summarize this');
  });

  it('returns the user input verbatim when pageText is empty', () => {
    expect(composeUserText('Summarize this', makeCtx(''))).toBe(
      'Summarize this',
    );
  });

  it('returns the user input verbatim when pageText is whitespace-only', () => {
    expect(composeUserText('Summarize this', makeCtx('   \n  \t\n'))).toBe(
      'Summarize this',
    );
  });

  it('appends a labelled section when pageText is present', () => {
    expect(
      composeUserText('Summarize this', makeCtx('first line\nsecond line')),
    ).toBe(
      'Summarize this\n\n--- Page content (transcribed) ---\nfirst line\nsecond line',
    );
  });
});
