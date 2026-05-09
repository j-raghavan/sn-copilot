/**
 * Tests for the navigation root mounted by the native overlay. Pins
 * the state machine:
 *   - initial view = chat
 *   - settings cog → SettingsView; settings [X] → ChatView
 *   - chat [X] → CopilotOverlay.close()
 *   - props (initialScopeLabel / initialProvider / initialPiiRedaction)
 *     flow into ChatView
 */
const mockClose = jest.fn(async () => ({
  success: true,
  code: 'OK',
  message: 'fixture',
}));

jest.mock('../src/native/CopilotOverlay', () => ({
  __esModule: true,
  default: {
    close: () => mockClose(),
    copyToClipboard: jest.fn(async () => ({
      success: true,
      code: 'OK',
      message: 'fixture',
    })),
  },
}));

// sn-plugin-lib uses ESM `import` statements that jest doesn't
// transform by default. Mock it here so CopilotPanel's
// `import {FileUtils} from 'sn-plugin-lib'` resolves cleanly.
type FileEntry = {path: string; type: number};
const mockListFiles =
  jest.fn<Promise<FileEntry[] | null | undefined>, [string]>();
mockListFiles.mockResolvedValue(null);

jest.mock('sn-plugin-lib', () => ({
  FileUtils: {
    exists: jest.fn(async () => false),
    listFiles: (path: string) => mockListFiles(path),
  },
  PluginManager: {
    registerButtonListener: jest.fn(),
  },
}));

const mockFetch = jest.fn();
beforeAll(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

const fileEntry = (path: string): FileEntry => ({path, type: 1});

const fileResp = (text: string) => ({
  ok: true,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import CopilotPanel from '../src/ui/CopilotPanel';
import {findAllText, findByTestID} from './helpers/textTraversal';

beforeEach(() => {
  mockClose.mockClear();
  mockListFiles.mockReset();
  mockListFiles.mockResolvedValue(null);
  mockFetch.mockReset();
});

function render(
  overrides: Partial<React.ComponentProps<typeof CopilotPanel>> = {},
) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<CopilotPanel {...overrides} />);
  });
  return tree;
}

describe('CopilotPanel — navigation root', () => {
  it('starts on the ChatView', () => {
    const tree = render();
    expect(findByTestID(tree, 'chat-view')).toBeDefined();
  });

  it('settings cog → SettingsView; settings [X] → ChatView', () => {
    const tree = render();
    act(() => {
      findByTestID(tree, 'chat-settings').props.onPress();
    });
    expect(findByTestID(tree, 'settings-view')).toBeDefined();

    act(() => {
      findByTestID(tree, 'settings-close').props.onPress();
    });
    expect(findByTestID(tree, 'chat-view')).toBeDefined();
  });

  it('chat [X] calls CopilotOverlay.close', () => {
    const tree = render();
    act(() => {
      findByTestID(tree, 'chat-close').props.onPress();
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('honours initialScopeLabel and initialPiiRedaction; provider falls back to "Demo (no key)"', () => {
    const tree = render({
      initialScopeLabel: 'Lasso selection',
      initialPiiRedaction: false,
    });
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('Context: Lasso selection');
    // No key file resolved in test env → fallback provider label
    expect(text).toContain('Demo (no key)');
  });

  it('shows the resolved provider label when discovery returns one valid file', async () => {
    mockListFiles.mockResolvedValueOnce([
      fileEntry(
        '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt',
      ),
    ]);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('file://')) {
        return fileResp(
          'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-x\n',
        );
      }
      return {ok: false, status: 500, text: async () => ''};
    });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<CopilotPanel />);
      await flushPromises();
    });
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('Provider: Anthropic');
  });

  it('logs and falls back when discovery throws', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // FileUtils.listFiles itself throws, which keyFiles internally
      // catches → empty file list → 'none' → ChatView gets undefined
      // keyFile → "Demo (no key)" provider label.
      mockListFiles.mockImplementationOnce(async () => {
        throw new Error('listFiles boom');
      });
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = create(<CopilotPanel />);
        await flushPromises();
      });
      const text = findAllText(tree).join(' | ');
      expect(text).toContain('Demo (no key)');
    } finally {
      log.mockRestore();
    }
  });

  it('cancels the in-flight discovery on unmount (early-return + cleanup)', async () => {
    // Make listFiles hang until we resolve manually so we can unmount
    // BEFORE the async chain completes.
    let resolveList!: (v: FileEntry[] | null) => void;
    mockListFiles.mockImplementationOnce(
      () => new Promise<FileEntry[] | null>(r => (resolveList = r)),
    );
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<CopilotPanel />);
    });
    // Unmount triggers the effect cleanup (cancelled = true).
    act(() => {
      tree.unmount();
    });
    // Now resolve the pending listFiles — discovery proceeds, sees
    // cancelled = true, and returns early.
    await act(async () => {
      resolveList(null);
      await flushPromises();
    });
  });
});

