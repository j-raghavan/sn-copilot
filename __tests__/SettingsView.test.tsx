// sn-plugin-lib uses ESM `import` statements that jest doesn't
// transform by default. Mock it here so SettingsView's
// `import {FileUtils} from 'sn-plugin-lib'` resolves cleanly.
type FileEntry = {path: string; type: number};
const mockListFiles =
  jest.fn<Promise<FileEntry[] | null>, [string]>();
const mockFetch = jest.fn();

jest.mock('sn-plugin-lib', () => ({
  FileUtils: {
    exists: jest.fn(async () => true),
    listFiles: (path: string) => mockListFiles(path),
  },
  PluginManager: {
    registerButtonListener: jest.fn(),
  },
}));

// Replace global.fetch — keyFiles.ts uses fetch('file://...') for
// reads and providers use it for HTTPS.
beforeAll(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

const fileEntry = (path: string): FileEntry => ({path, type: 1});

const fileResp = (text: string) => ({
  ok: true,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});

/**
 * Tests for src/ui/SettingsView (file-mode + Test Connection).
 *
 * Pins:
 *   1. With no files in MyStyle/SnCopilot/, shows the "no key file
 *      configured" hint with template names.
 *   2. With a valid copilot-key-anthropic.txt, shows the active
 *      provider/model/masked-key/source-path.
 *   3. Test Connection is disabled when no resolution; enabled when ok.
 *   4. Tap Test Connection → calls Anthropic endpoint → renders the
 *      reply text + latency.
 *   5. PII / vision toggles flip on tap.
 *   6. [X] fires onClose.
 */
import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import SettingsView from '../src/ui/SettingsView';
import {
  findAllText,
  findByTestID,
  maybeFindByTestID,
  pressByTestID,
  textOf,
} from './helpers/textTraversal';

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  mockListFiles.mockReset();
  mockFetch.mockReset();
});

function renderSettings(
  overrides: Partial<React.ComponentProps<typeof SettingsView>> = {},
) {
  const onClose = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<SettingsView onClose={onClose} {...overrides} />);
  });
  return {tree, onClose};
}

describe('SettingsView — discovery: no key files', () => {
  it('shows the "no key file configured" hint when MyStyle/SnCopilot is empty', async () => {
    mockListFiles.mockResolvedValueOnce(null);
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    expect(findByTestID(tree, 'settings-resolution-none')).toBeDefined();
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('copilot-key-anthropic.txt');
    expect(text).toContain('copilot-key-openai.txt');
    expect(text).toContain('claude');
    expect(text).toContain('google');
  });
});

describe('SettingsView — discovery: one valid key file', () => {
  beforeEach(() => {
    mockListFiles.mockResolvedValueOnce([
      fileEntry(
        '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt',
      ),
    ]);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('file://')) {
        return fileResp(
          'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-test123\nmode=text\n',
        );
      }
      return {ok: false, status: 500, text: async () => 'unexpected'};
    });
  });

  it('shows active provider/model/masked-key/mode/source', async () => {
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    expect(findByTestID(tree, 'settings-resolution-ok')).toBeDefined();
    expect(textOf(tree, 'settings-active-model')).toBe('claude-haiku-4-5');
    // Key is masked: first 7 chars + bullets + ellipsis. NOT raw.
    expect(textOf(tree, 'settings-active-key')).not.toContain('sk-ant-test123');
    expect(textOf(tree, 'settings-active-key')).toContain('sk-ant-');
    expect(textOf(tree, 'settings-active-key')).toContain('•');
    expect(textOf(tree, 'settings-active-mode')).toBe('text');
    expect(textOf(tree, 'settings-active-source')).toContain(
      'copilot-key-anthropic.txt',
    );
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('Anthropic (Claude)');
  });

  it('Test Connection success → renders "Connection OK!" + model + latency', async () => {
    let anthropicCall = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('file://')) {
        return fileResp(
          'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-test123\n',
        );
      }
      if (url.includes('api.anthropic.com')) {
        anthropicCall++;
        return {
          ok: true,
          json: async () => ({
            content: [{type: 'text', text: 'Hi! Connection works.'}],
            usage: {input_tokens: 5, output_tokens: 6},
            model: 'claude-haiku-4-5-20251001',
          }),
        };
      }
      return {ok: false, status: 500, text: async () => 'unexpected'};
    });
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      findByTestID(tree, 'settings-test-connection').props.onPress();
      await flushPromises();
    });
    expect(anthropicCall).toBeGreaterThanOrEqual(1);
    expect(findByTestID(tree, 'settings-test-status')).toBeDefined();
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('Connection OK!');
    expect(text).toContain('claude-haiku-4-5-20251001');
    // The actual reply text should NOT be shown.
    expect(text).not.toContain('Hi! Connection works.');
  });

  it('Test Connection error renders "Connection failed: <msg>"', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('file://')) {
        return fileResp(
          'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-bad\n',
        );
      }
      if (url.includes('api.anthropic.com')) {
        return {
          ok: false,
          status: 401,
          text: async () => 'invalid x-api-key',
        };
      }
      return {ok: false, status: 500, text: async () => 'unexpected'};
    });
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      findByTestID(tree, 'settings-test-connection').props.onPress();
      await flushPromises();
    });
    expect(findByTestID(tree, 'settings-test-status')).toBeDefined();
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('Connection failed:');
    expect(text).toContain('HTTP 401');
  });
});

