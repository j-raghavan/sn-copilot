/**
 * Tests for src/pilotchat/askPilotChat — the PilotChat's provider call.
 *
 * Pins:
 *   1. The request carries PILOTCHAT_SYSTEM_PROMPT, PILOTCHAT_USER_TEXT, the
 *      handwriting image, the page's history, REPLY_MAX_TOKENS and the
 *      caller's signal; the key and model go as send options.
 *   2. The reply's leading `Q:` line is the question as the model read it;
 *      the rest, as plain text, is the answer.
 *   3. A truncated reply that has an answer is still written down.
 *   4. A refused or empty reply, or one with only a question line, throws
 *      ProviderStopError.
 */
import {
  askPilotChat,
  PILOTCHAT_SYSTEM_PROMPT,
  PILOTCHAT_USER_TEXT,
  splitReply,
} from '../src/pilotchat/askPilotChat';
import type {
  ProviderClient,
  ProviderResponse,
  ProviderTurn,
} from '../src/providers/ProviderClient';
import {REPLY_MAX_TOKENS} from '../src/providers/replyBudget';
import {ProviderStopError} from '../src/providers/stopReason';

const IMAGE = 'iVBORw0KGgo=';

const reply = (over: Partial<ProviderResponse> = {}): ProviderResponse => ({
  text: 'Q: what is a qubit\n\nA qubit holds 0 and 1 at once.',
  stopReason: 'complete',
  usage: {inputTokens: 1, outputTokens: 1},
  latencyMs: 5,
  modelId: 'm',
  ...over,
});

const clientReturning = (r: ProviderResponse) => {
  const send = jest.fn(async () => r);
  const client: ProviderClient = {id: 'anthropic', send};
  return {client, send};
};

const HISTORY: ProviderTurn[] = [
  {role: 'user', text: 'what is a bit'},
  {role: 'assistant', text: 'A 0 or a 1.'},
];

const ask = (client: ProviderClient, signal = new AbortController().signal) =>
  askPilotChat({
    client,
    apiKey: 'k',
    model: 'claude-x',
    imageBase64: IMAGE,
    history: HISTORY,
    signal,
  });

describe('askPilotChat', () => {
  it('sends the prompt, image, history, budget and signal', async () => {
    const {client, send} = clientReturning(reply());
    const signal = new AbortController().signal;
    await ask(client, signal);
    expect(send).toHaveBeenCalledWith(
      {
        systemPrompt: PILOTCHAT_SYSTEM_PROMPT,
        userText: PILOTCHAT_USER_TEXT,
        imageBase64: IMAGE,
        history: HISTORY,
        maxTokens: REPLY_MAX_TOKENS,
        signal,
      },
      {apiKey: 'k', model: 'claude-x'},
    );
  });

  it('asks for the question line, then plain prose suited to the page', () => {
    expect(PILOTCHAT_SYSTEM_PROMPT).toContain('Q: <their question');
    expect(PILOTCHAT_SYSTEM_PROMPT).toContain('image of their handwriting');
    expect(PILOTCHAT_SYSTEM_PROMPT).toContain('no markdown');
    expect(PILOTCHAT_SYSTEM_PROMPT).toContain('never LaTeX');
  });

  it('tells the model a short follow-up continues the previous question', () => {
    expect(PILOTCHAT_SYSTEM_PROMPT).toContain('one continuing conversation');
    expect(PILOTCHAT_SYSTEM_PROMPT).toContain('dig deeper');
  });

  it('returns the question read and the answer', async () => {
    const {client} = clientReturning(reply());
    await expect(ask(client)).resolves.toEqual({
      question: 'what is a qubit',
      answer: 'A qubit holds 0 and 1 at once.',
    });
  });

  it('returns the answer as trimmed plain text', async () => {
    const {client} = clientReturning(
      reply({
        text: '**Q:** qubits?\n\n## Qubits\n\nA **qubit** is *both*.  \n',
      }),
    );
    const {question, answer} = await ask(client);
    expect(question).toBe('qubits?');
    expect(answer).not.toMatch(/[#*]/);
    expect(answer).toContain('qubit is both');
    expect(answer).toBe(answer.trim());
  });

  it('writes down a truncated reply that has an answer', async () => {
    const {client} = clientReturning(
      reply({text: 'Q: qubit\n\nA qubit is', stopReason: 'truncated'}),
    );
    await expect(ask(client)).resolves.toEqual({
      question: 'qubit',
      answer: 'A qubit is',
    });
  });

  it.each([
    ['refused', reply({stopReason: 'refused'})],
    ['empty', reply({text: '   '})],
  ])('throws ProviderStopError on a %s reply', async (_l, r) => {
    const {client} = clientReturning(r);
    await expect(ask(client)).rejects.toBeInstanceOf(ProviderStopError);
  });

  it.each([
    ['truncated', 'truncated'],
    ['complete', 'unknown'],
  ] as const)(
    'throws when only the question line came back (%s)',
    async (stopReason, expected) => {
      const {client} = clientReturning(reply({text: 'Q: qubit', stopReason}));
      const run = ask(client);
      await expect(run).rejects.toBeInstanceOf(ProviderStopError);
      await expect(run).rejects.toMatchObject({stopReason: expected});
    },
  );
});

describe('splitReply', () => {
  it('splits the leading Q: line from the answer', () => {
    expect(splitReply('Q: why?\n\nBecause.')).toEqual({
      question: 'why?',
      answer: 'Because.',
    });
  });

  it('skips leading blank lines and ignores the case of Q:', () => {
    expect(splitReply('\n  \nq:  a b  \nanswer')).toEqual({
      question: 'a b',
      answer: 'answer',
    });
  });

  it('treats a reply without a Q: line as all answer', () => {
    expect(splitReply('  Just an answer.\n')).toEqual({
      question: '',
      answer: 'Just an answer.',
    });
  });

  it('leaves no answer for a reply that is only the question line', () => {
    expect(splitReply('Q: qubit')).toEqual({question: 'qubit', answer: ''});
  });

  it('handles an empty reply', () => {
    expect(splitReply('')).toEqual({question: '', answer: ''});
  });
});
