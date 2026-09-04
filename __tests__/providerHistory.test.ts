/**
 * Tests for src/ui/providerHistory — the pure normaliser that turns
 * the on-screen ChatMessage list into the ProviderTurn[] replayed to
 * providers.
 *
 * Pins:
 *   1. Transient roles ('thinking') and empty/whitespace texts drop.
 *   2. Cap to HISTORY_MESSAGE_LIMIT most recent messages.
 *   3. Per-turn truncation at HISTORY_TURN_CHAR_LIMIT.
 *   4. Leading assistant turns drop (Anthropic requires user-first).
 *   5. Consecutive same-role turns merge (strict alternation), and
 *      the merged text is re-capped at HISTORY_TURN_CHAR_LIMIT.
 *   6. Empty input → empty output (single-turn behaviour preserved).
 *   7. Locally-generated error bubbles (isError) never reach the wire.
 *   8. A trailing user turn is dropped — the caller appends the current
 *      user message right after, and two adjacent user turns would
 *      break the alternation this module guarantees.
 */
import {
  buildProviderHistory,
  HISTORY_MESSAGE_LIMIT,
  HISTORY_TURN_CHAR_LIMIT,
} from '../src/ui/providerHistory';

const u = (text: string) => ({role: 'user', text});
const a = (text: string) => ({role: 'assistant', text});

describe('buildProviderHistory', () => {
  it('returns an empty array for an empty message list', () => {
    expect(buildProviderHistory([])).toEqual([]);
  });

  it('maps a clean user/assistant transcript 1:1', () => {
    expect(
      buildProviderHistory([
        u('Summarize'),
        a('• point one'),
        u('expand?'),
        a('point one, expanded'),
      ]),
    ).toEqual([
      {role: 'user', text: 'Summarize'},
      {role: 'assistant', text: '• point one'},
      {role: 'user', text: 'expand?'},
      {role: 'assistant', text: 'point one, expanded'},
    ]);
  });

  it("drops 'thinking' placeholders and empty/whitespace texts", () => {
    expect(
      buildProviderHistory([
        u('Q1'),
        {role: 'thinking'},
        a('  \n '),
        a('A1'),
        {role: 'thinking', text: '…'},
      ]),
    ).toEqual([
      {role: 'user', text: 'Q1'},
      {role: 'assistant', text: 'A1'},
    ]);
  });

  it('trims surrounding whitespace on kept turns', () => {
    expect(buildProviderHistory([u('  hi  '), a('  there  ')])).toEqual([
      {role: 'user', text: 'hi'},
      {role: 'assistant', text: 'there'},
    ]);
  });

  it(`keeps only the ${HISTORY_MESSAGE_LIMIT} most recent messages`, () => {
    const msgs = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(i % 2 === 0 ? u(`Q${i}`) : a(`A${i}`));
    }
    const out = buildProviderHistory(msgs);
    expect(out).toHaveLength(HISTORY_MESSAGE_LIMIT);
    // Window ends at the newest message…
    expect(out[out.length - 1]).toEqual({role: 'assistant', text: 'A19'});
    // …and opens on a user turn.
    expect(out[0].role).toBe('user');
  });

  it('truncates an over-long turn, keeping its head', () => {
    const long = 'x'.repeat(HISTORY_TURN_CHAR_LIMIT + 500);
    const out = buildProviderHistory([u(long), a('ok')]);
    expect(out[0].text).toHaveLength(HISTORY_TURN_CHAR_LIMIT);
    expect(out[0].text.endsWith('…')).toBe(true);
  });

  it('drops leading assistant turns so the sequence starts with user', () => {
    expect(buildProviderHistory([a('orphan reply'), u('Q'), a('A')])).toEqual([
      {role: 'user', text: 'Q'},
      {role: 'assistant', text: 'A'},
    ]);
  });

  it('returns empty when only assistant turns remain', () => {
    expect(buildProviderHistory([a('reply one'), a('reply two')])).toEqual([]);
  });

  it('merges consecutive same-role turns (failed send left two user messages)', () => {
    expect(
      buildProviderHistory([u('first try'), u('second try'), a('reply')]),
    ).toEqual([
      {role: 'user', text: 'first try\n\nsecond try'},
      {role: 'assistant', text: 'reply'},
    ]);
  });

  it('caps a merged run at the per-turn limit', () => {
    const long = 'x'.repeat(HISTORY_TURN_CHAR_LIMIT + 500);
    const out = buildProviderHistory([u(long), u(long), u(long), a('reply')]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toHaveLength(HISTORY_TURN_CHAR_LIMIT);
    expect(out[0].text.endsWith('…')).toBe(true);
  });

  it('drops locally-generated error bubbles', () => {
    // A failed send leaves an "Error: ..." assistant bubble on screen.
    // Replaying it would tell the model it had answered with a failure
    // it never produced.
    expect(
      buildProviderHistory([
        u('Summarize this'),
        {role: 'assistant', text: 'Error: anthropic: HTTP 429', isError: true},
        u('Summarize this'),
        a('Here is the summary.'),
      ]),
    ).toEqual([
      // The two identical user turns merge, as consecutive same-role
      // turns always do once the error bubble between them is gone.
      {role: 'user', text: 'Summarize this\n\nSummarize this'},
      {role: 'assistant', text: 'Here is the summary.'},
    ]);
  });

  it('keeps assistant turns that are not flagged as errors', () => {
    // Guards against over-filtering: a real reply whose text merely
    // begins with "Error" is still a genuine turn.
    expect(
      buildProviderHistory([u('Q'), a('Error handling works like this...')]),
    ).toEqual([
      {role: 'user', text: 'Q'},
      {role: 'assistant', text: 'Error handling works like this...'},
    ]);
  });

  it('drops a trailing user turn so the wire stays alternating', () => {
    // The caller appends the current user message straight after this
    // history, so a trailing user turn would put two user turns side by
    // side. Reachable in the app only via a failed send: the error
    // bubble is filtered out, leaving the unanswered question last.
    expect(
      buildProviderHistory([
        u('Summarize'),
        a('• point one'),
        {role: 'assistant', text: 'Error: HTTP 429', isError: true},
        u('what failed to send'),
      ]),
    ).toEqual([
      {role: 'user', text: 'Summarize'},
      {role: 'assistant', text: '• point one'},
    ]);
  });

  it('returns empty when the only turn is a user turn', () => {
    expect(buildProviderHistory([u('unanswered')])).toEqual([]);
  });

  it('handles messages with no text field (transient shapes)', () => {
    expect(buildProviderHistory([{role: 'user'}, u('Q'), a('A')])).toEqual([
      {role: 'user', text: 'Q'},
      {role: 'assistant', text: 'A'},
    ]);
  });
});
