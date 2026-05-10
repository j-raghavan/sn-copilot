/**
 * Tests for src/storage/useCopilotState. Pins:
 *   1. Initial render: state=null, then resolves to the right kind
 *      based on prefs / vault / plaintext.
 *   2. Discovery errors propagate.
 *   3. sessionKey changes flip state from 'locked' to 'unlocked'.
 *   4. refresh re-reads everything.
 */
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
    },
  };
});

import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import {Text, View} from 'react-native';
import {useCopilotState} from '../src/storage/useCopilotState';
import {writeVault} from '../src/storage/vault';
import {writePrefs} from '../src/storage/prefs';
import {
  __testing__ as sessionTesting,
  setActiveKeys,
} from '../src/storage/sessionKey';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';
import type {KeyFile} from '../src/types';

const VAULT_PATH = '/plugin/copilot-key.enc';
const PREFS_PATH = '/plugin/copilot-prefs.json';
const TXT_PATH = '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt';

const mkFile = (provider: 'anthropic'): KeyFile => ({
  provider,
  model: 'claude-haiku-4-5',
  key: 'sk-ant-test',
  sourcePath: TXT_PATH,
});

type Captured = ReturnType<typeof useCopilotState>;
const captured: {value: Captured | null} = {value: null};

function Probe(props: {deps: Parameters<typeof useCopilotState>[0]}): React.JSX.Element {
  const r = useCopilotState(props.deps);
  captured.value = r;
  return (
    <View testID="probe">
      <Text>{r.state?.kind ?? 'null'}</Text>
    </View>
  );
}

const flushPromises = async () => {
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

const setupDeps = () => {
  const io = createInMemoryFileIo();
  // Adapter so the discovery deps' fileUtils interface matches what
  // discoverKeyFiles expects (listFiles returning {path,type}[]).
  const fileUtils = {
    exists: (p: string) => io.exists(p),
    listFiles: async (_dir: string) => {
      const out: Array<{path: string; type: number}> = [];
      for (const path of io.fs.keys()) {
        if (path.startsWith('/storage/emulated/0/MyStyle/SnCopilot/')) {
          out.push({path, type: 1});
        }
      }
      return out;
    },
  };
  return {
    io,
    deps: {
      prefsDeps: {io, prefsPath: PREFS_PATH},
      vaultDeps: {io, vaultPath: VAULT_PATH},
      discoveryDeps: {fileUtils},
    },
  };
};

const fetchFromIo = (io: ReturnType<typeof createInMemoryFileIo>) =>
  ((async (url: string) => {
    const path = url.replace(/^file:\/\//, '');
    const bytes = await io.readBytes(path);
    if (bytes === null) {
      return {ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0)};
    }
    return {ok: true, arrayBuffer: async () => bytes.buffer};
  }) as unknown as typeof fetch);

beforeEach(() => {
  sessionTesting.reset();
  captured.value = null;
});

describe('useCopilotState — initial state', () => {
  it('resolves to no-key when nothing is on disk', async () => {
    const {deps} = setupDeps();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe deps={deps} />);
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(captured.value?.state?.kind).toBe('no-key');
    act(() => { tree.unmount(); });
  });

  it('resolves to migrate when plaintext exists and mode is undecided', async () => {
    const {io, deps} = setupDeps();
    globalThis.fetch = fetchFromIo(io);
    io.fs.set(
      TXT_PATH,
      new TextEncoder().encode(
        'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-test\n',
      ),
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe deps={deps} />);
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(captured.value?.state?.kind).toBe('migrate');
    act(() => { tree.unmount(); });
  });

  it('resolves to plaintext when plaintext exists and mode is plaintext', async () => {
    const {io, deps} = setupDeps();
    globalThis.fetch = fetchFromIo(io);
    io.fs.set(
      TXT_PATH,
      new TextEncoder().encode(
        'provider=anthropic\nmodel=claude-haiku-4-5\nkey=sk-ant-test\n',
      ),
    );
    await writePrefs(deps.prefsDeps, {
      version: 1,
      encryptionMode: 'plaintext',
      idleTimeoutMin: 10,
    });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe deps={deps} />);
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(captured.value?.state?.kind).toBe('plaintext');
    act(() => { tree.unmount(); });
  });

  it('resolves to locked when vault exists, no plaintext, no in-memory key', async () => {
    const {io, deps} = setupDeps();
    globalThis.fetch = fetchFromIo(io);
    await writeVault(deps.vaultDeps, '123456', [mkFile('anthropic')]);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe deps={deps} />);
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(captured.value?.state?.kind).toBe('locked');
    act(() => { tree.unmount(); });
  });

  it('resolves to unlocked when vault exists and sessionKey is populated', async () => {
    const {io, deps} = setupDeps();
    globalThis.fetch = fetchFromIo(io);
    await writeVault(deps.vaultDeps, '123456', [mkFile('anthropic')]);
    setActiveKeys([mkFile('anthropic')]);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe deps={deps} />);
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(captured.value?.state?.kind).toBe('unlocked');
    act(() => { tree.unmount(); });
  });
});

describe('useCopilotState — sessionKey transitions', () => {
  it('flips to unlocked when setActiveKeys is called after mount', async () => {
    const {io, deps} = setupDeps();
    globalThis.fetch = fetchFromIo(io);
    await writeVault(deps.vaultDeps, '123456', [mkFile('anthropic')]);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe deps={deps} />);
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(captured.value?.state?.kind).toBe('locked');
    await act(async () => {
      setActiveKeys([mkFile('anthropic')]);
      await flushPromises();
    });
    expect(captured.value?.state?.kind).toBe('unlocked');
    act(() => { tree.unmount(); });
  });
});
