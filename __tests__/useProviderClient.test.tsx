/**
 * Tests for useProviderClient — selects between the real provider
 * client (when a KeyFile is present) and the fakeProvider fallback.
 */
import React from 'react';
import {Text} from 'react-native';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import {useProviderClient} from '../src/ui/useProviderClient';
import type {KeyFile} from '../src/types';

// Probe component: renders the resolved {client.id, apiKey, model}
// as JSON so the test can read it via tree.toJSON().
function Probe({keyFile}: {keyFile: KeyFile | undefined}) {
  const r = useProviderClient(keyFile);
  return <Text>{`${r.client.id}|${r.apiKey}|${r.model}`}</Text>;
}

const render = (
  keyFile: KeyFile | undefined,
): {tree: ReactTestRenderer; readout: () => string} => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<Probe keyFile={keyFile} />);
  });
  const readout = (): string => {
    const json = tree.toJSON() as {children: string[]} | null;
    return json?.children?.[0] ?? '';
  };
  return {tree, readout};
};

describe('useProviderClient', () => {
  it('falls back to fakeProvider when keyFile is undefined', () => {
    const {readout} = render(undefined);
    expect(readout()).toBe('anthropic|fake|fake-model-1');
  });

  it('returns the real provider when keyFile is present', () => {
    const keyFile: KeyFile = {
      provider: 'openai',
      key: 'sk-real',
      model: 'gpt-4o-mini',
      mode: 'text',
      sourcePath: '/sd/key.txt',
    };
    const {readout} = render(keyFile);
    expect(readout()).toBe('openai|sk-real|gpt-4o-mini');
  });

  it.each(['anthropic', 'gemini', 'deepseek'] as const)(
    'wires provider id %s through to client.id',
    provider => {
      const keyFile: KeyFile = {
        provider,
        key: 'k',
        model: 'm',
        mode: 'text',
        sourcePath: '/sd/x.txt',
      };
      const {readout} = render(keyFile);
      expect(readout()).toBe(`${provider}|k|m`);
    },
  );
});