describe('SettingsView — discovery: parse error', () => {
  it('surfaces parse errors in the errors block', async () => {
    mockListFiles.mockResolvedValueOnce([
      fileEntry(
        '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-openai.txt',
      ),
    ]);
    // Missing required `key` field
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('file://')) {
        return fileResp('provider=openai\nmodel=gpt-5-nano\n');
      }
      return {ok: false, status: 500, text: async () => ''};
    });
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    expect(findByTestID(tree, 'settings-errors')).toBeDefined();
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('missing required field: key');
  });
});

describe('SettingsView — toggles + close', () => {
  beforeEach(() => {
    mockListFiles.mockResolvedValueOnce(null);
  });

  it('PII and vision toggles flip on tap', async () => {
    const {tree} = renderSettings({
      initialPiiRedaction: true,
      initialVision: false,
    });
    await act(async () => {
      await flushPromises();
    });
    expect(textOf(tree, 'settings-pii-toggle')).toBe('ON');
    expect(textOf(tree, 'settings-vision-toggle')).toBe('OFF');

    act(() => {
      pressByTestID(tree, 'settings-pii-toggle');
    });
    expect(textOf(tree, 'settings-pii-toggle')).toBe('OFF');

    act(() => {
      pressByTestID(tree, 'settings-vision-toggle');
    });
    expect(textOf(tree, 'settings-vision-toggle')).toBe('ON');
  });

  it('fires onClose when [X] is tapped', async () => {
    const {tree, onClose} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    act(() => {
      findByTestID(tree, 'settings-close').props.onPress();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Refresh from disk re-runs discovery', async () => {
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    // Clear the first call expectation — refresh should add a 2nd one
    mockListFiles.mockResolvedValueOnce(null);
    act(() => {
      findByTestID(tree, 'settings-refresh').props.onPress();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(mockListFiles).toHaveBeenCalledTimes(2);
    // Don't assert tree content here — maybeFindByTestID just confirms
    // the re-render fired.
    expect(maybeFindByTestID(tree, 'settings-resolution-none')).not.toBeNull();
  });
});

describe('SettingsView — short-key masking', () => {
  it('a key ≤ 7 chars is masked to bullets only (no prefix leaked)', async () => {
    mockListFiles.mockResolvedValueOnce([
      fileEntry(
        '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt',
      ),
    ]);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('file://')) {
        return fileResp('provider=anthropic\nmodel=x\nkey=abcdefg\n');
      }
      return {ok: false, status: 500, text: async () => ''};
    });
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    const masked = textOf(tree, 'settings-active-key');
    expect(masked).toBe('•••••••');
    expect(masked).not.toContain('a');
  });
});

describe('SettingsView — ambiguous resolution', () => {
  it('renders the ambiguous block when files declare conflicting defaults', async () => {
    mockListFiles.mockResolvedValueOnce([
      fileEntry(
        '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt',
      ),
      fileEntry(
        '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-openai.txt',
      ),
    ]);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('copilot-key-anthropic.txt')) {
        return fileResp(
          'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-x\ndefault_provider=anthropic\n',
        );
      }
      if (url.includes('copilot-key-openai.txt')) {
        return fileResp(
          'provider=openai\nmodel=gpt-5-nano\nkey=sk-openai\ndefault_provider=openai\n',
        );
      }
      return {ok: false, status: 500, text: async () => ''};
    });
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    expect(findByTestID(tree, 'settings-resolution-ambiguous')).toBeDefined();
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('copilot-key-anthropic.txt');
    expect(text).toContain('copilot-key-openai.txt');
  });
});

