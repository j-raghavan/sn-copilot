/**
 * Tests for the Grill Me entry point in ChatView. Pins:
 *   - When onStartDrill is provided, a "Grill Me" suggestion card
 *     appears in the empty-state grid.
 *   - When onStartDrill is undefined, no Grill card is rendered.
 *   - Tapping Grill fires onStartDrill, NOT sendUserMessage — i.e.
 *     it doesn't add a user bubble or thinking placeholder to chat.
 *   - Without a key file, tapping Grill is a no-op (same gating as
 *     other actions).
 */
jest.mock('../src/ui/useProviderClient', () => ({
  useProviderClient: (keyFile: {key?: string; model?: string} | undefined) => {
    const fakeProvider =
      jest.requireActual('../src/providers/fakeProvider').default;
    return {
      client: fakeProvider,
      apiKey: keyFile?.key ?? 'fake',
      model: keyFile?.model ?? 'fake-model-1',
    };
  },
}));

jest.useFakeTimers();

import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import ChatView from '../src/ui/ChatView';
import {__testing__ as guardTesting} from '../src/reentrancy/inFlightGuard';
import type {KeyFile} from '../src/types';
import {
  findByTestID,
  maybeFindByTestID,
} from './helpers/textTraversal';

const KEYFILE: KeyFile = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  key: 'sk-ant-test',
  sourcePath: '/sd/copilot-key-anthropic.txt',
};

beforeEach(() => {
  guardTesting.reset();
});

const render = (
  overrides: Partial<React.ComponentProps<typeof ChatView>> = {},
): {tree: ReactTestRenderer; onStartDrill: jest.Mock} => {
  const onStartDrill = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ChatView
        scopeLabel="Current Page"
        provider="Claude"
        keyFile={KEYFILE}
        onSettingsTap={jest.fn()}
        onClose={jest.fn()}
        onStartDrill={onStartDrill}
        {...overrides}
      />,
    );
  });
  return {tree, onStartDrill};
};

describe('ChatView — Grill Me entry', () => {
  it('renders the Grill Me suggestion card when onStartDrill is supplied', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'chat-suggestion-grill')).toBeDefined();
  });

  it('does NOT render the Grill card when onStartDrill is omitted (PDF/EPUB gate)', () => {
    const {tree} = render({onStartDrill: undefined});
    expect(maybeFindByTestID(tree, 'chat-suggestion-grill')).toBeNull();
  });

  it('tapping Grill fires onStartDrill and does NOT add a chat bubble', () => {
    const {tree, onStartDrill} = render();
    act(() => {
      findByTestID(tree, 'chat-suggestion-grill').props.onPress();
    });
    expect(onStartDrill).toHaveBeenCalledTimes(1);
    // Cards still visible (no user message was added, so empty-state
    // is unchanged).
    expect(maybeFindByTestID(tree, 'chat-suggestions')).not.toBeNull();
  });

  it('tapping Grill without a key file is a no-op (same gate as other actions)', () => {
    const {tree, onStartDrill} = render({keyFile: undefined});
    // Without a key file, the empty-state shows the setup checklist
    // instead of suggestion cards. The Grill button isn't reachable.
    expect(maybeFindByTestID(tree, 'chat-suggestion-grill')).toBeNull();
    expect(onStartDrill).not.toHaveBeenCalled();
  });
});
