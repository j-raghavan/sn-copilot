/**
 * Tests for src/storage/secureFlows. Pins:
 *   1. encryptInitial writes vault, flips prefs, populates sessionKey.
 *   2. unlock returns the vault contents and populates sessionKey on ok.
 *   3. mergeIntoVault: same provider replaces; new provider appends.
 *   4. changePin re-encrypts under the new PIN.
 *   5. disableEncryption writes back via callback then deletes vault.
 *   6. resetVault deletes + flips prefs to 'undecided' + clears session.
 *   7. lockNow wipes session.
 *   8. Each path returns {ok:false, reason} on underlying failure.
 *   9. isInsecure() classifies modes.
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

import {DEFAULT_PREFS} from '../src/types';
import {
  __testing__ as sessionTesting,
  getActiveKeys,
  setActiveKeys,
} from '../src/storage/sessionKey';
import {
  __testing__ as derivedKeyTesting,
  getDerivedKey,
  hasDerivedKey,
} from '../src/storage/derivedKey';
import {
  changePin,
  disableEncryption,
  encryptInitial,
  isInsecure,
  lockNow,
  mergeIntoVault,
  resetVault,
  unlock,
} from '../src/storage/secureFlows';
import {readVault, vaultExists} from '../src/storage/vault';
import {readPrefs, writePrefs} from '../src/storage/prefs';
import {createInMemoryFileIo} from './helpers/inMemoryFileIo';
import type {KeyFile} from '../src/types';

const VAULT_PATH = '/plugin/copilot-key.enc';
const PREFS_PATH = '/plugin/copilot-prefs.json';

const f = (provider: 'anthropic' | 'openai'): KeyFile => ({
  provider,
  model: provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini',
  key: 'sk-' + provider,
  sourcePath: '/x/' + provider + '.txt',
});

const makeDeps = () => {
  const io = createInMemoryFileIo();
  return {
    io,
    deps: {
      vault: {io, vaultPath: VAULT_PATH},
      prefs: {io, prefsPath: PREFS_PATH},
    },
  };
};

beforeEach(() => {
  sessionTesting.reset();
  derivedKeyTesting.reset();
});

describe('encryptInitial', () => {
  it('writes vault, flips prefs to encrypted, populates sessionKey', async () => {
    const {deps} = makeDeps();
    const r = await encryptInitial(deps, '123456', [f('anthropic')]);
    expect(r.ok).toBe(true);
    expect(await vaultExists(deps.vault)).toBe(true);
    const prefs = await readPrefs(deps.prefs);
    expect(prefs.encryptionMode).toBe('encrypted');
    expect(getActiveKeys()).toEqual([f('anthropic')]);
  });

  it('returns reason when no files supplied', async () => {
    const {deps} = makeDeps();
    const r = await encryptInitial(deps, '123456', []);
    expect(r.ok).toBe(false);
  });

  it('returns reason when vault write throws', async () => {
    const {io, deps} = makeDeps();
    io.writeBytes = async () => {
      throw new Error('disk full');
    };
    const r = await encryptInitial(deps, '123456', [f('openai')]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('disk full');
    }
  });
});

describe('unlock', () => {
  it('returns ok + populates sessionKey for the right PIN', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('anthropic')]);
    sessionTesting.reset();
    const r = await unlock(deps, '123456');
    expect(r.kind).toBe('ok');
    expect(getActiveKeys()).toEqual([f('anthropic')]);
  });

  it('returns wrong-pin without populating sessionKey', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('anthropic')]);
    sessionTesting.reset();
    const r = await unlock(deps, 'nope');
    expect(r.kind).toBe('wrong-pin');
    expect(getActiveKeys()).toBeNull();
  });

  it('returns not-found when no vault', async () => {
    const {deps} = makeDeps();
    const r = await unlock(deps, '123456');
    expect(r.kind).toBe('not-found');
  });
});

describe('mergeIntoVault', () => {
  it('same provider replaces, new provider appends', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('anthropic')]);
    const newAnth: KeyFile = {...f('anthropic'), key: 'sk-ant-new'};
    const r = await mergeIntoVault(deps, '123456', [f('anthropic')], [newAnth, f('openai')]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const providers = r.value.map((x) => x.provider).sort();
      expect(providers).toEqual(['anthropic', 'openai']);
      const a = r.value.find((x) => x.provider === 'anthropic');
      expect(a?.key).toBe('sk-ant-new');
    }
  });

  it('returns reason when nothing to merge', async () => {
    const {deps} = makeDeps();
    const r = await mergeIntoVault(deps, '123456', [], []);
    expect(r.ok).toBe(false);
  });

  it('returns reason when underlying write fails', async () => {
    const {io, deps} = makeDeps();
    io.writeBytes = async () => {
      throw new Error('boom');
    };
    const r = await mergeIntoVault(deps, '123456', [f('anthropic')], [f('openai')]);
    expect(r.ok).toBe(false);
  });
});

describe('changePin', () => {
  it('re-encrypts with the new PIN', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('openai')]);
    const r = await changePin(deps, '654321', [f('openai')]);
    expect(r.ok).toBe(true);
    expect((await readVault(deps.vault, '123456')).kind).toBe('wrong-pin');
    expect((await readVault(deps.vault, '654321')).kind).toBe('ok');
  });

  it('reports failure reason', async () => {
    const {io, deps} = makeDeps();
    io.writeBytes = async () => {
      throw new Error('nope');
    };
    const r = await changePin(deps, '654321', [f('openai')]);
    expect(r.ok).toBe(false);
  });
});

describe('disableEncryption', () => {
  it('calls writeBack, deletes vault, flips to plaintext, clears session', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('openai')]);
    const writeBack = jest.fn(async () => {});
    const r = await disableEncryption(deps, writeBack, [f('openai')]);
    expect(r.ok).toBe(true);
    expect(writeBack).toHaveBeenCalledWith([f('openai')]);
    expect(await vaultExists(deps.vault)).toBe(false);
    const prefs = await readPrefs(deps.prefs);
    expect(prefs.encryptionMode).toBe('plaintext');
    expect(getActiveKeys()).toBeNull();
  });

  it('returns reason if writeBack throws (and does NOT delete vault)', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('openai')]);
    const writeBack = jest.fn(async () => {
      throw new Error('FS write failed');
    });
    const r = await disableEncryption(deps, writeBack, [f('openai')]);
    expect(r.ok).toBe(false);
    expect(await vaultExists(deps.vault)).toBe(true);
  });
});

describe('resetVault', () => {
  it('deletes vault + flips prefs to undecided + clears session', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('openai')]);
    const r = await resetVault(deps);
    expect(r.ok).toBe(true);
    expect(await vaultExists(deps.vault)).toBe(false);
    expect((await readPrefs(deps.prefs)).encryptionMode).toBe('undecided');
    expect(getActiveKeys()).toBeNull();
  });

  it('reports failure reason', async () => {
    const {io, deps} = makeDeps();
    io.remove = async () => {
      throw new Error('cannot delete');
    };
    const r = await resetVault(deps);
    expect(r.ok).toBe(false);
  });
});

describe('lockNow / isInsecure', () => {
  it('lockNow wipes session and derived key', () => {
    setActiveKeys([f('anthropic')]);
    lockNow();
    expect(getActiveKeys()).toBeNull();
    expect(hasDerivedKey()).toBe(false);
  });

  it.each(['plaintext' as const, 'undecided' as const])(
    'isInsecure(%s) === true',
    (mode) => {
      expect(isInsecure(mode)).toBe(true);
    },
  );

  it('isInsecure(encrypted) === false', () => {
    expect(isInsecure('encrypted')).toBe(false);
  });

  it('writePrefs round-trips with DEFAULT_PREFS shape', async () => {
    const {deps} = makeDeps();
    await writePrefs(deps.prefs, {...DEFAULT_PREFS, encryptionMode: 'encrypted'});
    expect((await readPrefs(deps.prefs)).encryptionMode).toBe('encrypted');
  });
});

describe('secureFlows — derivedKey integration', () => {
  it('encryptInitial populates the derived key', async () => {
    const {deps} = makeDeps();
    expect(hasDerivedKey()).toBe(false);
    await encryptInitial(deps, '123456', [f('anthropic')]);
    expect(hasDerivedKey()).toBe(true);
    expect(getDerivedKey()!.length).toBe(32);
  });

  it('unlock populates the derived key on ok', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('anthropic')]);
    sessionTesting.reset();
    derivedKeyTesting.reset();
    const r = await unlock(deps, '123456');
    expect(r.kind).toBe('ok');
    expect(hasDerivedKey()).toBe(true);
  });

  it('unlock does not set the derived key on wrong-pin', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('anthropic')]);
    sessionTesting.reset();
    derivedKeyTesting.reset();
    const r = await unlock(deps, 'nope');
    expect(r.kind).toBe('wrong-pin');
    expect(hasDerivedKey()).toBe(false);
  });

  it('unlock strips key from the returned shape', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('anthropic')]);
    sessionTesting.reset();
    derivedKeyTesting.reset();
    const r = await unlock(deps, '123456');
    // ok shape is {kind:'ok', files} — no `key` leaked to the UI.
    expect(r).not.toHaveProperty('key');
  });

  it('changePin refreshes the derived key', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('openai')]);
    const before = getDerivedKey();
    await changePin(deps, '654321', [f('openai')]);
    const after = getDerivedKey();
    expect(after).not.toBeNull();
    expect(Buffer.from(after!).equals(Buffer.from(before!))).toBe(false);
  });

  it('mergeIntoVault refreshes the derived key', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('anthropic')]);
    const before = getDerivedKey();
    await mergeIntoVault(deps, '123456', [f('anthropic')], [f('openai')]);
    const after = getDerivedKey();
    expect(after).not.toBeNull();
    expect(Buffer.from(after!).equals(Buffer.from(before!))).toBe(false);
  });

  it('disableEncryption clears the derived key', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('openai')]);
    expect(hasDerivedKey()).toBe(true);
    await disableEncryption(deps, async () => {}, [f('openai')]);
    expect(hasDerivedKey()).toBe(false);
  });

  it('resetVault clears the derived key', async () => {
    const {deps} = makeDeps();
    await encryptInitial(deps, '123456', [f('openai')]);
    expect(hasDerivedKey()).toBe(true);
    await resetVault(deps);
    expect(hasDerivedKey()).toBe(false);
  });
});