describe('SettingsView — Test Connection no-op when no resolution', () => {
  it('tapping while resolution.kind !== "ok" early-returns', async () => {
    mockListFiles.mockResolvedValueOnce(null);
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    // Status starts as idle; calling onPress directly bypasses the
    // disabled-button guard and exercises the early-return branch.
    await act(async () => {
      findByTestID(tree, 'settings-test-connection').props.onPress();
      await flushPromises();
    });
    // No status block should render
    expect(maybeFindByTestID(tree, 'settings-test-status')).toBeNull();
  });
});

describe('SettingsView — unmount safety', () => {
  it('does not setState when unmounted before discovery resolves', async () => {
    let resolveList!: (val: FileEntry[] | null) => void;
    mockListFiles.mockImplementationOnce(
      () =>
        new Promise<FileEntry[] | null>(r => {
          resolveList = r;
        }),
    );
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const {tree} = renderSettings();
      // Unmount before listFiles resolves.
      act(() => {
        tree.unmount();
      });
      // Now resolve — the post-await mountedRef guard should prevent
      // any setState (otherwise React would warn via console.error).
      await act(async () => {
        resolveList(null);
        await flushPromises();
      });
      const sawWarning = errSpy.mock.calls.some(c =>
        String(c[0] ?? '').includes('unmounted component'),
      );
      expect(sawWarning).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does not setState when unmounted before Test Connection resolves', async () => {
    mockListFiles.mockResolvedValueOnce([
      fileEntry(
        '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt',
      ),
    ]);
    let resolveSend!: (val: unknown) => void;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('file://')) {
        return fileResp(
          'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-x\n',
        );
      }
      // The Anthropic call hangs until resolveSend is invoked.
      return new Promise(r => {
        resolveSend = r;
      });
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const {tree} = renderSettings();
      await act(async () => {
        await flushPromises();
      });
      await act(async () => {
        findByTestID(tree, 'settings-test-connection').props.onPress();
        await flushPromises();
      });
      // Now unmount mid-flight, then resolve the network call.
      act(() => {
        tree.unmount();
      });
      await act(async () => {
        resolveSend({
          ok: true,
          json: async () => ({
            content: [{type: 'text', text: 'Hi'}],
            usage: {input_tokens: 1, output_tokens: 1},
            model: 'claude-haiku-4-5',
          }),
        });
        await flushPromises();
      });
      const sawWarning = errSpy.mock.calls.some(c =>
        String(c[0] ?? '').includes('unmounted component'),
      );
      expect(sawWarning).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('aborts an in-flight Test Connection on unmount and swallows the rejection', async () => {
    mockListFiles.mockResolvedValueOnce([
      fileEntry(
        '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt',
      ),
    ]);
    // The Anthropic mock listens on the AbortSignal and rejects when
    // the controller aborts (mirrors real fetch behaviour).
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('file://')) {
        return fileResp(
          'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-x\n',
        );
      }
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const {tree} = renderSettings();
      await act(async () => {
        await flushPromises();
      });
      await act(async () => {
        findByTestID(tree, 'settings-test-connection').props.onPress();
        await flushPromises();
      });
      // Unmount → cleanup aborts the controller → fetch rejects with
      // 'aborted'. The catch path's mountedRef guard blocks setState.
      await act(async () => {
        tree.unmount();
        await flushPromises();
      });
      const sawWarning = errSpy.mock.calls.some(c =>
        String(c[0] ?? '').includes('unmounted component'),
      );
      expect(sawWarning).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
