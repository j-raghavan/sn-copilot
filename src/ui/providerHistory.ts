// Builds the ProviderTurn[] replayed to the provider on each send so
// follow-up questions keep their context ("expand point 2" needs the
// assistant reply that contained point 2).
//
// The chat's on-screen message list is not directly wire-safe:
//   - it contains transient 'thinking' placeholders,
//   - a failed send can leave empty or whitespace-only texts,
//   - Anthropic's Messages API requires the first message to be
//     'user' and roles to alternate strictly.
// This module normalises all of that in one pure function so the four
// provider clients can map the result 1:1 without provider-specific
// repair logic.
//
// Caps are deliberate and conservative: history is resent on EVERY
// send, so an unbounded list would grow each request quadratically.
// Page context from earlier turns is already excluded upstream (the
// ChatMessage list stores the user's typed text, not the composed
// prompt with the transcribed page).

import type {ProviderTurn} from '../providers/ProviderClient';

// Most recent messages kept (after filtering), i.e. 5 exchanges.
export const HISTORY_MESSAGE_LIMIT = 10;
// Per-turn character cap. A truncated turn keeps its head — the
// opening of a reply carries the structure follow-ups refer to.
export const HISTORY_TURN_CHAR_LIMIT = 4000;

// Structural subset of ChatView's ChatMessage union — accepting the
// loose shape keeps this module free of a UI import cycle.
export type HistorySource = {
  role: string;
  text?: string;
  // Set on locally-generated "Error: ..." bubbles. They look like
  // assistant turns on screen and in the persisted conversation, but
  // replaying one tells the model it previously answered with a
  // failure it never produced — it then apologises for, explains, or
  // imitates an error that never happened.
  isError?: boolean;
};

const truncate = (text: string): string =>
  text.length <= HISTORY_TURN_CHAR_LIMIT
    ? text
    : `${text.slice(0, HISTORY_TURN_CHAR_LIMIT - 1)}…`;

export const buildProviderHistory = (
  messages: readonly HistorySource[],
): ProviderTurn[] => {
  const turns: ProviderTurn[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') {
      continue; // 'thinking' placeholder and any future transient roles
    }
    if (m.isError === true) {
      continue; // local failure notice, not something the model said
    }
    const text = (m.text ?? '').trim();
    if (text.length === 0) {
      continue;
    }
    turns.push({role: m.role, text: truncate(text)});
  }

  const recent = turns.slice(-HISTORY_MESSAGE_LIMIT);

  // The window can open mid-exchange (assistant first) — drop leading
  // assistant turns so the sequence starts with 'user', as Anthropic
  // requires.
  while (recent.length > 0 && recent[0].role !== 'user') {
    recent.shift();
  }

  // Merge consecutive same-role turns (a send that errored without a
  // reply leaves two user messages back to back). Strict alternation
  // is the lowest common denominator across the provider APIs.
  const alternating: ProviderTurn[] = [];
  for (const t of recent) {
    const last = alternating[alternating.length - 1];
    if (last !== undefined && last.role === t.role) {
      // Re-truncate: two capped turns concatenate past the per-turn
      // cap, and a merged run of three or more compounds it further.
      alternating[alternating.length - 1] = {
        role: t.role,
        text: truncate(`${last.text}\n\n${t.text}`),
      };
    } else {
      alternating.push(t);
    }
  }

  // Drop a trailing 'user' turn. The caller appends the current user
  // message directly after this history, so leaving one here puts two
  // user turns side by side on the wire — breaking the strict
  // alternation this module exists to guarantee, and which Anthropic's
  // Messages API documents as a requirement.
  //
  // Only one can be present: consecutive same-role turns were merged
  // just above. In the app this arises exactly when the previous send
  // failed — the error bubble is dropped by the isError check, leaving
  // the unanswered question last. The model never saw that question and
  // never replied to it, so the retry that follows carries the user's
  // intent; replaying the orphan would only repeat it.
  if (
    alternating.length > 0 &&
    alternating[alternating.length - 1].role === 'user'
  ) {
    alternating.pop();
  }
  return alternating;
};
