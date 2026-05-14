// sn-plugin-lib uses ESM `import` statements that jest doesn't
// transform by default. Mock it here so SettingsView's
// `import {FileUtils} from 'sn-plugin-lib'` resolves cleanly.
type FileEntry = {path: string; type: number};
const mockListFiles =
  jest.fn<Promise<FileEntry[] | null>, [string]>();
const mockFetch = jest.fn();

jest.mock('sn-plugin-lib', () => ({
  FileUtils: {
    // exists defaults to false so prefs/vault probes report "no file"
    // unless a specific test case sets up content. Tests that need
    // the .txt path to "exist" rely on listFiles returning entries
    // — fetch is what ultimately reads them.
    exists: jest.fn(async () => false),
    listFiles: (path: string) => mockListFiles(path),
    deleteFile: jest.fn(async () => true),
    renameToFile: jest.fn(async () => true),
  },
  PluginManager: {
    registerButtonListener: jest.fn(),
    getPluginDirPath: jest.fn(async () => null),
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
      close: jest.fn(async () => ({success: true, code: 'OK', message: ''})),
      copyToClipboard: jest.fn(async () => ({success: true, code: 'OK', message: ''})),
      writeFileBase64: jest.fn(async () => ({success: true, code: 'OK', message: ''})),
      cryptoPbkdf2Sha256: jest.fn(cryptoPbkdf2Sha256MockImpl),
      cryptoRandomBytes: jest.fn(cryptoRandomBytesMockImpl),
    },
  };
});

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
import {__testing__ as sessionTesting} from '../src/storage/sessionKey';
import {
  findAllText,
  findByTestID,
  maybeFindByTestID,
  textOf,
} from './helpers/textTraversal';

// The secure-key-store wiring chains many microtask hops:
// buildWiringBundle → setBundle → SettingsViewBody mount →
// useCopilotState refresh → setState (twice — local + state-machine).
// 15 setImmediate yields drain everything in the worst case.
const flushPromises = async () => {
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

// Pump act+flush until the body of SettingsView mounts (testID
// `settings-resolution-ok` or `-none` or `-ambiguous` appears) — i.e.,
// the wiring + async discovery have resolved. Used by the
// non-no-key tests; the empty-checklist case renders synchronously.
const waitForSettingsBody = async (
  tree: ReactTestRenderer,
  maxAttempts = 20,
): Promise<void> => {
  const seen = (id: string) => tree.root.findAllByProps({testID: id}).length > 0;
  for (let i = 0; i < maxAttempts; i++) {
    if (
      seen('settings-resolution-ok') ||
      seen('settings-resolution-none') ||
      seen('settings-resolution-ambiguous')
    ) {
      return;
    }
    await act(async () => {
      await flushPromises();
    });
  }
};

// Tracks SettingsView instances across tests so we can unmount them
// in afterEach — without this, an instance from one test still has a
// pending buildWiringBundle resolution chain that fires inside the
// next test, consuming mockListFiles.mockResolvedValueOnce and
// leaking state across cases.
const liveTrees: ReactTestRenderer[] = [];

beforeEach(() => {
  mockListFiles.mockReset();
  mockFetch.mockReset();
  sessionTesting.reset();
});

afterEach(() => {
  while (liveTrees.length > 0) {
    const t = liveTrees.pop()!;
    try {
      act(() => {
        t.unmount();
      });
    } catch {
      // Tree may already be unmounted; safe to ignore.
    }
  }
});

function renderSettings(
  overrides: Partial<React.ComponentProps<typeof SettingsView>> = {},
) {
  const onClose = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<SettingsView onClose={onClose} {...overrides} />);
  });
  liveTrees.push(tree);
  return {tree, onClose};
}

// Mount + drain until SettingsView's body has rendered. Reserved for
// future tests that want to assert on testIDs which only appear after
// async discovery has resolved; keep the helper available even though
// no current case uses it.
export const renderSettingsAndWait = async (
  overrides: Partial<React.ComponentProps<typeof SettingsView>> = {},
) => {
  const r = renderSettings(overrides);
  await act(async () => {
    await flushPromises();
  });
  await waitForSettingsBody(r.tree);
  return r;
};

