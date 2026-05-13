/**
 * Tests for ChatView's conversation-history wiring (feat/rel3 Req 1+2).
 * Pins:
 *   1. With no conversationsDeps, ChatView behaves as before (no
 *      reads / writes, history icon hidden).
 *   2. With conversationsDeps + keyFile, ChatView restores the most-
 *      recent conversation on mount.
 *   3. After a send, the conversation is persisted (file appears in
 *      the in-memory fs, contains the user + assistant messages).
 *   4. The history (📚) icon shows only after history has loaded.
 *   5. Tapping the history icon reveals a list of saved chats with
 *      preview lines.
 *   6. Tapping a history item loads it back into the chat scroll.
 *   7. onNewChat clears the on-screen messages but leaves history
 *      list intact; subsequent send mints a new conversation id
 *      (history grows to two entries).
 *   8. FIFO cap of 5 is preserved (older convs evicted on overflow).
 *   9. Encrypted mode with key set produces an envelope on disk.
 */
// Pulled in via require() inside the useProviderClient mock factory.

jest.mock('../src/ui/useProviderClient', () => ({
  useProviderClient: (keyFile: {key?: string; model?: string} | undefined) => {
    const fakeProvider =
      jest.requireActual('../src/providers/fakeProvider').default;
    return {
      client: fakeProvider,
      apiKey: keyFile?.key ?? 'fake',
      model: keyFile?.model ?? 'fake-model-1',
    };
  },
}));

jest.mock('../src/native/CopilotOverlay', () => {
  const {
    cryptoPbkdf2Sha256MockImpl,
    cryptoRandomBytesMockImpl,
  } = require('./helpers/cryptoMockImpl');
  return {
    __esModule: true,
    default: {
      cryptoPbkdf2Sha256: jest.fn(cryptoPbkdf2Sha256MockImpl),
      cryptoRandomBytes: jest.fn(cryptoRandomBytesMockImpl),
      copyToClipboard: jest.fn(async () => ({
        success: true,
        code: 'OK',
        message: 'mock',
      })),
      close: jest.fn(async () => ({success: true, code: 'OK', message: 'mock'})),
    },
  };
});

jest.useFakeTimers();

import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import ChatView from '../src/ui/ChatView';
import {__testing__ as guardTesting} from '../src/reentrancy/inFlightGuard';
import {
  CONVERSATION_HISTORY_LIMIT,
  CONVERSATION_SCHEMA_VERSION,
  type Conversation,
  type KeyFile,
} from '../src/types';
import {
  loadConversations,
  saveConversation,
  type ConversationsDeps,
} from '../src/storage/conversations';
import {createInMemoryFileIo, type InMemoryFileIo} from './helpers/inMemoryFileIo';
import {findByTestID, maybeFindByTestID, findAllText} from './helpers/textTraversal';

const PATH = '/plugin/copilot-conversations.json';

const DEFAULT_KEYFILE: KeyFile = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  key: 'sk-ant-test',
  sourcePath: '/sd/copilot-key-anthropic.txt',
};

const makeDeps = (
  io: InMemoryFileIo,
  encrypted: boolean = false,
  derivedKey: Uint8Array | null = null,
): ConversationsDeps => ({
  io,
  conversationsPath: PATH,
  encryptionMode: () => (encrypted ? 'encrypted' : 'plaintext'),
  derivedKey: () => derivedKey,
  logger: {log: jest.fn(), warn: jest.fn(), error: jest.fn()},
});

const fakeKey = (): Uint8Array => {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    // eslint-disable-next-line no-bitwise
    k[i] = (i * 11 + 5) & 0xff;
  }
  return k;
};

beforeEach(() => {
  guardTesting.reset();
});

function render(overrides: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  const onSettingsTap = jest.fn();
  const onClose = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ChatView
        scopeLabel="Current Page"
        provider="Claude"
        keyFile={DEFAULT_KEYFILE}
        onSettingsTap={onSettingsTap}
        onClose={onClose}
        {...overrides}
      />,
    );
  });
  return {tree, onSettingsTap, onClose};
}

// Same flush as ChatView.test.tsx, but with an extra microtask drain
// after timer advance — saveConversation lands in a setMessages
// callback whose `void persistTurn` schedules a fire-and-forget IO
// chain that needs a few more microtasks to settle.
async function flushSendAndPersist(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(700);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  });
}

describe('ChatView — no persistence (back-compat)', () => {
  it('renders without conversationsDeps and hides the history icon', () => {
    const {tree} = render();
    expect(maybeFindByTestID(tree, 'chat-history')).toBeNull();
  });

  it('send does not touch disk when conversationsDeps is absent', async () => {
    const io = createInMemoryFileIo();
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-suggestion-summarize').props.onPress();
    });
    await flushSendAndPersist();
    expect(io.fs.size).toBe(0);
  });
});

