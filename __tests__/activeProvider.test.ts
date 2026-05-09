/**
 * Tests for src/storage/activeProvider — pure resolution logic.
 *
 * Pins all resolution paths:
 *   1. Zero key files → 'none' with setup message.
 *   2. Exactly one key file → that provider; default_provider ignored.
 *   3. Multiple files, no default_provider declared → 'none'.
 *   4. Multiple files, conflicting default_provider → 'ambiguous'.
 *   5. Multiple files, single default_provider → that provider.
 *   6. Multiple files, default_provider names absent provider → 'none'.
 */
import {resolveActiveProvider} from '../src/storage/activeProvider';
import type {KeyFile} from '../src/types';

const makeFile = (overrides: Partial<KeyFile> = {}): KeyFile => ({
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  key: 'sk-ant-test',
  sourcePath: '/storage/emulated/0/MyStyle/SnCopilot/copilot-key-anthropic.txt',
  ...overrides,
});

describe('resolveActiveProvider', () => {
  it('returns "none" with setup message when no files', () => {
    const r = resolveActiveProvider([]);
    expect(r.kind).toBe('none');
    if (r.kind === 'none') {
      expect(r.message).toContain('No key file');
      expect(r.message).toContain('MyStyle/SnCopilot');
    }
  });

  it('returns that provider when exactly one file (default_provider ignored)', () => {
    const file = makeFile({defaultProvider: 'gemini'});
    const r = resolveActiveProvider([file]);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.active).toBe(file);
      expect(r.others).toEqual([]);
    }
  });

  it('returns "none" when multiple files but none declares default_provider', () => {
    const a = makeFile({provider: 'anthropic'});
    const b = makeFile({
      provider: 'openai',
      sourcePath: '/storage/.../copilot-key-openai.txt',
    });
    const r = resolveActiveProvider([a, b]);
    expect(r.kind).toBe('none');
    if (r.kind === 'none') {
      expect(r.message).toContain('default_provider');
    }
  });

  it('returns "ambiguous" when multiple files declare different defaults', () => {
    const a = makeFile({provider: 'anthropic', defaultProvider: 'anthropic'});
    const b = makeFile({
      provider: 'openai',
      defaultProvider: 'openai',
      sourcePath: '/storage/.../copilot-key-openai.txt',
    });
    const r = resolveActiveProvider([a, b]);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates).toHaveLength(2);
      expect(r.message).toContain('conflicting');
    }
  });

  it('picks the named default when multiple files agree', () => {
    const a = makeFile({provider: 'anthropic', defaultProvider: 'gemini'});
    const b = makeFile({
      provider: 'gemini',
      defaultProvider: 'gemini',
      sourcePath: '/storage/.../copilot-key-gemini.txt',
    });
    const r = resolveActiveProvider([a, b]);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.active.provider).toBe('gemini');
      expect(r.others.map(f => f.provider)).toEqual(['anthropic']);
    }
  });

  it('returns "none" when default_provider names a missing provider', () => {
    const a = makeFile({provider: 'anthropic', defaultProvider: 'gemini'});
    const b = makeFile({
      provider: 'openai',
      sourcePath: '/storage/.../copilot-key-openai.txt',
    });
    const r = resolveActiveProvider([a, b]);
    expect(r.kind).toBe('none');
    if (r.kind === 'none') {
      expect(r.message).toContain('gemini');
    }
  });

  it('a single declared default agreed by multiple files (redundant) is honoured', () => {
    const a = makeFile({provider: 'anthropic', defaultProvider: 'openai'});
    const b = makeFile({
      provider: 'openai',
      defaultProvider: 'openai',
      sourcePath: '/storage/.../copilot-key-openai.txt',
    });
    const r = resolveActiveProvider([a, b]);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.active.provider).toBe('openai');
    }
  });
});
