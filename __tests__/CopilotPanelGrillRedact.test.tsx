/**
 * Pins the privacy contract for Grill flow on text-only providers
 * (DeepSeek): emails and 7+ digit runs in page text must be scrubbed
 * before any grill module sees them. Mirrors ChatView's existing
 * contract (see __tests__/ChatViewSmartContext.test.tsx for the
 * chat-side equivalent).
 */
const mockClose = jest.fn(async () => ({
  success: true,
  code: 'OK',
  message: 'fixture',
}));

jest.mock('../src/native/CopilotOverlay', () => {
  const {
    cryptoPbkdf2Sha256MockImpl,
    cryptoRandomBytesMockImpl,
  } = require('./helpers/cryptoMockImpl');
  return {
    __esModule: true,
    default: {
      close: () => mockClose(),
      copyToClipboard: jest.fn(async () => ({
        success: true,
        code: 'OK',
        message: 'fixture',
      })),
      writeFileBase64: jest.fn(async () => ({
        success: true,
        code: 'OK',
        message: 'fixture',
      })),
      cryptoPbkdf2Sha256: jest.fn(cryptoPbkdf2Sha256MockImpl),
      cryptoRandomBytes: jest.fn(cryptoRandomBytesMockImpl),
    },
  };
});

type FileEntry = {path: string; type: number};
const mockListFiles =
  jest.fn<Promise<FileEntry[] | null | undefined>, [string]>();
const mockExists = jest.fn<Promise<boolean>, [string]>(async () => false);

jest.mock('sn-plugin-lib', () => ({
  FileUtils: {
    exists: (p: string) => mockExists(p),
    listFiles: (path: string) => mockListFiles(path),
    deleteFile: jest.fn(async () => true),
    renameToFile: jest.fn(async () => true),
  },
  PluginManager: {
    registerButtonListener: jest.fn(),
    getPluginDirPath: jest.fn(async () => null),
  },
}));

// Capture the user text the provider sees on the generate call so we
// can assert the page-text was redacted before deckGenerator sent it.
const capturedUserTexts: string[] = [];

jest.mock('../src/ui/useProviderClient', () => {
  const captured = (globalThis as {__capturedUserTexts__?: string[]})
    .__capturedUserTexts__ ?? [];
  (globalThis as {__capturedUserTexts__?: string[]}).__capturedUserTexts__ =
    captured;
  const mockDeck = JSON.stringify([
    {
      id: 'm1',
      type: 'definition',
      stem: 'stem 1?',
      choices: ['A', 'B', 'C', 'D'],
      correctIndex: 0,
      explanation: 'r',
      sourceQuote: 'q',
    },
  ]);
  return {
    useProviderClient: () => ({
      client: {
        id: 'fake',
        async send(req: {userText: string}) {
          captured.push(req.userText);
          return {
            text: mockDeck,
            usage: {inputTokens: 1, outputTokens: 1},
            latencyMs: 1,
            modelId: 'm',
          };
        },
      },
      apiKey: 'fake',
      model: 'fake-model-1',
    }),
  };
});

const mockFetch = jest.fn();
beforeAll(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

const fileEntry = (path: string): FileEntry => ({path, type: 1});

const fileResp = (text: string) => ({
  ok: true,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

const waitForText = async (
  tree: ReactTestRenderer,
  expected: string,
  maxAttempts: number,
): Promise<void> => {
  for (let i = 0; i < maxAttempts; i++) {
    await act(async () => {
      await flushPromises();
    });
    tree.toJSON();
    if (findAllText(tree).join(' | ').includes(expected)) {
      return;
    }
  }
};

import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import CopilotPanel from '../src/ui/CopilotPanel';
import {__testing__ as sessionTesting} from '../src/storage/sessionKey';
import {__testing__ as guardTesting} from '../src/reentrancy/inFlightGuard';
import {__testing__ as pageCtxTesting, setPageContext} from '../src/scope/pageContext';
import {findAllText, findByTestID} from './helpers/textTraversal';

const RETURNING_USER_PREFS = JSON.stringify({
  version: 1,
  encryptionMode: 'plaintext',
  idleTimeoutMin: 10,
  hasSeenSettings: true,
});

const seedKeyAndPrefs = (provider: 'anthropic' | 'deepseek'): void => {
  const filename = `copilot-key-${provider}.txt`;
  mockListFiles.mockResolvedValueOnce([
    fileEntry(`/storage/emulated/0/MyStyle/SnCopilot/${filename}`),
  ]);
  mockExists.mockImplementation(async (p: string) =>
    p.endsWith('.copilot-prefs.json') || p.endsWith(filename),
  );
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).endsWith('.copilot-prefs.json')) {
      return fileResp(RETURNING_USER_PREFS);
    }
    if (url.startsWith('file://')) {
      return fileResp(`provider=${provider}\nmodel=m1\nkey=k1\n`);
    }
    return {ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0)};
  });
};

