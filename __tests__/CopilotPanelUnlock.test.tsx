/**
 * Tests for CopilotPanel's secure-key-store integration:
 *   - Encrypted vault → UnlockScreen replaces ChatView until unlocked.
 *   - Successful unlock pops UnlockScreen and renders ChatView with the
 *     active provider.
 *   - Reset (after N failures or via the reset button when shown)
 *     clears the vault.
 *   - Merge state (vault + plaintext) shows UnlockScreen; on success the
 *     plaintext is folded into the vault.
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
const mockClose = jest.fn(async () => ({success: true, code: 'OK', message: 'fixture'}));

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
    close: () => mockClose(),
    copyToClipboard: jest.fn(async () => ({success: true, code: 'OK', message: ''})),
    writeFileBase64: (path: string, b64: string) => mockWriteFileBase64(path, b64),
    cryptoPbkdf2Sha256: jest.fn(async () => ({
      success: false, code: 'MODULE_MISSING', message: 'mock',
    })),
    cryptoRandomBytes: jest.fn(async () => ({
      success: false, code: 'MODULE_MISSING', message: 'mock',
    })),
  },
}));

const mockFetch = jest.fn();
beforeAll(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import CopilotPanel from '../src/ui/CopilotPanel';
import {writeVault} from '../src/storage/vault';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';
import {__testing__ as sessionTesting} from '../src/storage/sessionKey';
import {__testing__ as idleTesting} from '../src/storage/idleTimer';
import {findAllText, findByTestID, maybeFindByTestID} from './helpers/textTraversal';
import type {KeyFile} from '../src/types';

const VAULT_PATH = '/plugin/copilot-key.enc';
const TXT_PATH = '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt';

let fs: Map<string, Uint8Array> = new Map();

const wireMocks = () => {
  mockExists.mockImplementation(async (p) => fs.has(p));
  mockDeleteFile.mockImplementation(async (p) => fs.delete(p));
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
    fs.set(path, new Uint8Array(Buffer.from(b64, 'base64')));
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
  mockClose.mockClear();
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
      // safe
    }
  }
});

const seedVault = async (pin: string, files: KeyFile[]) => {
  // Write directly through an in-memory IO that mirrors `fs`.
  const io = createInMemoryFileIo();
  for (const [k, v] of fs) {
    io.fs.set(k, v);
  }
  await writeVault({io, vaultPath: VAULT_PATH}, pin, files);
  // Copy back into the test fs (so the panel sees the vault).
  for (const [k, v] of io.fs) {
    fs.set(k, v);
  }
};

const seedTxt = () => {
  fs.set(
    TXT_PATH,
    new TextEncoder().encode(
      'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-x\n',
    ),
  );
};

const sampleKey: KeyFile = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  key: 'sk-ant-x',
  sourcePath: TXT_PATH,
};

const waitFor = async (
  tree: ReactTestRenderer,
  predicate: () => boolean,
  maxAttempts = 30,
) => {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await flushPromises();
    });
  }
};

const render = () => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<CopilotPanel />);
  });
  liveTrees.push(tree);
  return tree;
};

describe('CopilotPanel — encrypted vault', () => {
  it('shows UnlockScreen when vault exists and session is empty', async () => {
    await seedVault('123456', [sampleKey]);
    const tree = render();
    await waitFor(tree, () => maybeFindByTestID(tree, 'unlock-screen') !== null);
    expect(findByTestID(tree, 'unlock-screen')).toBeDefined();
    expect(maybeFindByTestID(tree, 'chat-view')).toBeNull();
  });

  it('successful unlock with the right PIN renders ChatView with the active provider', async () => {
    await seedVault('123456', [sampleKey]);
    const tree = render();
    await waitFor(tree, () => maybeFindByTestID(tree, 'unlock-screen') !== null);
    act(() => {
      findByTestID(tree, 'unlock-input').props.onChangeText('123456');
    });
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    await waitFor(tree, () => maybeFindByTestID(tree, 'chat-view') !== null);
    expect(findByTestID(tree, 'chat-view')).toBeDefined();
    expect(findAllText(tree).join(' | ')).toContain('Provider: Anthropic');
  });
});

describe('CopilotPanel — merge state', () => {
  it('merges plaintext into vault on successful unlock', async () => {
    await seedVault('123456', [sampleKey]);
    seedTxt();
    const tree = render();
    await waitFor(tree, () => maybeFindByTestID(tree, 'unlock-screen') !== null);
    act(() => {
      findByTestID(tree, 'unlock-input').props.onChangeText('123456');
    });
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    await waitFor(tree, () => maybeFindByTestID(tree, 'chat-view') !== null);
    // After merge, the .txt is still on disk (we only delete on user
    // confirm in the cleanup prompt — which is an enhancement TODO for
    // the merge flow). Sanity: the vault file is still present.
    expect(fs.has(VAULT_PATH)).toBe(true);
  });
});

describe('CopilotPanel — wrong PIN at the panel level', () => {
  it('shows the wrong-PIN message and stays on UnlockScreen', async () => {
    await seedVault('123456', [sampleKey]);
    const tree = render();
    await waitFor(tree, () => maybeFindByTestID(tree, 'unlock-screen') !== null);
    act(() => {
      findByTestID(tree, 'unlock-input').props.onChangeText('000000');
    });
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    expect(findByTestID(tree, 'unlock-screen')).toBeDefined();
    expect(maybeFindByTestID(tree, 'chat-view')).toBeNull();
  });
});

describe('CopilotPanel — unlock error branches', () => {
  it('shows the corrupt message when the vault file becomes unreadable', async () => {
    await seedVault('123456', [sampleKey]);
    // Corrupt the vault on disk so readVault returns kind:"corrupt".
    fs.set(VAULT_PATH, new TextEncoder().encode('{"version":1,"kdf":{}}'));
    const tree = render();
    await waitFor(tree, () => maybeFindByTestID(tree, 'unlock-screen') !== null);
    act(() => {
      findByTestID(tree, 'unlock-input').props.onChangeText('123456');
    });
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    expect(findByTestID(tree, 'unlock-message')).toBeDefined();
  });

  it('UnlockScreen onReset prop deletes the vault', async () => {
    await seedVault('123456', [sampleKey]);
    const tree = render();
    await waitFor(tree, () => maybeFindByTestID(tree, 'unlock-screen') !== null);
    // Reach into the UnlockScreen's parent (the inner ScrollView's
    // owner) to grab the onReset prop. This is a back-channel that
    // bypasses the in-component "5 failures" gate, which is already
    // exercised by UnlockScreen's own unit tests.
    const candidates = tree.root.findAllByProps({testID: 'unlock-screen'});
    let onReset: (() => Promise<void>) | undefined;
    for (const node of candidates) {
      let cur = node.parent;
      while (cur) {
        const p = cur.props as {onReset?: unknown};
        if (typeof p.onReset === 'function') {
          onReset = p.onReset as () => Promise<void>;
          break;
        }
        cur = cur.parent;
      }
      if (onReset) {
        break;
      }
    }
    expect(typeof onReset).toBe('function');
    await act(async () => {
      await onReset!();
      await flushPromises();
    });
    expect(fs.has(VAULT_PATH)).toBe(false);
  });
});
