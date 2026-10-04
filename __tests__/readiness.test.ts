/**
 * Tests for src/pilotchat/readiness — whether PilotChat can answer as it
 * opens, and what to tell the user when it cannot.
 */
import {
  NEEDS_KEY,
  NEEDS_KEY_SETUP,
  NEEDS_UNLOCK,
  NEEDS_VISION,
  unavailableReason,
} from '../src/pilotchat/readiness';
import type {KeyFile} from '../src/types';

const KEY = {provider: 'anthropic', model: 'claude-sonnet-5'} as KeyFile;

describe('unavailableReason', () => {
  it('waits while the keys are still loading', () => {
    expect(unavailableReason(null, undefined)).toBeNull();
  });

  it('is ready with a key that can read images', () => {
    expect(
      unavailableReason({kind: 'plaintext', files: [KEY]}, KEY),
    ).toBeNull();
  });

  it('asks for a key when there is none', () => {
    expect(unavailableReason({kind: 'no-key'}, undefined)).toBe(NEEDS_KEY);
  });

  it('asks to unlock locked keys', () => {
    expect(unavailableReason({kind: 'locked'}, undefined)).toBe(NEEDS_UNLOCK);
  });

  it('asks to finish setting up new key files', () => {
    expect(
      unavailableReason(
        {kind: 'merge', vaultExists: true, plaintextFiles: [KEY]},
        undefined,
      ),
    ).toBe(NEEDS_KEY_SETUP);
  });

  it('asks for a provider that can see when the key cannot', () => {
    const deepseek = {...KEY, provider: 'deepseek'} as KeyFile;
    expect(
      unavailableReason({kind: 'plaintext', files: [deepseek]}, deepseek),
    ).toBe(NEEDS_VISION);
  });
});
