/**
 * Tests for buildMarkdownStyles — pure factory that scales every
 * font-size key in the markdown style table.
 */
import {buildMarkdownStyles} from '../src/ui/markdownStyles';

describe('buildMarkdownStyles', () => {
  it('produces a non-empty style record', () => {
    const styles = buildMarkdownStyles(1);
    expect(Object.keys(styles).length).toBeGreaterThan(5);
  });

  it('scales every fontSize linearly with `scale`', () => {
    const oneX = buildMarkdownStyles(1);
    const twoX = buildMarkdownStyles(2);
    for (const key of Object.keys(oneX)) {
      const a = (oneX[key] as {fontSize?: number}).fontSize;
      const b = (twoX[key] as {fontSize?: number}).fontSize;
      if (typeof a === 'number' && typeof b === 'number') {
        expect(b).toBeCloseTo(a * 2);
      }
    }
  });

  it('keeps non-font properties unscaled', () => {
    const styles = buildMarkdownStyles(2);
    expect((styles.heading1 as {fontWeight: string}).fontWeight).toBe('700');
    expect((styles.code_inline as {backgroundColor: string}).backgroundColor).toBe(
      '#EEEEEE',
    );
  });
});
