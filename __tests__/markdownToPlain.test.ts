/**
 * Tests for src/ui/markdownToPlain — strips markdown syntax for the
 * clipboard / paste path. Covers every construct our system prompt
 * asks the LLM to produce (headings, bullets, numbered lists, bold,
 * italic, inline code, fenced code blocks, links, blockquotes,
 * strikethrough, horizontal rules) and a few real-world combinations
 * from observed LLM output.
 */
import {markdownToPlainText} from '../src/ui/markdownToPlain';

describe('markdownToPlainText — single constructs', () => {
  it('returns empty string for empty input', () => {
    expect(markdownToPlainText('')).toBe('');
  });

  it('leaves plain text unchanged (modulo trim)', () => {
    expect(markdownToPlainText('hello world')).toBe('hello world');
  });

  it('strips heading hashes — H1..H6', () => {
    expect(markdownToPlainText('# Foo')).toBe('Foo');
    expect(markdownToPlainText('## Foo')).toBe('Foo');
    expect(markdownToPlainText('### Foo')).toBe('Foo');
    expect(markdownToPlainText('#### Foo')).toBe('Foo');
    expect(markdownToPlainText('##### Foo')).toBe('Foo');
    expect(markdownToPlainText('###### Foo')).toBe('Foo');
  });

  it('strips trailing hashes from atx-closed headings', () => {
    expect(markdownToPlainText('## Foo ##')).toBe('Foo');
  });

  it('strips bold (**, __)', () => {
    expect(markdownToPlainText('**bold**')).toBe('bold');
    expect(markdownToPlainText('__bold__')).toBe('bold');
    expect(markdownToPlainText('a **b** c')).toBe('a b c');
  });

  it('strips italic (*) but leaves underscores in identifiers', () => {
    expect(markdownToPlainText('*ital*')).toBe('ital');
    expect(markdownToPlainText('a *b* c')).toBe('a b c');
    // Snake_case identifiers must NOT be eaten.
    expect(markdownToPlainText('use snake_case here')).toBe('use snake_case here');
  });

  it('strips strikethrough (~~)', () => {
    expect(markdownToPlainText('~~gone~~')).toBe('gone');
  });

  it('strips inline code backticks', () => {
    expect(markdownToPlainText('use `printf` for output')).toBe(
      'use printf for output',
    );
  });

  it('preserves the inner content of a fenced code block', () => {
    const md =
      '```python\n' +
      'def f(x):\n' +
      '    return x + 1\n' +
      '```';
    expect(markdownToPlainText(md)).toBe('def f(x):\n    return x + 1');
  });

  it('handles a fenced code block with no language tag', () => {
    expect(markdownToPlainText('```\nraw text\n```')).toBe('raw text');
  });

  it('replaces bullet markers (-, *, +) with the Unicode bullet •', () => {
    expect(markdownToPlainText('- foo')).toBe('• foo');
    expect(markdownToPlainText('* bar')).toBe('• bar');
    expect(markdownToPlainText('+ baz')).toBe('• baz');
  });

  it('preserves indentation of nested bullets', () => {
    const md = '- top\n  - nested\n  - also nested';
    expect(markdownToPlainText(md)).toBe('• top\n  • nested\n  • also nested');
  });

  it('preserves numbered lists as-is (no marker rewrite)', () => {
    const md = '1. one\n2. two\n3. three';
    expect(markdownToPlainText(md)).toBe('1. one\n2. two\n3. three');
  });

  it('strips link syntax — keeps display text only', () => {
    expect(markdownToPlainText('see [the docs](https://example.com)')).toBe(
      'see the docs',
    );
  });

  it('strips blockquote markers', () => {
    expect(markdownToPlainText('> quoted line')).toBe('quoted line');
    expect(markdownToPlainText('> a\n> b')).toBe('a\nb');
  });

  it('drops horizontal rules', () => {
    expect(markdownToPlainText('above\n\n---\n\nbelow')).toBe('above\n\nbelow');
    expect(markdownToPlainText('above\n\n***\n\nbelow')).toBe('above\n\nbelow');
    expect(markdownToPlainText('above\n\n___\n\nbelow')).toBe('above\n\nbelow');
  });
});

describe('markdownToPlainText — combined real-world output', () => {
  it('strips a heading + bullet block (the user-reported failure case)', () => {
    const md = [
      '### Summary',
      '',
      '- The chemistry textbook covers:',
      '- Anatomy of a soda bottle',
      '- Behavior of CO₂ molecules under pressure',
      '- Rapid carbonation effect when the cap is twisted off',
    ].join('\n');
    const out = markdownToPlainText(md);
    expect(out).toBe(
      [
        'Summary',
        '',
        '• The chemistry textbook covers:',
        '• Anatomy of a soda bottle',
        '• Behavior of CO₂ molecules under pressure',
        '• Rapid carbonation effect when the cap is twisted off',
      ].join('\n'),
    );
  });

  it('strips bold + italic + headings together', () => {
    const md = '## **Title**\n\nThis is *important* and **very bold**.';
    expect(markdownToPlainText(md)).toBe(
      'Title\n\nThis is important and very bold.',
    );
  });

  it('handles mixed bullets and inline code', () => {
    const md = [
      '- run `npm test`',
      '- review **failures**',
      '- commit when *clean*',
    ].join('\n');
    expect(markdownToPlainText(md)).toBe(
      ['• run npm test', '• review failures', '• commit when clean'].join('\n'),
    );
  });

  it('collapses 3+ consecutive newlines to one blank line', () => {
    expect(markdownToPlainText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims leading + trailing whitespace from final output', () => {
    expect(markdownToPlainText('\n\n  hello  \n\n')).toBe('hello');
  });
});