describe('SettingsView — discovery: no key files', () => {
  it('shows a 4-step setup checklist when MyStyle/SnCopilot is empty', async () => {
    mockListFiles.mockResolvedValueOnce(null);
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    expect(findByTestID(tree, 'settings-resolution-none')).toBeDefined();
    // Numbered steps 1-4 are individually findable.
    expect(findByTestID(tree, 'setup-step-1')).toBeDefined();
    expect(findByTestID(tree, 'setup-step-2')).toBeDefined();
    expect(findByTestID(tree, 'setup-step-3')).toBeDefined();
    expect(findByTestID(tree, 'setup-step-4')).toBeDefined();
    // No 5th step.
    expect(maybeFindByTestID(tree, 'setup-step-5')).toBeNull();

    const text = findAllText(tree).join(' | ');
    // Step content checkpoints — each checklist item lands on screen.
    expect(text).toContain('Pick a provider');
    expect(text).toContain('Create the folder');
    expect(text).toContain('/MyStyle/SnCopilot/');
    expect(text).toContain('Add the key file');
    expect(text).toContain('copilot-key-<provider>.txt');
    expect(text).toContain('Tap Refresh');
    expect(text).toContain('Refresh from disk');
    // Filename-tolerance hint preserved.
    expect(text).toContain('copilot-key-claude.txt');
    expect(text).toContain('copilot-key-google.txt');
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
          'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-test123\n',
        );
      }
      return {ok: false, status: 500, text: async () => 'unexpected'};
    });
  });

  it('shows active provider/model/masked-key/source', async () => {
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
    // Mode row was removed when 'mode' became a derived value.
    expect(maybeFindByTestID(tree, 'settings-active-mode')).toBeNull();
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

describe('SettingsView — privacy note + close', () => {
  beforeEach(() => {
    mockListFiles.mockResolvedValueOnce(null);
  });

  it('shows the static privacy note (no PII/vision toggles)', async () => {
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    expect(maybeFindByTestID(tree, 'settings-pii-toggle')).toBeNull();
    expect(maybeFindByTestID(tree, 'settings-vision-toggle')).toBeNull();
    expect(findByTestID(tree, 'settings-privacy-note')).toBeDefined();
    const note = textOf(tree, 'settings-privacy-note');
    // Both branches of the privacy posture must be visible: vision
    // providers send everything verbatim; DeepSeek scrubs the text.
    expect(note).toContain('vision providers');
    expect(note).toContain('DeepSeek');
    expect(note).toContain('avoid opening sensitive pages');
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
  it('does not setState when unmounted before bundle resolves', async () => {
    // The bootstrap chain now starts with buildWiringBundle. Hold its
    // first await — getPluginDirPath — open until after we unmount.
    // The bundle effect's cleanup sets cancelled=true so setBundle
    // never fires (no setState on an unmounted component).
    const snLib = jest.requireMock('sn-plugin-lib') as {
      PluginManager: {getPluginDirPath: jest.Mock};
    };
    let resolveDir!: (v: string | null) => void;
    snLib.PluginManager.getPluginDirPath.mockImplementationOnce(
      () => new Promise<string | null>((r) => (resolveDir = r)),
    );
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const {tree} = renderSettings();
      act(() => {
        tree.unmount();
      });
      await act(async () => {
        resolveDir(null);
        await flushPromises();
      });
      const sawWarning = errSpy.mock.calls.some((c) =>
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

describe('SettingsView — persona + custom-actions save flows', () => {
  beforeEach(() => {
    mockListFiles.mockResolvedValueOnce(null);
  });

  it('renders PersonaSettings and CustomActionsSettings sections', async () => {
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    expect(findByTestID(tree, 'persona-settings')).toBeDefined();
    expect(findByTestID(tree, 'custom-actions-settings')).toBeDefined();
  });

  it('top action row collapses Refresh / Test / Encryption into one line', async () => {
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    expect(findByTestID(tree, 'settings-action-row')).toBeDefined();
    expect(findByTestID(tree, 'settings-refresh')).toBeDefined();
    expect(findByTestID(tree, 'settings-test-connection')).toBeDefined();
    expect(findByTestID(tree, 'encryption-nav-open')).toBeDefined();
  });

  it('persona save flow invokes the onSavePersona closure (no crash)', async () => {
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    // Type a draft so Save enables, then tap.
    act(() => {
      findByTestID(tree, 'persona-input').props.onChangeText(
        'You are a careful tutor.',
      );
    });
    await act(async () => {
      findByTestID(tree, 'persona-save').props.onPress();
      await flushPromises();
    });
    // Reaching this point means the SettingsView.onSavePersona closure
    // ran (it would have thrown if wiring was broken). We're not
    // asserting persisted state here because the writeFileBase64 mock
    // returns success but doesn't round-trip — the SettingsView-level
    // test focuses on the call wiring; round-trip lives in prefs.test.ts.
    expect(findByTestID(tree, 'persona-settings')).toBeDefined();
  });

  it('custom actions section is read-only — Reload exists, no CRUD form', async () => {
    const {tree} = renderSettings();
    await act(async () => {
      await flushPromises();
    });
    // The new file-based UX has a single Reload button, no Add form.
    expect(findByTestID(tree, 'custom-actions-reload')).toBeDefined();
    expect(maybeFindByTestID(tree, 'custom-actions-add')).toBeNull();
    expect(maybeFindByTestID(tree, 'custom-action-form')).toBeNull();
    // Tap Reload (no-op in this fixture — file doesn't exist —
    // exercising the onReload wiring without asserting on disk).
    await act(async () => {
      findByTestID(tree, 'custom-actions-reload').props.onPress();
      await flushPromises();
    });
    expect(findByTestID(tree, 'custom-actions-settings')).toBeDefined();
  });
});
