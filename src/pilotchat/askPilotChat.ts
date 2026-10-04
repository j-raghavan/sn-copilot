// Asks the provider a PilotChat question and returns the question as the
// model read it and its answer, as plain text ready for the page.
//
// The question is sent as an image of the handwriting only. The device's
// own handwriting recognition is not used: calling it makes the plugin
// host save the pen's pending ink into the open note (seen on device:
// HostCommImpl saveTrailsAsTemp on every recognizeElements), which would
// put the user's PilotChat writing into their notebook. The model reads the
// image instead and says what it read, for the header and the history.

import type {ProviderClient, ProviderTurn} from '../providers/ProviderClient';
import {REPLY_MAX_TOKENS} from '../providers/replyBudget';
import {assertUsable, ProviderStopError} from '../providers/stopReason';
import {markdownToPlainText} from '../ui/markdownToPlain';

export const PILOTCHAT_SYSTEM_PROMPT = [
  'You are PilotChat, a page that writes back. The user writes to you by hand',
  'on an e-ink page; each question arrives as an image of their handwriting.',
  '',
  'Reply in exactly this shape:',
  'Q: <their question as you read it from the image, on one line>',
  '',
  '<your answer>',
  '',
  'The page is one continuing conversation. A short follow-up such as',
  '"dig deeper", "why?" or "an example?" is about the previous question and',
  'your answer to it; continue that topic, and never ask what they mean',
  'when the conversation makes it clear.',
  '',
  'Your answer is written onto the page under their writing, so:',
  '- write plain prose in short paragraphs; no markdown, tables or code fences;',
  '- write math in plain text, like 3x^2 + 2 or (x + 1)/2; never LaTeX;',
  '- keep it short — usually under 120 words — unless they ask for more;',
  '- answer directly, the way a thoughtful person would reply in a notebook.',
].join('\n');

export const PILOTCHAT_USER_TEXT =
  'My question is in the attached image of my handwriting.';

export type PilotChatReply = {
  // The question as the model read it; empty if it did not say.
  question: string;
  answer: string;
};

const QUESTION_LINE = /^\s*Q:\s*(.*)$/i;

/** Splits a reply into its leading `Q:` line and the answer under it. */
export const splitReply = (text: string): PilotChatReply => {
  const lines = text.split('\n');
  const first = lines.findIndex(line => line.trim().length > 0);
  const match = first >= 0 ? QUESTION_LINE.exec(lines[first]) : null;
  if (match === null) {
    return {question: '', answer: text.trim()};
  }
  return {
    question: match[1].trim(),
    answer: lines
      .slice(first + 1)
      .join('\n')
      .trim(),
  };
};

export type AskPilotChatParams = {
  client: ProviderClient;
  apiKey: string;
  model: string;
  // A PNG of just this question's handwriting.
  imageBase64: string;
  // Earlier questions and answers on this page, oldest first, as text.
  history: ProviderTurn[];
  signal: AbortSignal;
};

export const askPilotChat = async (
  params: AskPilotChatParams,
): Promise<PilotChatReply> => {
  const {client, apiKey, model, imageBase64, history, signal} = params;
  const r = await client.send(
    {
      systemPrompt: PILOTCHAT_SYSTEM_PROMPT,
      userText: PILOTCHAT_USER_TEXT,
      imageBase64,
      history,
      maxTokens: REPLY_MAX_TOKENS,
      signal,
    },
    {apiKey, model},
  );
  // Like chat, a reply cut short is still worth writing down.
  assertUsable(r, {acceptPartial: true});
  // Models format by habit even when told not to; the page draws plain text.
  const reply = splitReply(markdownToPlainText(r.text));
  if (reply.answer.length === 0) {
    // Only the question line came back: nothing to write on the page.
    throw new ProviderStopError(
      r.stopReason === 'truncated' ? 'truncated' : 'unknown',
    );
  }
  return reply;
};