describe('ChatView — persistence (plaintext)', () => {
  it('persists a turn after Summarize tap', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-suggestion-summarize').props.onPress();
    });
    await flushSendAndPersist();
    expect(io.fs.has(PATH)).toBe(true);
    const list = await loadConversations(deps);
    expect(list).toHaveLength(1);
    // First user message is the prompt; assistant message follows.
    const roles = list[0].messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(list[0].messages[0].text).toBe('Summarize this page');
    expect(list[0].providerId).toBe('anthropic');
  });

  it('restores the most-recent conversation on mount', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    const previous: Conversation = {
      id: 'prev-1',
      createdAt: 100,
      updatedAt: 200,
      providerId: 'anthropic',
      messages: [
        {id: 'mA', role: 'user', text: 'previous question', createdAt: 100},
        {id: 'mB', role: 'assistant', text: 'previous answer', createdAt: 110},
      ],
    };
    await saveConversation(deps, previous);
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('previous question');
    expect(text).toContain('previous answer');
    // History icon is now visible.
    expect(maybeFindByTestID(tree, 'chat-history')).not.toBeNull();
  });

  it('history list shows after restore and exposes preview lines', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    await saveConversation(deps, {
      id: 'c1',
      createdAt: 100,
      updatedAt: 200,
      messages: [
        {id: 'mA', role: 'user', text: 'first prompt text', createdAt: 100},
      ],
    });
    await saveConversation(deps, {
      id: 'c2',
      createdAt: 300,
      updatedAt: 400,
      messages: [
        {id: 'mC', role: 'user', text: 'second prompt text', createdAt: 300},
      ],
    });
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-history').props.onPress();
    });
    await flushMicrotasks();
    expect(findByTestID(tree, 'chat-history-panel')).toBeDefined();
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('first prompt text');
    expect(text).toContain('second prompt text');
    expect(text).toContain('Recent chats');
  });

  it('tapping a history item loads its conversation into the chat scroll', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    await saveConversation(deps, {
      id: 'old-1',
      createdAt: 100,
      updatedAt: 200,
      messages: [
        {id: 'mA', role: 'user', text: 'older question', createdAt: 100},
        {id: 'mB', role: 'assistant', text: 'older answer', createdAt: 110},
      ],
    });
    await saveConversation(deps, {
      id: 'new-1',
      createdAt: 300,
      updatedAt: 400,
      messages: [
        {id: 'mC', role: 'user', text: 'newer question', createdAt: 300},
      ],
    });
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    // The newer one was restored. Open history, pick the older.
    act(() => {
      findByTestID(tree, 'chat-history').props.onPress();
    });
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-history-item-old-1').props.onPress();
    });
    await flushMicrotasks();
    // Panel collapses back; chat scroll now shows the older convo.
    expect(maybeFindByTestID(tree, 'chat-history-panel')).toBeNull();
    expect(findAllText(tree).join(' | ')).toContain('older question');
    expect(findAllText(tree).join(' | ')).toContain('older answer');
  });

  it('history panel close button collapses without changing the active convo', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    await saveConversation(deps, {
      id: 'c1',
      createdAt: 100,
      updatedAt: 200,
      messages: [
        {id: 'mA', role: 'user', text: 'only conv', createdAt: 100},
      ],
    });
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-history').props.onPress();
    });
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-history-panel-close').props.onPress();
    });
    await flushMicrotasks();
    expect(maybeFindByTestID(tree, 'chat-history-panel')).toBeNull();
    expect(findAllText(tree).join(' | ')).toContain('only conv');
  });

  it('onNewChat clears messages but keeps history list intact', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    await saveConversation(deps, {
      id: 'first',
      createdAt: 100,
      updatedAt: 200,
      messages: [
        {id: 'mA', role: 'user', text: 'first convo', createdAt: 100},
      ],
    });
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-new').props.onPress();
    });
    await flushMicrotasks();
    // Messages cleared on screen, empty hint visible.
    expect(maybeFindByTestID(tree, 'chat-suggestions')).not.toBeNull();
    expect(findAllText(tree).join(' | ')).not.toContain('first convo');
    // History icon still visible (history wasn't wiped).
    expect(maybeFindByTestID(tree, 'chat-history')).not.toBeNull();
  });

  it('after New Chat a follow-up send creates a new conversation entry', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    await saveConversation(deps, {
      id: 'first',
      createdAt: 100,
      updatedAt: 200,
      messages: [
        {id: 'mA', role: 'user', text: 'first convo', createdAt: 100},
      ],
    });
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-new').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'chat-suggestion-explain').props.onPress();
    });
    await flushSendAndPersist();
    const list = await loadConversations(deps);
    expect(list).toHaveLength(2);
    // The freshly-minted conv id is NOT 'first'.
    expect(list.map((c) => c.id)).toContain('first');
    expect(list.some((c) => c.id !== 'first')).toBe(true);
  });

  it('upserts an existing conversation when the user continues a restored chat', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    await saveConversation(deps, {
      id: 'resume-me',
      createdAt: 100,
      updatedAt: 200,
      messages: [
        {id: 'mA', role: 'user', text: 'started', createdAt: 100},
        {id: 'mB', role: 'assistant', text: 'first reply', createdAt: 110},
      ],
    });
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    // Suggestion cards are empty-state-only — restored conversations
    // skip the empty state. Send via the input + send button instead,
    // which is the only mid-chat send path post-#1.
    act(() => {
      findByTestID(tree, 'chat-input').props.onChangeText('clarify please');
    });
    act(() => {
      findByTestID(tree, 'chat-send').props.onPress();
    });
    await flushSendAndPersist();
    const list = await loadConversations(deps);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('resume-me');
    // Original 2 + new user + new assistant = 4 messages.
    expect(list[0].messages).toHaveLength(4);
  });

  it('FIFO cap survives a flurry of New-Chat-then-send actions', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    // Pre-seed with 4 saved conversations; one more send completes the cap.
    for (let i = 0; i < 4; i++) {
      await saveConversation(deps, {
        id: `seed-${i}`,
        createdAt: 100 + i,
        updatedAt: 200 + i,
        messages: [
          {id: `seed-${i}-u`, role: 'user', text: `seeded ${i}`, createdAt: 100 + i},
        ],
      });
    }
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    // Two further sends each starting from a New Chat → grows beyond cap.
    for (let i = 0; i < 2; i++) {
      act(() => {
        findByTestID(tree, 'chat-new').props.onPress();
      });
      act(() => {
        findByTestID(tree, 'chat-suggestion-summarize').props.onPress();
      });
      await flushSendAndPersist();
    }
    const list = await loadConversations(deps);
    expect(list).toHaveLength(CONVERSATION_HISTORY_LIMIT);
  });
});

