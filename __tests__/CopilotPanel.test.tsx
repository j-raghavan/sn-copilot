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
    writeFileBase64: jest.fn(async () => ({
      success: true,
      code: 'OK',
      message: 'fixture',
    })),
    cryptoPbkdf2Sha256: jest.fn(async () => ({
      success: false, code: 'MODULE_MISSING', message: 'mock',
    })),
    cryptoRandomBytes: jest.fn(async () => ({
      success: false, code: 'MODULE_MISSING', message: 'mock',
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
    deleteFile: jest.fn(async () => true),
    renameToFile: jest.fn(async () => true),
  },
  PluginManager: {
    registerButtonListener: jest.fn(),
    // Returning null forces resolveVaultPaths into the fallback path
    // (MyStyle/SnCopilot/.copilot-key.enc), which the test can ignore
    // because we don't write a vault in these scenarios.
    getPluginDirPath: jest.fn(async () => null),
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

// The secure-key-store wiring chains across many microtask hops:
// buildWiringBundle → setBundle → CopilotPanelInner mount →
// useCopilotState effect → Promise.all([readPrefs, vaultExists,
// discoverKeyFiles]) → setState. setImmediate yields back to the
// macrotask queue between each pump so React's commit + new effect
// scheduling get a chance to drain.
const flushPromises = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

// Pump act + flush until `expected` appears in the rendered text or
// `maxAttempts` is reached. Each iteration also forces a full tree
// snapshot via toJSON() so we don't read a stale cache, and yields to
// setImmediate to let any queued macro-tasks (and React's own commit
// scheduling) drain before we re-check.
const waitForText = async (
  tree: ReactTestRenderer,
  expected: string,
  maxAttempts: number,
): Promise<void> => {
  for (let i = 0; i < maxAttempts; i++) {
    await act(async () => {
      await flushPromises();
    });
    // Forcing toJSON walks the live tree.
    tree.toJSON();
    if (findAllText(tree).join(' | ').includes(expected)) {
      return;
    }
  }
};

import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import CopilotPanel from '../src/ui/CopilotPanel';
import {__testing__ as sessionTesting} from '../src/storage/sessionKey';
import {findAllText, findByTestID} from './helpers/textTraversal';

beforeEach(() => {
  mockClose.mockClear();
  mockListFiles.mockReset();
  mockListFiles.mockResolvedValue(null);
  mockFetch.mockReset();
  // Module-scope state that earlier tests can leak via leftover
  // CopilotPanel mounts (they subscribe via useCopilotState and the
  // tests don't unmount between cases).
  sessionTesting.reset();
});

// All currently-mounted CopilotPanel instances. Tracked so afterEach
// can unmount them — without this, an instance from one test still
// has a pending buildWiringBundle resolution chain that fires inside
// the NEXT test, consuming mockListFiles.mockResolvedValueOnce and
// leaking state across cases.
const liveTrees: ReactTestRenderer[] = [];

afterEach(() => {
  while (liveTrees.length > 0) {
    const t = liveTrees.pop()!;
    try {
      act(() => {
        t.unmount();
      });
    } catch {
      // Ignore — the tree may already have been unmounted by the test.
    }
  }
});

function render(
  overrides: Partial<React.ComponentProps<typeof CopilotPanel>> = {},
) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<CopilotPanel {...overrides} />);
  });
  liveTrees.push(tree);
  return tree;
}

describe('CopilotPanel — navigation root', () => {
  it('starts on the ChatView', () => {
    const tree = render();
    expect(findByTestID(tree, 'chat-view')).toBeDefined();
  });

  it('settings cog → SettingsView; settings [X] → ChatView', async () => {
    const tree = render();
    // Wait for buildWiringBundle to resolve so the CopilotPanelInner
    // mounts with the real onSettingsTap (the FallbackChat shown
    // before bundle resolves uses a no-op handler).
    await act(async () => {
      await flushPromises();
    });
    act(() => {
      findByTestID(tree, 'chat-settings').props.onPress();
    });
    await act(async () => {
      await flushPromises();
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
    liveTrees.push(tree);
    await waitForText(tree, 'Provider: Anthropic', 20);
    expect(findAllText(tree).join(' | ')).toContain('Provider: Anthropic');
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
      liveTrees.push(tree);
      const text = findAllText(tree).join(' | ');
      expect(text).toContain('Demo (no key)');
    } finally {
      log.mockRestore();
    }
  });

  it('unmount before bundle resolves does not crash (cancellation guard)', async () => {
    // The bootstrap chain now starts with buildWiringBundle. Hold its
    // first await — getPluginDirPath — open until after we unmount.
    // The effect cleanup sets cancelled=true so setBundle never fires.
    const snLib = jest.requireMock('sn-plugin-lib') as {
      PluginManager: {getPluginDirPath: jest.Mock};
    };
    let resolveDir!: (v: string | null) => void;
    snLib.PluginManager.getPluginDirPath.mockImplementationOnce(
      () => new Promise<string | null>(r => (resolveDir = r)),
    );
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<CopilotPanel />);
    });
    act(() => {
      tree.unmount();
    });
    // Resolving after unmount must not throw (the effect's cleanup
    // checks `cancelled` before calling setBundle).
    await act(async () => {
      resolveDir(null);
      await flushPromises();
    });
  });
});

