// Budget for a conversational reply: the ceiling on its output and on
// how long to wait for it. Shared by chat and the PilotChat, which ask the
// same kind of question of the same models.

// Hard ceiling on a single send. Real providers usually answer in
// under 10s; 60s leaves headroom for slow networks. The timeout
// aborts the request and unblocks the in-flight guard so a hung
// call can never permanently lock further sends.
// Raised alongside the output budget below. A reasoning model spends
// tokens thinking before it emits anything, so the same reply takes
// materially longer than it did from a non-reasoning model — 60s
// turned a slow success into an abort. Matches Grill's heaviest call.
export const REPLY_TIMEOUT_MS = 120_000;

// Output budget for a conversational reply. This is a ceiling shared
// between the model's reasoning tokens and its visible reply — every
// current flagship model reasons first, so a small value is spent
// thinking and returns nothing. 256 was also below the ~250-word target
// the system prompt asks for (~325 tokens), so it truncated ordinary
// replies too.
//
// Deliberately under 4096: older models cap output there and Anthropic
// rejects a max_tokens above a model's maximum, so a larger value would
// break configurations that work today. Provisional — the reasoningTokens
// figure logged on each send is what this should be tuned from.
export const REPLY_MAX_TOKENS = 4000;
