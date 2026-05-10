/**
 * Tests for src/storage/appState. Pure-function table.
 */
import {computeAppState} from '../src/storage/appState';
import type {KeyFile} from '../src/types';

const f = (id: string): KeyFile => ({
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  key: 'sk-ant-' + id,
  sourcePath: `/x/${id}.txt`,
});

describe('computeAppState — vault present', () => {
  it('unlocked with no plaintext → unlocked', () => {
    expect(
      computeAppState({
        vaultExists: true,
        plaintextFiles: [],
        encryptionMode: 'encrypted',
        unlockedFiles: [f('a')],
      }),
    ).toEqual({kind: 'unlocked', files: [f('a')]});
  });

  it('unlocked with plaintext → merge (rotation)', () => {
    expect(
      computeAppState({
        vaultExists: true,
        plaintextFiles: [f('b')],
        encryptionMode: 'encrypted',
        unlockedFiles: [f('a')],
      }),
    ).toEqual({
      kind: 'merge',
      vaultExists: true,
      plaintextFiles: [f('b')],
    });
  });

  it('locked, plaintext present → merge', () => {
    expect(
      computeAppState({
        vaultExists: true,
        plaintextFiles: [f('b')],
        encryptionMode: 'encrypted',
        unlockedFiles: null,
      }),
    ).toEqual({
      kind: 'merge',
      vaultExists: true,
      plaintextFiles: [f('b')],
    });
  });

  it('locked, no plaintext → locked', () => {
    expect(
      computeAppState({
        vaultExists: true,
        plaintextFiles: [],
        encryptionMode: 'encrypted',
        unlockedFiles: null,
      }),
    ).toEqual({kind: 'locked'});
  });
});

describe('computeAppState — no vault', () => {
  it('no plaintext → no-key', () => {
    expect(
      computeAppState({
        vaultExists: false,
        plaintextFiles: [],
        encryptionMode: 'undecided',
        unlockedFiles: null,
      }),
    ).toEqual({kind: 'no-key'});
  });

  it('plaintext + undecided → migrate', () => {
    expect(
      computeAppState({
        vaultExists: false,
        plaintextFiles: [f('a')],
        encryptionMode: 'undecided',
        unlockedFiles: null,
      }),
    ).toEqual({kind: 'migrate', files: [f('a')]});
  });

  it('plaintext + plaintext mode → plaintext', () => {
    expect(
      computeAppState({
        vaultExists: false,
        plaintextFiles: [f('a')],
        encryptionMode: 'plaintext',
        unlockedFiles: null,
      }),
    ).toEqual({kind: 'plaintext', files: [f('a')]});
  });

  it('plaintext + encrypted mode (impossible state) collapses to plaintext', () => {
    expect(
      computeAppState({
        vaultExists: false,
        plaintextFiles: [f('a')],
        encryptionMode: 'encrypted',
        unlockedFiles: null,
      }),
    ).toEqual({kind: 'plaintext', files: [f('a')]});
  });
});
