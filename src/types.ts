/**
 * Shared domain types for sn-copilot.
 *
 * The provider id is the company identifier (`'anthropic'`, not
 * `'claude'`), so the on-disk `copilot-key-<provider>.txt` filename
 * maps directly to ProviderId without translation.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'deepseek';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
] as const;

// Parsed contents of one copilot-key-<provider>.txt file. Produced by
// src/storage/keyFiles.ts, consumed by src/storage/activeProvider.ts.
//
// Vision capability is derived strictly from `provider` via
// isImageCapableProvider — there's no per-key opt-out. DeepSeek is
// the only text-only provider; the rest carry images. A `mode=…`
// line in the on-disk file is logged-and-ignored by the parser for
// backwards compatibility with old templates.
export type KeyFile = {
  provider: ProviderId;
  model: string;
  key: string;
  defaultProvider?: ProviderId;
  // Per-action override of the default PII redaction policy. text-only.
  clarifyRedact?: boolean;
  // Source path on disk; shown in Settings as "Managed by …".
  sourcePath: string;
};

// Single source of truth for "does this provider's API accept image
// inputs?". Used by the chat send path to decide whether to attach
// the page screenshot.
export const isImageCapableProvider = (provider: ProviderId): boolean =>
  provider !== 'deepseek';

// Resolved at startup and on Settings refresh. Either a fully
// validated active provider, or a reason no provider can be selected.
export type ProviderResolution =
  | {kind: 'ok'; active: KeyFile; others: KeyFile[]}
  | {kind: 'none'; message: string}
  | {kind: 'ambiguous'; message: string; candidates: KeyFile[]};

// User's choice for whether the key file lives plaintext on disk or
// encrypted with a PIN. `undecided` is the bootstrap state — the
// migration prompt sets it to one of the other two on first run.
export type EncryptionMode = 'plaintext' | 'encrypted' | 'undecided';

// Persisted alongside the encrypted vault (or alongside the plaintext
// .txt files if the user opts out). Held in a small JSON file under the
// plugin's private install dir, with fallback to MyStyle/SnCopilot.
export type CopilotPrefs = {
  version: 1;
  encryptionMode: EncryptionMode;
  // Minutes of inactivity before the in-memory derived key is wiped.
  // Only meaningful when encryptionMode === 'encrypted'.
  idleTimeoutMin: number;
  // P2: optional global persona override. When non-empty (after
  // trim), ChatView sends this verbatim to the model in place of
  // src/ui/systemPrompt.ts's SYSTEM_PROMPT. The user is responsible
  // for keeping their override useful — we don't merge or post-fix
  // the default rules onto custom prompts.
  customSystemPrompt?: string;
  // P2: user-defined quick-action templates appended to the 4 built-
  // ins (Summary / Explain / Clarify / Snapshot). Capped to
  // CUSTOM_ACTION_LIMIT to keep the action row manageable.
  customActions?: CustomAction[];
  // First-run onboarding flag. Set to true the first time the user
  // closes Settings. Until then, CopilotPanel routes new users to
  // Settings on boot (instead of the empty ChatView) so they're
  // greeted by the provider/persona/quick-actions configuration
  // surface rather than a blank chat. Strictly first-run-ever — a
  // freshly-dropped new key file later does NOT reset this.
  hasSeenSettings?: boolean;
};

// =====================================================================
// Custom quick actions (Req 3b — saveable named prompt templates).
// =====================================================================
//
// Each user-defined action is one tappable button in the chat header
// that sends a canned prompt — identical mechanics to the 4 built-ins.
// Constraints are tight: small label fits the narrow e-ink action
// row, single glyph for the icon, prompt long enough for a sentence
// or two of instruction.

export const CUSTOM_ACTION_LIMIT = 6;
export const CUSTOM_ACTION_LABEL_MAX = 16;
export const CUSTOM_ACTION_ICON_MAX = 4;
export const CUSTOM_ACTION_PROMPT_MAX = 500;
export const CUSTOM_SYSTEM_PROMPT_MAX = 2000;

export type CustomAction = {
  id: string;
  label: string;
  icon: string;
  prompt: string;
};

export const DEFAULT_IDLE_TIMEOUT_MIN = 10;

export const DEFAULT_PREFS: Readonly<CopilotPrefs> = Object.freeze({
  version: 1 as const,
  encryptionMode: 'undecided' as const,
  idleTimeoutMin: DEFAULT_IDLE_TIMEOUT_MIN,
});

// =====================================================================
// Conversation history (Req 1+2 — last-5 FIFO retention).
// =====================================================================
//
// A Conversation is the unit of FIFO eviction. The user starts a new
// one explicitly via the "New chat" button (manual boundary — never
// auto-segmented by page or time). The on-disk store caps to
// CONVERSATION_HISTORY_LIMIT and evicts oldest-first by updatedAt.

export const CONVERSATION_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_HISTORY_LIMIT = 5;
export const CONVERSATION_PREVIEW_MAX_CHARS = 80;

export type ConversationMessageRole = 'user' | 'assistant';

export type ConversationMessage = {
  id: string;
  role: ConversationMessageRole;
  text: string;
  // Assistant-only metadata. Optional on the type so the same shape
  // covers both roles without a tagged union ceremony — the message
  // bubble in ChatView still discriminates on role.
  modelId?: string;
  latencyMs?: number;
  // Unix ms. Drives the history list sort and the preview banner.
  createdAt: number;
};

export type Conversation = {
  id: string;
  createdAt: number;
  updatedAt: number;
  // The provider that handled the first send — informational only,
  // shown in the history list. The conversation is not locked to it;
  // the user can swap providers in Settings mid-chat.
  providerId?: ProviderId;
  messages: ConversationMessage[];
};

// On-disk envelope (when plaintext). Encrypted form goes through the
// same aesGcm envelope used by vault.ts. See storage/conversations.ts
// for the auto-detect-and-route read logic.
export type ConversationStore = {
  version: typeof CONVERSATION_SCHEMA_VERSION;
  conversations: Conversation[];
};

export const EMPTY_CONVERSATION_STORE: Readonly<ConversationStore> =
  Object.freeze({
    version: CONVERSATION_SCHEMA_VERSION,
    conversations: [],
  });

// Derive the preview line shown in the history list from the first
// user message of a conversation. Empty when the conversation has no
// user message yet (e.g., a new chat the user hasn't sent into).
export const conversationPreview = (conv: Conversation): string => {
  const firstUser = conv.messages.find(m => m.role === 'user');
  if (firstUser === undefined) {
    return '';
  }
  const trimmed = firstUser.text.trim();
  if (trimmed.length <= CONVERSATION_PREVIEW_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, CONVERSATION_PREVIEW_MAX_CHARS - 1)}…`;
};
