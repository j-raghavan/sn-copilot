/**
 * Smoke test for SYSTEM_PROMPT — guards the high-impact constant
 * against accidental shape regressions (empty string, missing
 * intent list, absent markdown rule).
 */
import {SYSTEM_PROMPT} from '../src/ui/systemPrompt';

describe('SYSTEM_PROMPT', () => {
  it('is a non-trivial string', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(200);
  });

  it('lists the four supported intents', () => {
    for (const intent of ['Summarize', 'Explain', 'Clarify', 'Snapshot']) {
      expect(SYSTEM_PROMPT).toContain(intent);
    }
  });

  it('instructs the model to use Markdown', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('markdown');
  });

  it('forbids tables', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('avoid tables');
  });
});