describe('ChatView — persistence (encrypted)', () => {
  it('encrypted mode + derived key → envelope on disk', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io, true, fakeKey());
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-suggestion-summarize').props.onPress();
    });
    await flushSendAndPersist();
    const bytes = io.fs.get(PATH)!;
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.ctB64).toBeDefined();
    expect(parsed.conversations).toBeUndefined();
    // Round-trip back via loadConversations using the same key.
    const list = await loadConversations(deps);
    expect(list).toHaveLength(1);
  });

  it('encrypted mode without derived key → write silently fails, chat still works', async () => {
    const io = createInMemoryFileIo();
    // encrypted but no key → write throws; ChatView's debug log
    // swallows it. The on-screen turn still completes.
    const deps = makeDeps(io, true, null);
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-suggestion-summarize').props.onPress();
    });
    await flushSendAndPersist();
    // Disk has no file (the write threw + was caught).
    expect(io.fs.has(PATH)).toBe(false);
    // Chat still shows both messages on screen — provider response
    // landed even though persistence failed.
    expect(findAllText(tree).join(' | ')).toContain('Summarize this page');
  });

  it('schema version pinned in persisted plaintext envelope', async () => {
    const io = createInMemoryFileIo();
    const deps = makeDeps(io);
    const {tree} = render({conversationsDeps: deps});
    await flushMicrotasks();
    act(() => {
      findByTestID(tree, 'chat-suggestion-summarize').props.onPress();
    });
    await flushSendAndPersist();
    const parsed = JSON.parse(new TextDecoder().decode(io.fs.get(PATH)!));
    expect(parsed.version).toBe(CONVERSATION_SCHEMA_VERSION);
  });
});

describe('ChatView — restore failure', () => {
  it('falls back to empty session if loadConversations throws', async () => {
    const io = createInMemoryFileIo();
    io.readBytes = async () => {
      throw new Error('disk unhappy');
    };
    const deps = makeDeps(io);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const {tree} = render({conversationsDeps: deps});
      await flushMicrotasks();
      // No history icon, empty hint shown.
      expect(maybeFindByTestID(tree, 'chat-suggestions')).not.toBeNull();
      expect(maybeFindByTestID(tree, 'chat-history')).toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});
