/**
 * Tests for the Grill Me wiring in CopilotPanel. Pins:
 *  - When the open file is a PDF, ChatView shows Grill and tapping
 *    it routes to the Grill view.
 *  - When the open file is a .note, no Grill button is rendered.
 *  - When no page context is resolved, no Grill button.
 *  - Tapping back on the Grill view returns to chat.
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

jest.mock('../src/ui/useProviderClient', () => {
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
        async send() {
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
import {
  findAllText,
  findByTestID,
  maybeFindByTestID,
} from './helpers/textTraversal';

const RETURNING_USER_PREFS = JSON.stringify({
  version: 1,
  encryptionMode: 'plaintext',
  idleTimeoutMin: 10,
  hasSeenSettings: true,
});

const KEYFILE_BLOB = 'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-x\n';

const seedKeyAndPrefs = (): void => {
  mockListFiles.mockResolvedValueOnce([
    fileEntry('/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt'),
  ]);
  mockExists.mockImplementation(async (p: string) =>
    p.endsWith('.copilot-prefs.json') ||
    p.endsWith('copilot-key-anthropic.txt'),
  );
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).endsWith('.copilot-prefs.json')) {
      return fileResp(RETURNING_USER_PREFS);
    }
    if (url.startsWith('file://')) {
      return fileResp(KEYFILE_BLOB);
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

describe('CopilotPanel — Grill Me wiring', () => {
  it('shows the Grill suggestion when a PDF is open', async () => {
    seedKeyAndPrefs();
    setPageContext({
      notePath: '/storage/emulated/0/Documents/book.pdf',
      page: 1,
      screenshotPath: '/tmp/p.png',
      screenshotBase64: 'B64',
      pageText: 'sample',
    });
    const tree = renderPanel();
    await waitForText(tree, 'Provider: Anthropic', 20);
    expect(findByTestID(tree, 'chat-suggestion-grill')).toBeDefined();
  });

  it('shows the Grill suggestion when an EPUB is open', async () => {
    seedKeyAndPrefs();
    setPageContext({
      notePath: '/storage/emulated/0/Documents/book.epub',
      page: 1,
      screenshotPath: '/tmp/p.png',
      screenshotBase64: 'B64',
      pageText: 'sample',
    });
    const tree = renderPanel();
    await waitForText(tree, 'Provider: Anthropic', 20);
    expect(findByTestID(tree, 'chat-suggestion-grill')).toBeDefined();
  });

  it('hides Grill when a .note is open (v1 PDF/EPUB only)', async () => {
    seedKeyAndPrefs();
    setPageContext({
      notePath: '/storage/emulated/0/notes/diary.note',
      page: 1,
      screenshotPath: '/tmp/p.png',
      screenshotBase64: 'B64',
      pageText: 'sample',
    });
    const tree = renderPanel();
    await waitForText(tree, 'Provider: Anthropic', 20);
    expect(maybeFindByTestID(tree, 'chat-suggestion-grill')).toBeNull();
  });

  it('hides Grill when no page context has been resolved yet', async () => {
    seedKeyAndPrefs();
    const tree = renderPanel();
    await waitForText(tree, 'Provider: Anthropic', 20);
    expect(maybeFindByTestID(tree, 'chat-suggestion-grill')).toBeNull();
  });

  it('tapping Grill routes to the Grill view; back returns to chat', async () => {
    seedKeyAndPrefs();
    setPageContext({
      notePath: '/storage/emulated/0/Documents/book.pdf',
      page: 1,
      screenshotPath: '/tmp/p.png',
      screenshotBase64: 'B64',
      pageText: 'sample',
    });
    const tree = renderPanel();
    await waitForText(tree, 'Provider: Anthropic', 20);
    act(() => {
      findByTestID(tree, 'chat-suggestion-grill').props.onPress();
    });
    expect(findByTestID(tree, 'grill-view')).toBeDefined();
    act(() => {
      findByTestID(tree, 'grill-close').props.onPress();
    });
    expect(findByTestID(tree, 'chat-view')).toBeDefined();
  });
});
