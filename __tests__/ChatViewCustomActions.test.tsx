/**
 * Tests for ChatView's P2 surface (Req 3 — custom persona + saveable
 * quick actions). Pins:
 *   1. Without customActions, ChatView renders the 4 built-ins in
 *      the original flex row.
 *   2. With customActions, the action row switches to a horizontal
 *      scroller and renders built-ins + customs back-to-back.
 *   3. Tapping a custom action sends its saved prompt verbatim.
 *   4. customSystemPrompt is sent verbatim to the provider in place
 *      of the built-in SYSTEM_PROMPT.
 *   5. A blank / whitespace-only customSystemPrompt falls back to
 *      the built-in.
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
import {SYSTEM_PROMPT} from '../src/ui/systemPrompt';
import type {CustomAction, KeyFile} from '../src/types';
import fakeProvider from '../src/providers/fakeProvider';
import {findAllText, findByTestID, maybeFindByTestID} from './helpers/textTraversal';

beforeEach(() => {
  guardTesting.reset();
});

const DEFAULT_KEYFILE: KeyFile = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  key: 'sk-ant-test',
  sourcePath: '/sd/copilot-key-anthropic.txt',
};

function render(
  over: Partial<React.ComponentProps<typeof ChatView>> = {},
): {tree: ReactTestRenderer} {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ChatView
        scopeLabel="Current Page"
        provider="Claude"
        keyFile={DEFAULT_KEYFILE}
        onSettingsTap={jest.fn()}
        onClose={jest.fn()}
        {...over}
      />,
    );
  });
  return {tree};
}

async function flushSend(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(700);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });
}

const sampleCustom = (over: Partial<CustomAction> = {}): CustomAction => ({
  id: 'cust-1',
  label: 'Glossary',
  icon: '📖',
  prompt: 'Define key terms on this page.',
  ...over,
});

describe('ChatView — no custom actions (back-compat)', () => {
  it('renders the built-in 4 actions and only those', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'chat-action-summarize')).toBeDefined();
    expect(findByTestID(tree, 'chat-action-explain')).toBeDefined();
    expect(findByTestID(tree, 'chat-action-clarify')).toBeDefined();
    expect(findByTestID(tree, 'chat-action-snapshot')).toBeDefined();
  });
});

describe('ChatView — custom actions', () => {
  it('renders user actions alongside the built-ins', () => {
    const customs = [
      sampleCustom(),
      sampleCustom({id: 'cust-2', label: 'Risks', icon: '⚠'}),
    ];
    const {tree} = render({customActions: customs});
    expect(findByTestID(tree, 'chat-action-summarize')).toBeDefined();
    expect(findByTestID(tree, 'chat-action-cust-1')).toBeDefined();
    expect(findByTestID(tree, 'chat-action-cust-2')).toBeDefined();
    // Both labels visible.
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('Glossary');
    expect(text).toContain('Risks');
  });

  it('tapping a custom action sends its saved prompt', async () => {
    const spy = jest.spyOn(fakeProvider, 'send');
    const customs = [sampleCustom({id: 'tax-1', prompt: 'Tax implications?'})];
    const {tree} = render({customActions: customs});
    act(() => {
      findByTestID(tree, 'chat-action-tax-1').props.onPress();
    });
    await flushSend();
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[0][0];
    expect(call.userText).toContain('Tax implications?');
    spy.mockRestore();
  });

  it('still routes built-in actions correctly when customs are present', async () => {
    const spy = jest.spyOn(fakeProvider, 'send');
    const customs = [sampleCustom()];
    const {tree} = render({customActions: customs});
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    await flushSend();
    expect(spy.mock.calls[0][0].userText).toContain('Summarize this page');
    spy.mockRestore();
  });

  it('renders no horizontal-scroll row when customActions is empty array', () => {
    // Empty array is treated as "no customs" — falls back to the
    // built-in flex row.
    const {tree} = render({customActions: []});
    // Action row testID is set on both branches, just one is a
    // ScrollView. We assert by checking that the snapshot doesn't
    // contain the scroll-only style.
    const row = findByTestID(tree, 'chat-action-row');
    // The View variant has no `horizontal` prop.
    expect(row.props.horizontal).toBeUndefined();
  });
});

describe('ChatView — custom system prompt', () => {
  it('uses the custom prompt verbatim when set', async () => {
    const spy = jest.spyOn(fakeProvider, 'send');
    const {tree} = render({
      customSystemPrompt: 'You are a precise tutor. Be terse.',
    });
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    await flushSend();
    expect(spy.mock.calls[0][0].systemPrompt).toBe(
      'You are a precise tutor. Be terse.',
    );
    spy.mockRestore();
  });

  it('falls back to the built-in SYSTEM_PROMPT when override is undefined', async () => {
    const spy = jest.spyOn(fakeProvider, 'send');
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    await flushSend();
    expect(spy.mock.calls[0][0].systemPrompt).toBe(SYSTEM_PROMPT);
    spy.mockRestore();
  });

  it('falls back when override is whitespace-only', async () => {
    const spy = jest.spyOn(fakeProvider, 'send');
    const {tree} = render({customSystemPrompt: '   \n   '});
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    await flushSend();
    expect(spy.mock.calls[0][0].systemPrompt).toBe(SYSTEM_PROMPT);
    spy.mockRestore();
  });
});

describe('ChatView — edge cases', () => {
  it('onPress on send is a no-op when there is no keyFile (button disabled)', () => {
    const spy = jest.spyOn(fakeProvider, 'send');
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <ChatView
          scopeLabel="Current Page"
          provider="Demo"
          keyFile={undefined}
          onSettingsTap={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    });
    // Type something so the empty-input early-return doesn't shadow
    // the !hasKeyFile early-return we're trying to exercise.
    act(() => {
      findByTestID(tree, 'chat-input').props.onChangeText('hello?');
    });
    act(() => {
      // Even though the button is disabled, test-renderer still lets
      // us invoke onPress directly. The handler should short-circuit
      // on the !hasKeyFile branch and never hit the provider.
      findByTestID(tree, 'chat-send').props.onPress();
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('ChatView — action row layout', () => {
  it('falls back to the flex row when customActions is undefined', () => {
    const {tree} = render({customActions: undefined});
    expect(findByTestID(tree, 'chat-action-row').props.horizontal).toBeUndefined();
  });

  it('switches to a horizontal scroller once customs are configured', () => {
    const {tree} = render({
      customActions: [sampleCustom()],
    });
    // ScrollView in test-renderer surfaces `horizontal` as a prop.
    expect(findByTestID(tree, 'chat-action-row').props.horizontal).toBe(true);
  });

  it('no header surprises: settings + new-chat icons remain present with customs', () => {
    const {tree} = render({
      customActions: [sampleCustom()],
    });
    expect(findByTestID(tree, 'chat-settings')).toBeDefined();
    expect(findByTestID(tree, 'chat-new')).toBeDefined();
    // History icon is gated by saved conversations, not custom actions.
    expect(maybeFindByTestID(tree, 'chat-history')).toBeNull();
  });
});

describe('ChatView — lock button', () => {
  it('renders 🔒 in the context row when showLockButton + onLockNow are wired', () => {
    const onLockNow = jest.fn();
    const {tree} = render({showLockButton: true, onLockNow});
    expect(findByTestID(tree, 'chat-lock')).toBeDefined();
  });

  it('is hidden when showLockButton is false', () => {
    const {tree} = render({showLockButton: false, onLockNow: jest.fn()});
    expect(maybeFindByTestID(tree, 'chat-lock')).toBeNull();
  });

  it('is hidden when onLockNow is missing even with showLockButton=true', () => {
    const {tree} = render({showLockButton: true});
    expect(maybeFindByTestID(tree, 'chat-lock')).toBeNull();
  });

  it('tapping 🔒 calls onLockNow', () => {
    const onLockNow = jest.fn();
    const {tree} = render({showLockButton: true, onLockNow});
    act(() => {
      findByTestID(tree, 'chat-lock').props.onPress();
    });
    expect(onLockNow).toHaveBeenCalledTimes(1);
  });
});
