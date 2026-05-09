/**
 * The chat UI mounted inside the Copilot overlay.
 *
 *   ┌─ Header: "Copilot"                       [−][A][+]  [×] ─┐
 *   │  Context: <scope label>                          [📝][⚙] │
 *   │  [☰ Summary] [? Explain] [✦ Clarify] [⊡ Snapshot]        │
 *   │  🛡  PII redaction                                   [ON] │
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
 */
import React, {useCallback, useRef, useState} from 'react';
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
import type {KeyFile} from '../types';
import {composeUserText} from './composePrompt';
import {buildMarkdownStyles} from './markdownStyles';
import {markdownToPlainText} from './markdownToPlain';
import {sanitizeProviderError} from './sanitizeProviderError';
import {SYSTEM_PROMPT} from './systemPrompt';
import Toggle from './Toggle';
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
  initialPiiRedaction: boolean;
  // When a key file is configured (read at startup), keyFile is the
  // active KeyFile from MyStyle/SnCopilot/. ChatView then uses the
  // real provider client + the user's key. When undefined (no key
  // file configured), ChatView falls back to fakeProvider so the
  // demo still runs offline.
  keyFile?: KeyFile;
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
    initialPiiRedaction,
    keyFile,
    onSettingsTap,
    onClose,
  } = props;

  const {client, apiKey, model} = useProviderClient(keyFile);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [piiOn, setPiiOn] = useState<boolean>(initialPiiRedaction);
  const [busy, setBusy] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<FontSize>('S');
  // Transient per-bubble copy feedback. Only the most recently
  // copied bubble shows feedback; cleared after ~1500ms.
  const [copyFeedback, setCopyFeedback] = useState<{
    msgId: string;
    state: 'copied' | 'failed';
  } | null>(null);
  const fontScale = FONT_SCALE[fontSize];
  const canShrink = fontSize !== 'S';
  const canGrow = fontSize !== 'L';
  // Font controls only matter once there's an LLM reply to scale,
  // so hide them until then. The user's tap on a quick action
  // produces a "thinking" placeholder first, then an assistant
  // message — we wait for the assistant message specifically.
  const hasAssistantReply = messages.some(m => m.role === 'assistant');

  // Monotonically increasing message id — sufficient for our single-
  // session chat. Avoids a uuid dep.
  const nextIdRef = useRef<number>(1);
  const newId = () => `m${nextIdRef.current++}`;

  const sendUserMessage = useCallback(async (text: string) => {
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
      // pageContext is populated as a Promise at sidebar-tap time
      // so the popup can open before screenshot + OCR finishes.
      // Awaiting here absorbs any residual capture latency under the
      // existing "thinking" placeholder.
      const ctx = await getPageContext();
      // PII toggle redacts TEXT only — emails and long digit runs in
      // the composed prompt are scrubbed before the request goes
      // out. The page image is intentionally NOT gated by piiOn:
      // most Supernote pages are handwriting, and dropping the image
      // would leave the model with no content to work from. Image
      // attachment is governed by KeyFile.mode instead — text-only
      // keys never receive the image regardless of toggle state.
      const composed = composeUserText(trimmed, ctx);
      const userText = piiOn ? redactPii(composed) : composed;
      const allowImage = keyFile === undefined || keyFile.mode === 'image';
      const imageBase64 = allowImage ? ctx?.screenshotBase64 : undefined;
      // Survives prod bundles. Tells us at a glance whether the
      // payload had the bits the model needs to answer.
      infoLog(
        `[COPILOT_CHAT] send piiOn=${piiOn} ` +
          `keyFileMode=${keyFile?.mode ?? 'fake'} ` +
          `allowImage=${allowImage} ` +
          `imageAttached=${imageBase64 !== undefined} ` +
          `userText.length=${userText.length} ` +
          `pageText.length=${ctx?.pageText.length ?? 0}`,
      );
      const r = await client.send(
        {
          systemPrompt: SYSTEM_PROMPT,
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
      setMessages(curr => {
        // Replace the trailing thinking placeholder with the AI msg.
        const without = curr.filter(m => m.id !== thinkingMsg.id);
        return [
          ...without,
          {
            id: newId(),
            role: 'assistant',
            text: r.text,
            modelId: r.modelId,
            latencyMs: r.latencyMs,
          },
        ];
      });
    } catch (err) {
      // Detailed error stays in console for ops; the bubble shows a
      // short summary that doesn't leak HTTP bodies / request ids.
      console.log('[COPILOT_CHAT] sendUserMessage failed', String(err));
      const userVisible = sanitizeProviderError(err);
      setMessages(curr => {
        const without = curr.filter(m => m.id !== thinkingMsg.id);
        return [
          ...without,
          {
            id: newId(),
            role: 'assistant',
            text: `Error: ${userVisible}`,
          },
        ];
      });
    } finally {
      clearTimeout(timeoutId);
      release();
      setBusy(false);
    }
  }, [apiKey, client, keyFile, model, piiOn]);

  const onQuickActionTap = useCallback(
    (action: QuickActionId) => {
      // QuickActionId is a closed union — the find always matches.
      const def = QUICK_ACTIONS.find(a => a.id === action) as (typeof QUICK_ACTIONS)[number];
      sendUserMessage(def.prompt);
    },
    [sendUserMessage],
  );

  const onSendInput = useCallback(() => {
    sendUserMessage(input);
  }, [input, sendUserMessage]);

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

  // Wipes the chat history so the user can start fresh on the same
  // page without closing/reopening the overlay. Keeps font size and
  // pii preferences (those are user prefs, not session state).
  const onNewChat = useCallback(() => {
    setMessages([]);
    setInput('');
    setCopyFeedback(null);
  }, []);

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

      {/* Context row: scope label on the left, New-chat + Settings
          icons on the right. Putting Settings here (instead of the
          footer) makes it discoverable without scrolling — the cog
          was hard to spot beneath the input box. */}
      <View style={styles.contextRow}>
        <Text testID="chat-context" style={styles.contextLine}>
          Context: {scopeLabel}
        </Text>
        <View style={styles.contextActions}>
          <TouchableOpacity
            testID="chat-new"
            accessibilityLabel="Start a new chat"
            onPress={onNewChat}
            style={styles.iconBtn}>
            <Text style={styles.iconBtnText}>📝</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="chat-settings"
            accessibilityLabel="Open Copilot settings"
            onPress={onSettingsTap}
            style={styles.iconBtn}>
            <Text style={styles.iconBtnText}>⚙</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Quick action row — explicit gap via `gap` style; each button
          flex-shrinks gracefully on narrower devices. */}
      <View style={styles.quickActionRow}>
        {QUICK_ACTIONS.map(a => (
          <TouchableOpacity
            key={a.id}
            testID={`chat-action-${a.id}`}
            accessibilityLabel={a.label}
            onPress={() => onQuickActionTap(a.id)}
            disabled={busy}
            style={[styles.quickActionBtn, busy && styles.btnDisabled]}>
            <Text style={styles.quickActionIcon} numberOfLines={1}>
              {a.icon}
            </Text>
            <Text style={styles.quickActionLabel} numberOfLines={1}>
              {a.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* PII redaction line */}
      <View testID="chat-pii-row" style={styles.piiRow}>
        <Text style={styles.piiText}>{'🛡️'} PII redaction</Text>
        <Toggle
          testID="chat-pii-toggle"
          accessibilityLabel="Toggle PII redaction"
          value={piiOn}
          onValueChange={setPiiOn}
        />
      </View>

      <View style={styles.divider} />

      {/* Chat scroll */}
      <ScrollView
        testID="chat-scroll"
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}>
        {messages.length === 0 ? (
          <Text testID="chat-empty" style={styles.emptyHint}>
            Tap a quick action above, or ask a question below.
          </Text>
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

      <View style={styles.divider} />

      {/* Input + send */}
      <View style={styles.inputRow}>
        <TextInput
          testID="chat-input"
          accessibilityLabel="Ask about this page"
          value={input}
          onChangeText={setInput}
          placeholder="Ask about this page…"
          editable={!busy}
          style={styles.input}
        />
        <TouchableOpacity
          testID="chat-send"
          accessibilityLabel="Send"
          onPress={onSendInput}
          disabled={busy || input.trim().length === 0}
          style={[
            styles.sendBtn,
            (busy || input.trim().length === 0) && styles.btnDisabled,
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
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    marginLeft: 6,
  },
  iconBtnText: {
    fontSize: 18,
    color: '#000000',
  },
  quickActionRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    justifyContent: 'space-between',
    marginTop: 4,
    marginBottom: 6,
    gap: 6,
  },
  quickActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 8,
  },
  quickActionIcon: {
    fontSize: 15,
    color: '#000000',
    marginRight: 5,
  },
  quickActionLabel: {
    fontSize: 15,
    color: '#000000',
  },
  piiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    marginBottom: 4,
  },
  piiText: {
    fontSize: 16,
    color: '#000000',
  },
  piiToggleBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
  },
  piiToggleText: {
    fontSize: 12,
    color: '#000000',
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
});
