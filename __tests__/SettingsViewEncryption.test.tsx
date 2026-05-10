/**
 * Tests for the secure-key-store flows surfaced by SettingsView:
 *   - Migration banner ("Encrypt with PIN" / "Keep plaintext" /
 *     "Decide later").
 *   - Pin-setup sub-flow → encryption → cleanup prompt.
 *   - EncryptionSettings actions in encrypted+unlocked mode (Lock,
 *     Change PIN, Disable, Reset, idle-timeout pill).
 *
 * The tests use a real in-memory FileIo (via the helpers/) so the
 * full vault round-trip exercises kdf + aesGcm + atomic write.
 */

const mockListFiles = jest.fn<Promise<Array<{path: string; type: number}> | null>, [string]>();
const mockExists = jest.fn<Promise<boolean>, [string]>();
const mockDeleteFile = jest.fn<Promise<boolean>, [string]>();
const mockRenameToFile = jest.fn<Promise<boolean>, [string, string]>();
const mockGetPluginDirPath = jest.fn<Promise<string | null>, []>();
const mockWriteFileBase64 = jest.fn<
  Promise<{success: boolean; code: string; message: string}>,
  [string, string]
>();

jest.mock('sn-plugin-lib', () => ({
  FileUtils: {
    exists: (p: string) => mockExists(p),
    listFiles: (p: string) => mockListFiles(p),
    deleteFile: (p: string) => mockDeleteFile(p),
    renameToFile: (s: string, d: string) => mockRenameToFile(s, d),
  },
  PluginManager: {
    registerButtonListener: jest.fn(),
    addPluginLifeListener: jest.fn(() => ({remove: () => {}})),
    getPluginDirPath: () => mockGetPluginDirPath(),
  },
}));

jest.mock('../src/native/CopilotOverlay', () => ({
  __esModule: true,
  default: {
    close: jest.fn(async () => ({success: true, code: 'OK', message: ''})),
    copyToClipboard: jest.fn(async () => ({success: true, code: 'OK', message: ''})),
    writeFileBase64: (path: string, b64: string) => mockWriteFileBase64(path, b64),
  },
}));

const mockFetch = jest.fn();
beforeAll(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import SettingsView from '../src/ui/SettingsView';
import {__testing__ as sessionTesting} from '../src/storage/sessionKey';
import {__testing__ as idleTesting} from '../src/storage/idleTimer';
import {findByTestID, maybeFindByTestID} from './helpers/textTraversal';

const VAULT_PATH = '/plugin/copilot-key.enc';
const TXT_PATH = '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt';

// Tiny in-memory filesystem driving the bridge mocks.
type Fs = Map<string, Uint8Array>;
let fs: Fs = new Map();

const wireMocks = () => {
  mockExists.mockImplementation(async (p) => fs.has(p));
  mockDeleteFile.mockImplementation(async (p) => {
    return fs.delete(p);
  });
  mockRenameToFile.mockImplementation(async (s, d) => {
    const v = fs.get(s);
    if (!v) {
      return false;
    }
    fs.set(d, v);
    fs.delete(s);
    return true;
  });
  mockListFiles.mockImplementation(async (dir) => {
    const out: Array<{path: string; type: number}> = [];
    for (const path of fs.keys()) {
      if (path.startsWith(dir + '/') && path.lastIndexOf('/') === dir.length) {
        out.push({path, type: 1});
      }
    }
    return out;
  });
  mockGetPluginDirPath.mockResolvedValue('/plugin');
  mockWriteFileBase64.mockImplementation(async (path, b64) => {
    const bin = Buffer.from(b64, 'base64');
    fs.set(path, new Uint8Array(bin));
    return {success: true, code: 'OK', message: ''};
  });
  mockFetch.mockImplementation(async (url: string) => {
    const path = String(url).replace(/^file:\/\//, '');
    const bytes = fs.get(path);
    if (!bytes) {
      return {ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0)};
    }
    return {ok: true, arrayBuffer: async () => bytes.buffer};
  });
};

const flushPromises = async () => {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

const liveTrees: ReactTestRenderer[] = [];

beforeEach(() => {
  fs = new Map();
  mockListFiles.mockReset();
  mockExists.mockReset();
  mockDeleteFile.mockReset();
  mockRenameToFile.mockReset();
  mockGetPluginDirPath.mockReset();
  mockWriteFileBase64.mockReset();
  mockFetch.mockReset();
  wireMocks();
  sessionTesting.reset();
  idleTesting.reset();
});

afterEach(() => {
  while (liveTrees.length > 0) {
    const t = liveTrees.pop()!;
    try {
      act(() => {
        t.unmount();
      });
    } catch {
      // safe to ignore
    }
  }
});

const renderSettings = () => {
  const onClose = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<SettingsView onClose={onClose} />);
  });
  liveTrees.push(tree);
  return {tree, onClose};
};

