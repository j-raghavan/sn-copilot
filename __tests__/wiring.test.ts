/**
 * Tests for src/storage/wiring. Pins:
 *   1. buildWiringBundle resolves vault, prefs, and conversations
 *      paths under the host-provided plugin dir.
 *   2. The conversationsDeps closures pull live values: encryptionMode
 *      from prefs and derivedKey from the holder.
 *   3. The fallback path (no host dir) still produces a complete
 *      bundle with the hidden-file paths.
 */

// Stub the host-side libs that wiring imports. We don't exercise the
// real native bridges here — wiring's job is purely to glue them
// together with the right options, and we verify that gluing.
const mockGetPluginDirPath = jest.fn();
const mockFsExists = jest.fn(async () => false);
const mockFsDelete = jest.fn(async () => true);
const mockFsRename = jest.fn(async () => true);

jest.mock('sn-plugin-lib', () => ({
  FileUtils: {
    exists: (p: string) => mockFsExists(p),
    deleteFile: (p: string) => mockFsDelete(p),
    renameToFile: (s: string, d: string) => mockFsRename(s, d),
    listFiles: jest.fn(async () => ({success: true, result: []})),
    readFile: jest.fn(async () => ({success: true, result: ''})),
    readFileToString: jest.fn(async () => ({success: true, result: ''})),
  },
  PluginManager: {
    getPluginDirPath: () => mockGetPluginDirPath(),
  },
}));

jest.mock('../src/native/CopilotOverlay', () => ({
  __esModule: true,
  default: {
    writeFileBase64: jest.fn(async () => ({success: true, code: 'OK', message: 'mock'})),
    cryptoPbkdf2Sha256: jest.fn(),
    cryptoRandomBytes: jest.fn(),
  },
}));

import {buildWiringBundle} from '../src/storage/wiring';
import {
  __testing__ as derivedKeyTesting,
  setDerivedKey,
} from '../src/storage/derivedKey';
import {
  CONVERSATIONS_FILENAME,
  PREFS_FILENAME,
  VAULT_FILENAME,
} from '../src/storage/vaultPath';

beforeEach(() => {
  mockGetPluginDirPath.mockReset();
  mockFsExists.mockReset().mockResolvedValue(false);
  derivedKeyTesting.reset();
});

describe('buildWiringBundle — host-supplied dir', () => {
  it('places vault, prefs, and conversations under the host dir', async () => {
    mockGetPluginDirPath.mockResolvedValueOnce('/host/plugin/copilot');
    const bundle = await buildWiringBundle();
    expect(bundle.vaultDeps.vaultPath).toBe(
      `/host/plugin/copilot/${VAULT_FILENAME}`,
    );
    expect(bundle.prefsDeps.prefsPath).toBe(
      `/host/plugin/copilot/${PREFS_FILENAME}`,
    );
    expect(bundle.conversationsDeps.conversationsPath).toBe(
      `/host/plugin/copilot/${CONVERSATIONS_FILENAME}`,
    );
  });

  it('conversationsDeps.encryptionMode invokes prefs read', async () => {
    mockGetPluginDirPath.mockResolvedValueOnce('/host/plugin/copilot');
    const bundle = await buildWiringBundle();
    // No prefs file → falls through to DEFAULT_PREFS, mode is
    // 'undecided'. The point of this test is just to invoke the
    // closure body so the import + readPrefs chain is exercised.
    const m = await bundle.conversationsDeps.encryptionMode();
    expect(m).toBe('undecided');
  });

  it('conversationsDeps.derivedKey reads from the live holder', async () => {
    mockGetPluginDirPath.mockResolvedValueOnce('/host/plugin/copilot');
    const bundle = await buildWiringBundle();
    expect(bundle.conversationsDeps.derivedKey()).toBeNull();
    const k = new Uint8Array(32).fill(9);
    setDerivedKey(k);
    expect(bundle.conversationsDeps.derivedKey()).toBe(k);
  });
});

describe('buildWiringBundle — fallback path', () => {
  it('falls back to the hidden MyStyle file when the host returns nothing', async () => {
    mockGetPluginDirPath.mockResolvedValueOnce(null);
    const bundle = await buildWiringBundle();
    expect(bundle.conversationsDeps.conversationsPath).toMatch(
      /\.copilot-conversations\.json$/,
    );
  });
});