const liveTrees: ReactTestRenderer[] = [];

beforeEach(() => {
  mockClose.mockClear();
  mockListFiles.mockReset();
  mockListFiles.mockResolvedValue(null);
  mockFetch.mockReset();
  mockExists.mockReset();
  sessionTesting.reset();
  guardTesting.reset();
  pageCtxTesting.reset();
  capturedUserTexts.length = 0;
  const captured = (globalThis as {__capturedUserTexts__?: string[]})
    .__capturedUserTexts__;
  if (captured) {
    captured.length = 0;
  }
});

afterEach(() => {
  while (liveTrees.length > 0) {
    const t = liveTrees.pop()!;
    try {
      act(() => {
        t.unmount();
      });
    } catch {
      // Ignore.
    }
  }
});

const renderPanel = (): ReactTestRenderer => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<CopilotPanel />);
  });
  liveTrees.push(tree);
  return tree;
};

const PII_PAGE_TEXT =
  'Contact alice@example.com or call 5551234567 — also account 9876543210.';

describe('CopilotPanel — Grill privacy contract', () => {
  it('scrubs emails + long digit runs from page text on DeepSeek (text-only)', async () => {
    seedKeyAndPrefs('deepseek');
    setPageContext({
      notePath: '/storage/emulated/0/Documents/book.pdf',
      page: 1,
      screenshotPath: '/tmp/p.png',
      screenshotBase64: 'B64',
      pageText: PII_PAGE_TEXT,
    });
    const tree = renderPanel();
    await waitForText(tree, 'Provider:', 20);
    act(() => {
      findByTestID(tree, 'chat-suggestion-grill').props.onPress();
    });
    await act(async () => {
      await flushPromises();
    });
    const captured =
      (globalThis as {__capturedUserTexts__?: string[]})
        .__capturedUserTexts__ ?? [];
    const generateText = captured.find((t) =>
      t.includes('Generate exactly'),
    );
    expect(generateText).toBeDefined();
    if (generateText !== undefined) {
      expect(generateText).not.toContain('alice@example.com');
      expect(generateText).not.toContain('5551234567');
      expect(generateText).not.toContain('9876543210');
      expect(generateText).toContain('[REDACTED-EMAIL]');
      expect(generateText).toContain('[REDACTED-NUMBER]');
    }
  });

  it('does NOT scrub on vision providers — image already carries the page', async () => {
    seedKeyAndPrefs('anthropic');
    setPageContext({
      notePath: '/storage/emulated/0/Documents/book.pdf',
      page: 1,
      screenshotPath: '/tmp/p.png',
      screenshotBase64: 'B64',
      pageText: PII_PAGE_TEXT,
    });
    const tree = renderPanel();
    await waitForText(tree, 'Provider:', 20);
    act(() => {
      findByTestID(tree, 'chat-suggestion-grill').props.onPress();
    });
    await act(async () => {
      await flushPromises();
    });
    const captured =
      (globalThis as {__capturedUserTexts__?: string[]})
        .__capturedUserTexts__ ?? [];
    const generateText = captured.find((t) =>
      t.includes('Generate exactly'),
    );
    expect(generateText).toBeDefined();
    if (generateText !== undefined) {
      expect(generateText).toContain('alice@example.com');
      expect(generateText).toContain('5551234567');
    }
  });
});