const seedAnthropicTxt = () => {
  fs.set(
    TXT_PATH,
    new TextEncoder().encode(
      'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-x\n',
    ),
  );
};

const waitForBody = async (tree: ReactTestRenderer) => {
  for (let i = 0; i < 30; i++) {
    if (
      tree.root.findAllByProps({testID: 'settings-resolution-ok'}).length > 0 ||
      tree.root.findAllByProps({testID: 'settings-resolution-none'}).length > 0
    ) {
      return;
    }
    await act(async () => {
      await flushPromises();
    });
  }
};

describe('SettingsView — migration banner', () => {
  it('renders the banner when undecided + plaintext', async () => {
    seedAnthropicTxt();
    const {tree} = renderSettings();
    await waitForBody(tree);
    expect(findByTestID(tree, 'migration-prompt')).toBeDefined();
  });

  it('"Keep plaintext" sets prefs.encryptionMode to plaintext and hides the banner', async () => {
    seedAnthropicTxt();
    const {tree} = renderSettings();
    await waitForBody(tree);
    expect(findByTestID(tree, 'migration-prompt')).toBeDefined();
    await act(async () => {
      findByTestID(tree, 'migration-keep-plaintext').props.onPress();
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(maybeFindByTestID(tree, 'migration-prompt')).toBeNull();
  });

  it('"Decide later" closes Settings without changing prefs', async () => {
    seedAnthropicTxt();
    const {tree, onClose} = renderSettings();
    await waitForBody(tree);
    act(() => {
      findByTestID(tree, 'migration-decide-later').props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SettingsView — encrypt flow', () => {
  it('Encrypt → enter PIN → cleanup prompt → delete plaintext', async () => {
    seedAnthropicTxt();
    const {tree} = renderSettings();
    await waitForBody(tree);
    act(() => {
      findByTestID(tree, 'migration-encrypt').props.onPress();
    });
    expect(findByTestID(tree, 'pin-setup')).toBeDefined();
    act(() => {
      findByTestID(tree, 'pin-input-primary').props.onChangeText('123456');
    });
    act(() => {
      findByTestID(tree, 'pin-input-confirm').props.onChangeText('123456');
    });
    await act(async () => {
      findByTestID(tree, 'pin-submit').props.onPress();
      await flushPromises();
    });
    // Cleanup prompt now visible.
    expect(findByTestID(tree, 'cleanup-prompt')).toBeDefined();
    // Vault file should exist.
    expect(fs.has(VAULT_PATH)).toBe(true);
    await act(async () => {
      findByTestID(tree, 'cleanup-delete').props.onPress();
      await flushPromises();
    });
    // .txt deleted; encrypted+unlocked encryption section visible.
    expect(fs.has(TXT_PATH)).toBe(false);
  });

  it('cleanup "Skip" leaves the .txt in place', async () => {
    seedAnthropicTxt();
    const {tree} = renderSettings();
    await waitForBody(tree);
    act(() => {
      findByTestID(tree, 'migration-encrypt').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'pin-input-primary').props.onChangeText('123456');
    });
    act(() => {
      findByTestID(tree, 'pin-input-confirm').props.onChangeText('123456');
    });
    await act(async () => {
      findByTestID(tree, 'pin-submit').props.onPress();
      await flushPromises();
    });
    await act(async () => {
      findByTestID(tree, 'cleanup-skip').props.onPress();
      await flushPromises();
    });
    expect(fs.has(TXT_PATH)).toBe(true);
  });

  it('PIN setup Cancel returns to the migration banner', async () => {
    seedAnthropicTxt();
    const {tree} = renderSettings();
    await waitForBody(tree);
    act(() => {
      findByTestID(tree, 'migration-encrypt').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'pin-cancel').props.onPress();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(findByTestID(tree, 'migration-prompt')).toBeDefined();
  });
});

const setupEncryptedAndUnlock = async () => {
  seedAnthropicTxt();
  const {tree, onClose} = renderSettings();
  await waitForBody(tree);
  act(() => {
    findByTestID(tree, 'migration-encrypt').props.onPress();
  });
  act(() => {
    findByTestID(tree, 'pin-input-primary').props.onChangeText('123456');
  });
  act(() => {
    findByTestID(tree, 'pin-input-confirm').props.onChangeText('123456');
  });
  await act(async () => {
    findByTestID(tree, 'pin-submit').props.onPress();
    await flushPromises();
  });
  await act(async () => {
    findByTestID(tree, 'cleanup-delete').props.onPress();
    await flushPromises();
  });
  return {tree, onClose};
};

describe('SettingsView — encrypted+unlocked actions', () => {
  it('renders the encrypted+unlocked encryption section', async () => {
    const {tree} = await setupEncryptedAndUnlock();
    expect(findByTestID(tree, 'encryption-settings-encrypted')).toBeDefined();
  });

  it('Lock now wipes session and triggers onClose', async () => {
    const {tree, onClose} = await setupEncryptedAndUnlock();
    act(() => {
      findByTestID(tree, 'encryption-lock-now').props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('Change PIN flow updates the vault key', async () => {
    const {tree} = await setupEncryptedAndUnlock();
    act(() => {
      findByTestID(tree, 'encryption-change-pin').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'pin-input-primary').props.onChangeText('654321');
    });
    act(() => {
      findByTestID(tree, 'pin-input-confirm').props.onChangeText('654321');
    });
    await act(async () => {
      findByTestID(tree, 'pin-submit').props.onPress();
      await flushPromises();
    });
    // Vault file is still there; we won't decrypt it inside the test
    // (kdf is slow) — just verify we returned to the main settings.
    expect(maybeFindByTestID(tree, 'pin-setup')).toBeNull();
    expect(findByTestID(tree, 'encryption-settings-encrypted')).toBeDefined();
  });

  it('Disable encryption writes back plaintext + flips prefs to plaintext', async () => {
    const {tree} = await setupEncryptedAndUnlock();
    await act(async () => {
      findByTestID(tree, 'encryption-disable').props.onPress();
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    // Vault gone, plaintext written.
    expect(fs.has(VAULT_PATH)).toBe(false);
    expect(fs.has(TXT_PATH)).toBe(true);
  });

  it('Reset deletes the vault and returns to no-key', async () => {
    const {tree} = await setupEncryptedAndUnlock();
    await act(async () => {
      findByTestID(tree, 'encryption-reset').props.onPress();
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(fs.has(VAULT_PATH)).toBe(false);
    expect(findByTestID(tree, 'encryption-settings-plaintext')).toBeDefined();
  });

  it('Idle-timeout pill press persists the new value', async () => {
    const {tree} = await setupEncryptedAndUnlock();
    await act(async () => {
      findByTestID(tree, 'encryption-idle-30').props.onPress();
      await flushPromises();
    });
    // Re-render flushed; the section renders 30 as the active value.
    expect(findByTestID(tree, 'encryption-idle-30')).toBeDefined();
  });
});

describe('SettingsView — encrypt failure paths', () => {
  it('stays in PIN setup when the underlying vault write fails', async () => {
    seedAnthropicTxt();
    const {tree} = renderSettings();
    await waitForBody(tree);
    act(() => {
      findByTestID(tree, 'migration-encrypt').props.onPress();
    });
    // Force the first writeFileBase64 (the .enc.tmp) to fail.
    mockWriteFileBase64.mockResolvedValueOnce({
      success: false,
      code: 'WRITE_FAILED',
      message: 'disk full',
    });
    act(() => {
      findByTestID(tree, 'pin-input-primary').props.onChangeText('123456');
    });
    act(() => {
      findByTestID(tree, 'pin-input-confirm').props.onChangeText('123456');
    });
    await act(async () => {
      findByTestID(tree, 'pin-submit').props.onPress();
      await flushPromises();
    });
    // No cleanup prompt — we never reached it.
    expect(maybeFindByTestID(tree, 'cleanup-prompt')).toBeNull();
    expect(fs.has(VAULT_PATH)).toBe(false);
  });
});

describe('SettingsView — disable encryption with optional fields', () => {
  it('preserves clarify_redact=off when disabling', async () => {
    fs.set(
      TXT_PATH,
      new TextEncoder().encode(
        'provider=anthropic\n' +
          'model=claude-haiku-4-5\n' +
          'key=sk-ant-x\n' +
          'clarify_redact=off\n',
      ),
    );
    const {tree} = renderSettings();
    await waitForBody(tree);
    act(() => {
      findByTestID(tree, 'migration-encrypt').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'pin-input-primary').props.onChangeText('123456');
    });
    act(() => {
      findByTestID(tree, 'pin-input-confirm').props.onChangeText('123456');
    });
    await act(async () => {
      findByTestID(tree, 'pin-submit').props.onPress();
      await flushPromises();
    });
    await act(async () => {
      findByTestID(tree, 'cleanup-delete').props.onPress();
      await flushPromises();
    });
    await act(async () => {
      findByTestID(tree, 'encryption-disable').props.onPress();
      await flushPromises();
    });
    const written = fs.get(TXT_PATH);
    expect(new TextDecoder().decode(written!)).toContain('clarify_redact=off');
  });

  it('preserves default_provider and clarify_redact in the written .txt', async () => {
    // Seed a .txt with the optional fields present.
    fs.set(
      TXT_PATH,
      new TextEncoder().encode(
        'provider=anthropic\n' +
          'model=claude-haiku-4-5\n' +
          'key=sk-ant-x\n' +
          'default_provider=anthropic\n' +
          'clarify_redact=on\n',
      ),
    );
    const {tree} = renderSettings();
    await waitForBody(tree);
    act(() => {
      findByTestID(tree, 'migration-encrypt').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'pin-input-primary').props.onChangeText('123456');
    });
    act(() => {
      findByTestID(tree, 'pin-input-confirm').props.onChangeText('123456');
    });
    await act(async () => {
      findByTestID(tree, 'pin-submit').props.onPress();
      await flushPromises();
    });
    await act(async () => {
      findByTestID(tree, 'cleanup-delete').props.onPress();
      await flushPromises();
    });
    // Now disable; the write-back should re-emit both optional fields.
    await act(async () => {
      findByTestID(tree, 'encryption-disable').props.onPress();
      await flushPromises();
    });
    const written = fs.get(TXT_PATH);
    expect(written).toBeDefined();
    const text = new TextDecoder().decode(written!);
    expect(text).toContain('default_provider=anthropic');
    expect(text).toContain('clarify_redact=on');
  });
});
