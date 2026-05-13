/**
 * The chat UI mounted inside the Copilot overlay.
 *
 *   ┌─ Header: "Copilot"                       [−][A][+]  [×] ─┐
 *   │  Context: <scope label>                          [📝][⚙] │
 *   │  [☰ Summary] [? Explain] [✦ Clarify] [⊡ Snapshot]        │
 *   │  🛡️  Avoid sharing sensitive info; the visible page is   │
 *   │     sent to the LLM.                                     │
 *   │  ─────────────────────────────────────────────────────── │
 *   │  ┌─ chat scroll ───────────────────────────────────────┐ │
 *   │  │   user / assistant bubbles                          │ │
 *   │  └─────────────────────────────────────────────────────┘ │
 *   │  ─────────────────────────────────────────────────────── │
 *   │  ┌──────────────────────────────────────────┐ [➤]        │
 *   │  │ Ask about this page…                     │            │
 *   │  └──────────────────────────────────────────┘            │
 *   │  Provider: <name>                                        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Quick action buttons append a canned user message to the chat
 * which flows through the same provider call as free-form input.
 * While a request is in flight the action + send buttons are
 * disabled by the re-entrancy guard in src/reentrancy.
 *
 * Privacy: there is no per-message redaction toggle. On vision
 * providers (Anthropic / OpenAI / Gemini) the page screenshot is
 * always sent verbatim. On DeepSeek (text-only) the outbound text
 * has emails and 7+ digit runs scrubbed automatically.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import CopilotOverlay from '../native/CopilotOverlay';
import {debugLog, infoLog} from '../diagnostics/log';
import {redactPii} from '../privacy/redact';
import {tryAcquire, release} from '../reentrancy/inFlightGuard';
import {getPageContext} from '../scope/pageContext';
import {
  conversationPreview,
  isImageCapableProvider,
  type Conversation,
  type ConversationMessage,
  type CustomAction,
  type KeyFile,
} from '../types';
import {
  loadConversations,
  newConversationId,
  newMessageId,
  saveConversation,
  type ConversationsDeps,
} from '../storage/conversations';
import {composeUserText} from './composePrompt';
import {shouldAttachPageContext, type SendSource} from './contextRouting';
import {buildMarkdownStyles} from './markdownStyles';
import {markdownToPlainText} from './markdownToPlain';
import {sanitizeProviderError} from './sanitizeProviderError';
import SetupChecklist from './SetupChecklist';
import {SYSTEM_PROMPT} from './systemPrompt';
import {useProviderClient} from './useProviderClient';

// Hard ceiling on a single send. Real providers usually answer in
// under 10s; 60s leaves headroom for slow networks. The timeout
// aborts the request and unblocks the in-flight guard so a hung
// call can never permanently lock further sends.
const SEND_TIMEOUT_MS = 60_000;

// Three-step font scaling. Scale factors keep e-ink rendering
// readable across 7.8" and 10.3" devices without per-device tables.
const FONT_SIZES = ['S', 'M', 'L'] as const;
type FontSize = (typeof FONT_SIZES)[number];
const FONT_SCALE: Record<FontSize, number> = {S: 1, M: 1.25, L: 1.5};
const stepUp = (s: FontSize): FontSize =>
  FONT_SIZES[Math.min(FONT_SIZES.indexOf(s) + 1, FONT_SIZES.length - 1)];
const stepDown = (s: FontSize): FontSize =>
  FONT_SIZES[Math.max(FONT_SIZES.indexOf(s) - 1, 0)];

export type QuickActionId = 'summarize' | 'explain' | 'clarify' | 'snapshot';

export type ChatViewProps = {
  scopeLabel: string;
  provider: string;
  // When a key file is configured (read at startup), keyFile is the
  // active KeyFile from MyStyle/SnCopilot/. ChatView then uses the
  // real provider client + the user's key. When undefined (no key
  // file configured), ChatView falls back to fakeProvider so the
  // demo still runs offline.
  keyFile?: KeyFile;
  // Optional persistence wiring. When present AND a keyFile is
  // configured, ChatView loads the most-recent conversation on
  // mount and saves after every turn. Omitting it (older tests,
  // pre-bundle render in CopilotPanel) keeps the chat in-memory.
  conversationsDeps?: ConversationsDeps;
  // P2: optional global persona override. Non-empty values replace
  // the built-in SYSTEM_PROMPT verbatim — caller is responsible for
  // whatever steering they want.
  customSystemPrompt?: string;
  // P2: user-defined quick actions appended to the 4 built-ins. The
  // row horizontally scrolls when the combined width overflows.
  customActions?: CustomAction[];
  // P2 UX: when the vault is encrypted AND currently unlocked, the
  // parent renders a 🔒 icon in the context row that taps onLockNow.
  // Settings still has a Lock-now option behind the encryption
  // sub-screen; the chat icon is the "step away from device"
  // shortcut so users don't have to navigate two levels deep.
  showLockButton?: boolean;
  onLockNow?: () => void;
  onSettingsTap: () => void;
  onClose: () => void;
};

type ChatMessage =
  | {id: string; role: 'user'; text: string}
  | {
      id: string;
      role: 'assistant';
      text: string;
      modelId?: string;
      latencyMs?: number;
    }
  | {id: string; role: 'thinking'};

// Maps a persisted ConversationMessage back into the on-screen
// ChatMessage union. Drops nothing: assistant metadata comes through.
const toChatMessages = (msgs: ConversationMessage[]): ChatMessage[] =>
  msgs.map((m) =>
    m.role === 'user'
      ? {id: m.id, role: 'user', text: m.text}
      : {
          id: m.id,
          role: 'assistant',
          text: m.text,
          modelId: m.modelId,
          latencyMs: m.latencyMs,
        },
  );

// Reverse direction — only persists the two real roles ('user',
// 'assistant'), drops the transient 'thinking' placeholder. Adds
// createdAt at persistence time (we don't track per-message wall
// clocks in the live ChatMessage union, but the persisted form
// stamps them for history ordering).
const toConversationMessages = (
  msgs: ChatMessage[],
): ConversationMessage[] => {
  const out: ConversationMessage[] = [];
  let now = Date.now();
  for (const m of msgs) {
    if (m.role === 'thinking') {
      continue;
    }
    if (m.role === 'user') {
      out.push({id: m.id, role: 'user', text: m.text, createdAt: now});
    } else {
      out.push({
        id: m.id,
        role: 'assistant',
        text: m.text,
        modelId: m.modelId,
        latencyMs: m.latencyMs,
        createdAt: now,
      });
    }
    // Monotonically nudge so the ordering of stamps follows the
    // order of messages in the array. Real wall-clock precision
    // isn't needed; the assistant message coming "after" the user
    // message is what matters for sort stability if anything else
    // later groups by createdAt.
    now += 1;
  }
  return out;
};

// Quick-action button definitions: id, label, icon, and the canned
// prompt that appears as a user message when tapped.
const QUICK_ACTIONS: Array<{
  id: QuickActionId;
  label: string;
  icon: string;
  prompt: string;
}> = [
  // Button label is "Summary" so the text fits on one line at the
  // quick-action button width; the prompt sent to the LLM stays as
  // "Summarize this page" because that's the verb the model needs.
  {id: 'summarize', label: 'Summary', icon: '☰', prompt: 'Summarize this page'},
  {id: 'explain', label: 'Explain', icon: '?', prompt: 'Explain this page'},
  {id: 'clarify', label: 'Clarify', icon: '✦', prompt: 'What is unclear?'},
  {id: 'snapshot', label: 'Snapshot', icon: '⊡', prompt: 'Snapshot this page'},
];

export default function ChatView(props: ChatViewProps): React.JSX.Element {
  const {
    scopeLabel,
    provider,
    keyFile,
    conversationsDeps,
    customSystemPrompt,
    customActions,
    showLockButton,
    onLockNow,
    onSettingsTap,
    onClose,
  } = props;

  const {client, apiKey, model} = useProviderClient(keyFile);

  // No key file → block all send paths and show the setup checklist
  // in the empty area. Without this gate the chat silently routes to
  // fakeProvider, which returns canned demo replies that LOOK like
  // real model output and send users on a wild goose chase.
  const hasKeyFile = keyFile !== undefined;

  // Effective system prompt: prefer the user's persona override
  // when it's a non-empty string, otherwise fall back to the
  // built-in SYSTEM_PROMPT. Trimmed comparison so a whitespace-only
  // override doesn't accidentally wipe the default rules.
  const effectiveSystemPrompt =
    customSystemPrompt !== undefined && customSystemPrompt.trim().length > 0
      ? customSystemPrompt
      : SYSTEM_PROMPT;

  // Merge built-ins with user-defined actions. Built-ins always come
  // first so familiar buttons don't migrate as the user adds custom
  // ones. The user's button row horizontally scrolls when the
  // combined width overflows.
  const mergedActions = useMemo(() => {
    if (customActions === undefined || customActions.length === 0) {
      return QUICK_ACTIONS.map((a) => ({
        ...a,
        kind: 'builtin' as const,
      }));
    }
    return [
      ...QUICK_ACTIONS.map((a) => ({...a, kind: 'builtin' as const})),
      ...customActions.map((a) => ({
        id: a.id,
        label: a.label,
        icon: a.icon,
        prompt: a.prompt,
        kind: 'custom' as const,
      })),
    ];
  }, [customActions]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<FontSize>('S');
  // Transient per-bubble copy feedback. Only the most recently
  // copied bubble shows feedback; cleared after ~1500ms.
  const [copyFeedback, setCopyFeedback] = useState<{
    msgId: string;
    state: 'copied' | 'failed';
  } | null>(null);
  // Conversation persistence state (Req 1+2). When conversationsDeps
  // is undefined (no wiring bundle yet, or no keyFile) the persistence
  // path is dormant — `currentConversationId` stays null and writes
  // are skipped.
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const conversationCreatedAtRef = useRef<number | null>(null);
  const fontScale = FONT_SCALE[fontSize];
  const canShrink = fontSize !== 'S';
  const canGrow = fontSize !== 'L';
  // Font controls only matter once there's an LLM reply to scale,
  // so hide them until then. The user's tap on a quick action
  // produces a "thinking" placeholder first, then an assistant
  // message — we wait for the assistant message specifically.
  const hasAssistantReply = messages.some(m => m.role === 'assistant');

  // Per-mount monotonic counter folded into a timestamp-based id so
  // resumed conversations and freshly-minted messages share a
  // globally-unique namespace.
  const nextIdRef = useRef<number>(1);
  const newId = () => `${newMessageId()}_${nextIdRef.current++}`;

  // On mount: restore the most-recent conversation if we have wiring
  // + a key file. New chats inherit a fresh id only at first send.
  useEffect(() => {
    if (conversationsDeps === undefined || !hasKeyFile) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await loadConversations(conversationsDeps);
        if (cancelled) {
          return;
        }
        setHistory(list);
        if (list.length > 0) {
          const newest = list[0];
          setMessages(toChatMessages(newest.messages));
          setCurrentConversationId(newest.id);
          conversationCreatedAtRef.current = newest.createdAt;
        }
      } catch (e) {
        // Persistence failures must never block the chat surface.
        // Log and continue with an empty session.
        debugLog(
          `[COPILOT_CHAT] history restore failed: ${(e as Error).message}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationsDeps, hasKeyFile]);

  // Persists the current conversation after a turn completes. No-op
  // when persistence isn't wired or there's nothing to save. Mints a
  // conversation id on the FIRST send (so empty "New chat" sessions
  // never clutter the FIFO history).
  const persistTurn = useCallback(
    async (finalMessages: ChatMessage[]): Promise<void> => {
      if (conversationsDeps === undefined) {
        return;
      }
      const persisted = toConversationMessages(finalMessages);
      if (persisted.length === 0) {
        return;
      }
      let convId = currentConversationId;
      let createdAt = conversationCreatedAtRef.current;
      if (convId === null) {
        convId = newConversationId();
        createdAt = Date.now();
        setCurrentConversationId(convId);
        conversationCreatedAtRef.current = createdAt;
      }
      const updatedAt = Date.now();
      const conv: Conversation = {
        id: convId,
        createdAt: createdAt ?? updatedAt,
        updatedAt,
        providerId: keyFile?.provider,
        messages: persisted,
      };
      try {
        const list = await saveConversation(conversationsDeps, conv);
        setHistory(list);
      } catch (e) {
        // Persistence failures shouldn't surface to the user as a
        // chat error — the in-memory turn already completed.
        debugLog(
          `[COPILOT_CHAT] history save failed: ${(e as Error).message}`,
        );
      }
    },
    [conversationsDeps, currentConversationId, keyFile?.provider],
  );

  const sendUserMessage = useCallback(async (text: string, source: SendSource) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (!tryAcquire()) {
      console.log('[COPILOT_CHAT] action ignored — already in flight');
      return;
    }
    const userMsg: ChatMessage = {id: newId(), role: 'user', text: trimmed};
    const thinkingMsg: ChatMessage = {id: newId(), role: 'thinking'};
    setMessages(curr => [...curr, userMsg, thinkingMsg]);
    setBusy(true);
    setInput('');
    debugLog(`[COPILOT_CHAT] sendUserMessage text=${trimmed.slice(0, 40)}`);

    const ctl = new AbortController();
    const timeoutId = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    try {
      // Smart context routing (Req 4): quick actions always attach
      // the page; freeform input only attaches when the message
      // looks page-referential (see contextRouting.isPageReferential).
      // Off-topic freeform questions become a general AI chat —
      // saves tokens AND respects the user's "I'm asking something
      // else now" intent.
      const attachContext = shouldAttachPageContext(source, trimmed);
      // pageContext is populated as a Promise at sidebar-tap time
      // so the popup can open before screenshot + OCR finishes.
      // Awaiting here absorbs any residual capture latency under the
      // existing "thinking" placeholder. When we won't attach, skip
      // the await entirely.
      const ctx = attachContext ? await getPageContext() : null;
      // Vision capability is purely a property of the provider —
      // anthropic / openai / gemini get the page image, deepseek
      // doesn't. For text-only providers we silently scrub emails
      // and long digit runs (the only place redaction can actually
      // help, since there's no image channel). For image-capable
      // providers we send the composed text verbatim — redacting
      // text while shipping the full screenshot would be theatre.
      const composed = composeUserText(trimmed, ctx);
      const allowImage =
        keyFile === undefined || isImageCapableProvider(keyFile.provider);
      const userText = allowImage ? composed : redactPii(composed);
      const imageBase64 = allowImage ? ctx?.screenshotBase64 : undefined;
      infoLog(
        '[COPILOT_CHAT] send ' +
          `provider=${keyFile?.provider ?? 'fake'} ` +
          `source=${source} attachContext=${attachContext} ` +
          `allowImage=${allowImage} ` +
          `imageAttached=${imageBase64 !== undefined} ` +
          `userText.length=${userText.length} ` +
          `pageText.length=${ctx?.pageText.length ?? 0}`,
      );
      const r = await client.send(
        {
          systemPrompt: effectiveSystemPrompt,
          userText,
          imageBase64,
          maxTokens: 256,
          signal: ctl.signal,
        },
        {apiKey, model},
      );
      infoLog(
        `[COPILOT_CHAT] response latencyMs=${r.latencyMs} ` +
          `text.length=${r.text.length} model=${r.modelId}`,
      );
      const assistantMsg: ChatMessage = {
        id: newId(),
        role: 'assistant',
        text: r.text,
        modelId: r.modelId,
        latencyMs: r.latencyMs,
      };
      setMessages(curr => {
        // Replace the trailing thinking placeholder with the AI msg.
        const without = curr.filter(m => m.id !== thinkingMsg.id);
        const next = [...without, assistantMsg];
        // Persist on the same tick the UI commits — the closure
        // captures `next` so concurrent updates can't clobber it.
        persistTurn(next).catch(() => undefined);
        return next;
      });
    } catch (err) {
      // Detailed error stays in console for ops; the bubble shows a
      // short summary that doesn't leak HTTP bodies / request ids.
      console.log('[COPILOT_CHAT] sendUserMessage failed', String(err));
      const userVisible = sanitizeProviderError(err);
      const errorMsg: ChatMessage = {
        id: newId(),
        role: 'assistant',
        text: `Error: ${userVisible}`,
      };
      setMessages(curr => {
        const without = curr.filter(m => m.id !== thinkingMsg.id);
        const next = [...without, errorMsg];
        // Persist the user message even on failure — losing the
        // user's prompt to a transient network error would be worse
        // than persisting an "Error: …" bubble alongside it.
        persistTurn(next).catch(() => undefined);
        return next;
      });
    } finally {
      clearTimeout(timeoutId);
      release();
      setBusy(false);
    }
  }, [apiKey, client, effectiveSystemPrompt, keyFile, model, persistTurn]);

  // Single dispatch for any action button (built-in OR user-defined).
  // The id is opaque here — we look up the prompt from the merged
  // list. Built-in ids are the closed `QuickActionId` union; custom
  // ids are arbitrary strings minted at save time in Settings.
  // Source = 'quick-action' so the page context is always attached.
  const onActionTap = useCallback(
    (actionId: string) => {
      if (!hasKeyFile) {
        return;
      }
      const def = mergedActions.find((a) => a.id === actionId);
      if (def === undefined) {
        return;
      }
      sendUserMessage(def.prompt, 'quick-action');
    },
    [hasKeyFile, mergedActions, sendUserMessage],
  );

  // Source = 'freeform' so contextRouting.isPageReferential gates
  // whether the page context is attached. Off-topic freeform
  // questions become a general AI chat.
  const onSendInput = useCallback(() => {
    if (!hasKeyFile) {
      return;
    }
    sendUserMessage(input, 'freeform');
  }, [hasKeyFile, input, sendUserMessage]);

  // Per-bubble copy. The bubble renders the LLM's markdown source
  // through react-native-markdown-display; the clipboard, however,
  // gets a stripped plain-text version (no `###`, no `**`, etc.) so
  // pasting into a TextBox or any non-markdown target shows clean
  // prose with Unicode bullets instead of raw markdown syntax.
  const onCopyBubble = useCallback((msgId: string, text: string) => {
    const plain = markdownToPlainText(text);
    debugLog(
      `[COPILOT_CHAT] bubble copy md.length=${text.length} plain.length=${plain.length}`,
    );
    const showFeedback = (state: 'copied' | 'failed'): void => {
      setCopyFeedback({msgId, state});
      setTimeout(() => {
        setCopyFeedback(curr =>
          curr !== null && curr.msgId === msgId ? null : curr,
        );
      }, 1500);
    };
    CopilotOverlay.copyToClipboard(plain, 'Copilot reply')
      .then(result => {
        debugLog(
          '[COPILOT_CHAT] copyToClipboard result',
          JSON.stringify(result),
        );
        showFeedback(result.success ? 'copied' : 'failed');
      })
      // Native module wrappers are designed to resolve, not reject —
      // but a stray throw in the bridge would otherwise become an
      // unhandled rejection. Treat it as a failed copy.
      .catch(err => {
        console.log('[COPILOT_CHAT] copyToClipboard threw', String(err));
        showFeedback('failed');
      });
  }, []);

  const handleSmaller = useCallback(
    () => setFontSize(s => stepDown(s)),
    [],
  );
  const handleLarger = useCallback(() => setFontSize(s => stepUp(s)), []);

  // Wipes the on-screen chat so the user can start fresh on the
  // same page without closing/reopening the overlay. Keeps font size
  // (a user pref, not session state). Clears the active conversation
  // id so the NEXT send mints a fresh entry instead of overwriting
  // the previous one — the previous conversation stays in the
  // history list, capped by FIFO.
  const onNewChat = useCallback(() => {
    setMessages([]);
    setInput('');
    setCopyFeedback(null);
    setCurrentConversationId(null);
    conversationCreatedAtRef.current = null;
    setShowHistory(false);
  }, []);

  const onToggleHistory = useCallback(() => {
    setShowHistory((s) => !s);
  }, []);

  // Loads a saved conversation into the chat view, replacing whatever
  // is currently on screen. Doesn't mutate disk — switching is
  // read-only until the user sends into it, at which point the
  // existing conversation gets upserted by id.
  const onSelectConversation = useCallback(
    (conv: Conversation) => {
      setMessages(toChatMessages(conv.messages));
      setCurrentConversationId(conv.id);
      conversationCreatedAtRef.current = conv.createdAt;
      setShowHistory(false);
      setInput('');
      setCopyFeedback(null);
    },
    [],
  );

  return (
    <View testID="chat-view" style={styles.root}>
      {/* Header: title + (optional) font controls + close. Font
          controls only appear once we have a reply to scale —
          before that the buttons would be no-ops with no visible
          effect, so we keep the header minimal. */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Image
            testID="chat-title-icon"
            accessibilityLabel="Copilot icon"
            source={require('../../assets/copilot_icon.png')}
            style={styles.titleIcon}
            resizeMode="contain"
          />
          <Text style={styles.title}>Copilot</Text>
        </View>
        <View style={styles.headerControls}>
          {hasAssistantReply ? (
            <View testID="chat-font-controls" style={styles.headerControls}>
              <TouchableOpacity
                testID="chat-font-smaller"
                accessibilityLabel="Smaller font"
                onPress={handleSmaller}
                disabled={!canShrink}
                style={[styles.fontBtn, !canShrink && styles.btnDisabled]}>
                <Text style={styles.fontBtnText}>−</Text>
              </TouchableOpacity>
              <View style={styles.fontIndicator}>
                {/* Single literal `A`; the +/− neighbours convey
                    direction unambiguously, and the current size
                    letter (S/M/L) was not intuitive. */}
                <Text testID="chat-font-indicator" style={styles.fontBtnText}>
                  A
                </Text>
              </View>
              <TouchableOpacity
                testID="chat-font-larger"
                accessibilityLabel="Larger font"
                onPress={handleLarger}
                disabled={!canGrow}
                style={[styles.fontBtn, !canGrow && styles.btnDisabled]}>
                <Text style={styles.fontBtnText}>+</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <TouchableOpacity
            testID="chat-close"
            accessibilityLabel="Close Copilot"
            onPress={onClose}
            style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>×</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Context row: scope label on the left, Lock + History +
          New-chat + Settings icons on the right. Glyphs are
          Unicode-only (not emoji) so the e-ink display renders them
          at full ink weight instead of going through the color-
          emoji pipeline — visibly bolder + larger than the original
          📚 / 📝 / ⚙ emoji set. Lock (🔒) is only rendered when the
          parent reports the vault is encrypted + unlocked. */}
      <View style={styles.contextRow}>
        <Text testID="chat-context" style={styles.contextLine}>
          Context: {scopeLabel}
        </Text>
        <View style={styles.contextActions}>
          {showLockButton && onLockNow !== undefined ? (
            <TouchableOpacity
              testID="chat-lock"
              accessibilityLabel="Lock Copilot now"
              onPress={onLockNow}
              style={styles.iconBtn}>
              <Text style={styles.iconBtnText}>{'⚿'}</Text>
            </TouchableOpacity>
          ) : null}
          {history.length > 0 ? (
            <TouchableOpacity
              testID="chat-history"
              accessibilityLabel="Show recent conversations"
              onPress={onToggleHistory}
              style={styles.iconBtn}>
              {/* Pocket-watch glyph: clearer "history / past chats"
                  semantic than the books emoji 📚 and renders bolder
                  on e-ink. */}
              <Text style={styles.iconBtnText}>{'⏱'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            testID="chat-new"
            accessibilityLabel="Start a new chat"
            onPress={onNewChat}
            style={styles.iconBtn}>
            {/* Pencil glyph for "new entry" — Unicode dingbat, not
                an emoji, so the e-ink renderer draws a bold stroke
                rather than a color sprite. */}
            <Text style={styles.iconBtnText}>{'✎'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="chat-settings"
            accessibilityLabel="Open Copilot settings"
            onPress={onSettingsTap}
            style={styles.iconBtn}>
            {/* Bare gear codepoint (U+2699) — explicitly text
                presentation. Combined with the bumped fontSize (22)
                and weight 700 in iconBtnText, this reads boldly on
                the e-ink panel without going through the color-emoji
                pipeline that the variation-selector form would
                trigger. */}
            <Text style={styles.iconBtnText}>{'⚙'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Quick actions previously sat as a row here. They've moved
          into the empty-state of the chat scroll (see SuggestionCards
          below) so the chat area dominates the panel. */}

      {/* Privacy caution — matches README: vision providers send the
          screenshot as-is; DeepSeek is text-only so outbound text is
          scrubbed (emails, 7+ digit runs). No per-message toggle. */}
      <Text testID="chat-privacy-note" style={styles.privacyNote}>
        {'🛡️'} Avoid sharing sensitive info; the visible page is sent to
        your provider. Vision models receive the image; DeepSeek scrubs
        emails and long digits from text only.
      </Text>

      <View style={styles.divider} />

      {/* Chat scroll OR History panel. The history panel replaces the
          chat scroll when active so the user can pick from the last
          CONVERSATION_HISTORY_LIMIT (5) conversations. Tapping an
          item loads it back into the chat; the Close button drops
          back to the live chat without changing anything. */}
      {showHistory ? (
        <HistoryPanel
          testID="chat-history-panel"
          history={history}
          activeId={currentConversationId}
          onSelect={onSelectConversation}
          onClose={() => setShowHistory(false)}
        />
      ) : (
        <ScrollView
          testID="chat-scroll"
          style={styles.chatScroll}
          contentContainerStyle={styles.chatContent}>
          {!hasKeyFile ? (
            <SetupChecklist
              testID="chat-setup-checklist"
              headline="No API key configured. Copilot needs a key file in MyStyle/SnCopilot/ before the quick actions and chat can talk to a real model."
            />
          ) : messages.length === 0 ? (
            <SuggestionCards
              actions={mergedActions}
              disabled={busy}
              onTap={onActionTap}
            />
          ) : null}
          {messages.map(m => (
            <ChatBubble
              key={m.id}
              msg={m}
              fontScale={fontScale}
              onCopy={onCopyBubble}
              copyState={
                copyFeedback?.msgId === m.id ? copyFeedback.state : 'idle'
              }
            />
          ))}
        </ScrollView>
      )}

      <View style={styles.divider} />

      {/* Input + send — disabled when no key file is configured. */}
      <View style={styles.inputRow}>
        <TextInput
          testID="chat-input"
          accessibilityLabel="Ask about this page"
          value={input}
          onChangeText={setInput}
          placeholder={
            hasKeyFile ? 'Ask about this page…' : 'Add a key in Settings →'
          }
          editable={!busy && hasKeyFile}
          style={styles.input}
        />
        <TouchableOpacity
          testID="chat-send"
          accessibilityLabel="Send"
          onPress={onSendInput}
          disabled={busy || input.trim().length === 0 || !hasKeyFile}
          style={[
            styles.sendBtn,
            (busy || input.trim().length === 0 || !hasKeyFile) &&
              styles.btnDisabled,
          ]}>
          <Text style={styles.sendBtnText}>{'➤'}</Text>
        </TouchableOpacity>
      </View>

      {/* Footer (provider line). Settings moved up to the context
          row; this is now informational only. */}
      <Text testID="chat-footer" style={styles.footerLine}>
        Provider: {provider}
      </Text>
    </View>
  );
}


// Empty-state suggestion grid — shown inside the chat scroll when
// no messages have landed yet AND a key file is configured. Replaces
// the old "Tap a quick action above" hint. Tapping a card fires the
// same onActionTap plumbing as the previous header row. Once the
// user sends a message the grid vanishes; "New chat" brings it back.
function SuggestionCards({
  actions,
  disabled,
  onTap,
}: {
  actions: ReadonlyArray<{id: string; label: string; icon: string; prompt: string}>;
  disabled: boolean;
  onTap: (actionId: string) => void;
}): React.JSX.Element {
  return (
    <View testID="chat-suggestions" style={styles.suggestionsRoot}>
      <Text style={styles.suggestionsHint}>
        Tap a suggestion or ask a question below.
      </Text>
      <View style={styles.suggestionsGrid}>
        {actions.map((a) => (
          <TouchableOpacity
            key={a.id}
            testID={`chat-suggestion-${a.id}`}
            accessibilityLabel={a.label}
            onPress={() => onTap(a.id)}
            disabled={disabled}
            style={[styles.suggestionCard, disabled && styles.btnDisabled]}>
            <View style={styles.suggestionCardHeader}>
              <Text style={styles.suggestionIcon}>{a.icon}</Text>
              <Text style={styles.suggestionLabel} numberOfLines={1}>
                {a.label}
              </Text>
            </View>
            <Text style={styles.suggestionPrompt} numberOfLines={2}>
              {a.prompt}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// Renders the recent-conversations list inline. Tapping an entry
// hands the conversation back via onSelect (ChatView re-hydrates the
// scroll); the Close button just collapses the panel.
function HistoryPanel({
  testID,
  history,
  activeId,
  onSelect,
  onClose,
}: {
  testID: string;
  history: Conversation[];
  activeId: string | null;
  onSelect: (conv: Conversation) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <ScrollView
      testID={testID}
      style={styles.chatScroll}
      contentContainerStyle={styles.chatContent}>
      <View style={styles.historyHeader}>
        <Text style={styles.historyTitle}>Recent chats</Text>
        <TouchableOpacity
          testID={`${testID}-close`}
          accessibilityLabel="Close history"
          onPress={onClose}
          style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>×</Text>
        </TouchableOpacity>
      </View>
      {history.length === 0 ? (
        <Text style={styles.emptyHint}>No saved chats yet.</Text>
      ) : (
        history.map((c) => {
          const isActive = c.id === activeId;
          const preview = conversationPreview(c) || '(empty)';
          return (
            <TouchableOpacity
              key={c.id}
              testID={`chat-history-item-${c.id}`}
              accessibilityLabel={`Open conversation ${preview}`}
              onPress={() => onSelect(c)}
              style={[
                styles.historyItem,
                isActive && styles.historyItemActive,
              ]}>
              <Text style={styles.historyItemPreview} numberOfLines={2}>
                {preview}
              </Text>
              <Text style={styles.historyItemMeta}>
                {c.messages.length} message{c.messages.length === 1 ? '' : 's'}
                {isActive ? ' · current' : ''}
              </Text>
            </TouchableOpacity>
          );
        })
      )}
    </ScrollView>
  );
}

function ChatBubble({
  msg,
  fontScale,
  onCopy,
  copyState,
}: {
  msg: ChatMessage;
  fontScale: number;
  onCopy: (msgId: string, text: string) => void;
  copyState: 'idle' | 'copied' | 'failed';
}): React.JSX.Element {
  if (msg.role === 'user') {
    return (
      <View testID={`chat-msg-${msg.id}`} style={styles.userBubbleRow}>
        <View style={styles.userBubble}>
          <Text style={[styles.userBubbleText, {fontSize: 15 * fontScale}]}>
            {msg.text}
          </Text>
        </View>
      </View>
    );
  }
  if (msg.role === 'thinking') {
    return (
      <View testID={`chat-msg-${msg.id}`} style={styles.aiBubbleRow}>
        <Text style={styles.aiAvatar}>{'✦'}</Text>
        <View style={styles.aiBubble}>
          <Text style={styles.thinkingText}>…</Text>
        </View>
      </View>
    );
  }
  // assistant — render as markdown, with a footer carrying the Copy
  // button and model/latency metadata.
  const mdStyles = buildMarkdownStyles(fontScale);
  const copyLabel =
    copyState === 'copied'
      ? '✓ Copied'
      : copyState === 'failed'
      ? '✕ Failed'
      : '📋 Copy';
  return (
    <View testID={`chat-msg-${msg.id}`} style={styles.aiBubbleRow}>
      <Text style={styles.aiAvatar}>{'✦'}</Text>
      <View style={styles.aiBubble}>
        <Markdown style={mdStyles}>{msg.text}</Markdown>
        <View style={styles.bubbleFooter}>
          <TouchableOpacity
            testID={`chat-copy-${msg.id}`}
            accessibilityLabel="Copy reply to clipboard"
            onPress={() => onCopy(msg.id, msg.text)}
            style={styles.copyBtn}>
            <Text style={styles.copyBtnText}>{copyLabel}</Text>
          </TouchableOpacity>
          {msg.modelId !== undefined ? (
            <Text style={styles.aiMeta}>
              {msg.modelId} · {msg.latencyMs}ms
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#000000',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  titleIcon: {
    width: 28,
    height: 28,
    marginRight: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '600',
    color: '#000000',
    flexShrink: 1,
  },
  headerControls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  fontBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    minWidth: 36,
    alignItems: 'center',
    marginLeft: 4,
  },
  fontIndicator: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 32,
    alignItems: 'center',
  },
  fontBtnText: {
    fontSize: 18,
    color: '#000000',
    fontWeight: '600',
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 0,
    marginLeft: 8,
  },
  closeBtnText: {
    fontSize: 32,
    color: '#000000',
  },
  contextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    marginBottom: 8,
  },
  contextLine: {
    fontSize: 17,
    color: '#000000',
    flexShrink: 1,
  },
  contextActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBtn: {
    // Bumped from 10/4 to 12/8 + minWidth so the touch target is
    // bigger and the icon visibly stands out on the e-ink panel.
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    marginLeft: 6,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: {
    // Bumped from 18 → 22 + weight 700. The icons are the user's
    // primary navigation hand-holds; we want them legible without
    // squinting on a small-format Supernote.
    fontSize: 22,
    fontWeight: '700',
    color: '#000000',
  },
  privacyNote: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    paddingVertical: 6,
    marginBottom: 4,
  },
  divider: {
    height: 1,
    backgroundColor: '#000000',
    marginVertical: 8,
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    paddingVertical: 4,
  },
  emptyHint: {
    fontSize: 17,
    color: '#000000',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 24,
  },
  userBubbleRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 8,
  },
  userBubble: {
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 12,
  },
  userBubbleText: {
    fontSize: 17,
    color: '#000000',
  },
  aiBubbleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  aiAvatar: {
    fontSize: 18,
    color: '#000000',
    marginRight: 8,
    paddingTop: 6,
  },
  aiBubble: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#000000',
    borderStyle: 'dashed',
    borderRadius: 12,
  },
  aiBubbleText: {
    fontSize: 17,
    color: '#000000',
  },
  thinkingText: {
    fontSize: 22,
    color: '#000000',
    letterSpacing: 4,
  },
  aiMeta: {
    fontSize: 13,
    color: '#000000',
    marginTop: 6,
    fontStyle: 'italic',
  },
  bubbleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  copyBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
  },
  copyBtnText: {
    fontSize: 13,
    color: '#000000',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  input: {
    flex: 1,
    fontSize: 17,
    color: '#000000',
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 8,
  },
  sendBtn: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 8,
  },
  sendBtnText: {
    fontSize: 18,
    color: '#000000',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  footerLine: {
    fontSize: 13,
    color: '#000000',
    textAlign: 'center',
    paddingTop: 4,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  historyTitle: {
    fontSize: 17,
    color: '#000000',
    fontWeight: '600',
  },
  historyItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 8,
    marginBottom: 6,
  },
  historyItemActive: {
    borderStyle: 'dashed',
  },
  historyItemPreview: {
    fontSize: 15,
    color: '#000000',
  },
  historyItemMeta: {
    fontSize: 13,
    color: '#000000',
    fontStyle: 'italic',
    marginTop: 4,
  },
  suggestionsRoot: {paddingVertical: 8},
  suggestionsHint: {
    fontSize: 14,
    color: '#000000',
    fontStyle: 'italic',
    marginBottom: 12,
    textAlign: 'center',
  },
  // 2-column grid: each card takes ~half the row with a small gap.
  // flexBasis works around React Native's lack of CSS grid.
  suggestionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  suggestionCard: {
    width: '48%',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 8,
    marginBottom: 8,
    minHeight: 72,
  },
  suggestionCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  suggestionIcon: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000000',
    marginRight: 6,
    minWidth: 22,
    textAlign: 'center',
  },
  suggestionLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000000',
    flex: 1,
  },
  suggestionPrompt: {fontSize: 12, color: '#000000', fontStyle: 'italic'},
});
