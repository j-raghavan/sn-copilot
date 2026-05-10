/**
 * Tests for src/storage/vaultPath. Pins:
 *   1. Probe success → vault + prefs live alongside plugin install dir.
 *   2. Probe returns null/undefined/empty → fall back to MyStyle hidden file.
 *   3. Probe throws → fall back.
 *   4. Trailing slash on probe result is normalized.
 */
import {
  PREFS_FILENAME,
  VAULT_FILENAME,
  resolveVaultPaths,
} from '../src/storage/vaultPath';
import {DEFAULT_KEY_ROOT} from '../src/storage/keyFiles';

describe('resolveVaultPaths — host returns a path', () => {
  it('places vault + prefs inside the host-supplied dir', async () => {
    const r = await resolveVaultPaths(async () => '/data/data/host/plugins/abc');
    expect(r.baseDir).toBe('/data/data/host/plugins/abc');
    expect(r.vaultPath).toBe(`/data/data/host/plugins/abc/${VAULT_FILENAME}`);
    expect(r.prefsPath).toBe(`/data/data/host/plugins/abc/${PREFS_FILENAME}`);
  });

  it('strips a single trailing slash', async () => {
    const r = await resolveVaultPaths(async () => '/data/plugins/abc/');
    expect(r.vaultPath).toBe(`/data/plugins/abc/${VAULT_FILENAME}`);
  });
});

describe('resolveVaultPaths — host returns nothing', () => {
  it.each([null, undefined, ''])(
    'falls back when probe returns %p',
    async (raw) => {
      const r = await resolveVaultPaths(async () => raw as string);
      expect(r.baseDir).toBeNull();
      expect(r.vaultPath).toBe(`${DEFAULT_KEY_ROOT}/.copilot-key.enc`);
      expect(r.prefsPath).toBe(`${DEFAULT_KEY_ROOT}/.copilot-prefs.json`);
    },
  );

  it('falls back when probe throws', async () => {
    const r = await resolveVaultPaths(async () => {
      throw new Error('host has no getPluginDirPath');
    });
    expect(r.baseDir).toBeNull();
    expect(r.vaultPath).toBe(`${DEFAULT_KEY_ROOT}/.copilot-key.enc`);
  });

  it('falls back when probe returns a non-string', async () => {
    // @ts-expect-error — testing runtime guard against a misbehaving host
    const r = await resolveVaultPaths(async () => 42);
    expect(r.baseDir).toBeNull();
  });
});
