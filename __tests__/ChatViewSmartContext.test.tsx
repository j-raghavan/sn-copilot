/**
 * Tests for ChatView's smart context routing (Req 4 + 5).
 *
 * The send path:
 *   - Quick actions (built-in OR custom) ALWAYS attach the page image
 *     + OCR text.
 *   - Freeform input attaches only when isPageReferential(text) is
 *     true; off-topic freeform questions skip the attachment so the
 *     model answers as a general assistant.
 *
 * Pins:
 *   1. Quick action with a page context attaches the screenshot +
 *      OCR text section in the composed user message.
 *   2. Page-referential freeform attaches the same.
 *   3. Off-topic freeform does NOT attach the image and does NOT
 *      append the "--- Page content (transcribed) ---" section.
 *   4. Off-topic freeform on a text-only provider still scrubs PII
 *      but the user text is just the raw question (no page section).
 *   5. Custom user actions behave like quick actions (always attach).
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
import {setPageContext, __testing__ as pageCtxTesting} from '../src/scope/pageContext';
import type {CustomAction, KeyFile} from '../src/types';
import fakeProvider from '../src/providers/fakeProvider';
import {findByTestID} from './helpers/textTraversal';

beforeEach(() => {
  guardTesting.reset();
  pageCtxTesting.reset();
});

afterEach(() => {
  pageCtxTesting.reset();
});

const ANTHROPIC_KEY: KeyFile = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  key: 'sk-ant-test',
  sourcePath: '/sd/copilot-key-anthropic.txt',
};
const DEEPSEEK_KEY: KeyFile = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  key: 'sk-ds-test',
  sourcePath: '/sd/copilot-key-deepseek.txt',
};

function render(
  over: Partial<React.ComponentProps<typeof ChatView>> = {},
): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ChatView
        scopeLabel="Current Page"
        provider="Claude"
        keyFile={ANTHROPIC_KEY}
        onSettingsTap={jest.fn()}
        onClose={jest.fn()}
        {...over}
      />,
    );
  });
  return tree;
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

const PAGE_TEXT = 'Mitochondria are the powerhouse of the cell.';
const PAGE_B64 = 'AAAAAAEBAAAAAAEAAAAAEQ==';

const seedPage = (): void => {
  setPageContext({
    notePath: '/notes/x',
    page: 1,
    screenshotPath: '/tmp/x.png',
    screenshotBase64: PAGE_B64,
    pageText: PAGE_TEXT,
  });
};

describe('ChatView smart routing — quick actions always attach', () => {
  it('Summarize → screenshot + page-text section in the composed user text', async () => {
    seedPage();
    const spy = jest.spyOn(fakeProvider, 'send');
    const tree = render();
    act(() => {
      findByTestID(tree, 'chat-suggestion-summarize').props.onPress();
    });
    await flushSend();
    const call = spy.mock.calls[0][0];
    expect(call.userText).toContain('Summarize this page');
    expect(call.userText).toContain('--- Page content (transcribed) ---');
    expect(call.userText).toContain(PAGE_TEXT);
    expect(call.imageBase64).toBe(PAGE_B64);
    spy.mockRestore();
  });

  it('custom action behaves like a built-in (always attaches)', async () => {
    seedPage();
    const spy = jest.spyOn(fakeProvider, 'send');
    const custom: CustomAction = {
      id: 'cust-1',
      label: 'Glossary',
      icon: '📖',
      prompt: 'Define terms.',
    };
    const tree = render({customActions: [custom]});
    act(() => {
      findByTestID(tree, 'chat-suggestion-cust-1').props.onPress();
    });
    await flushSend();
    const call = spy.mock.calls[0][0];
    expect(call.userText).toContain('Define terms.');
    expect(call.userText).toContain('--- Page content (transcribed) ---');
    expect(call.imageBase64).toBe(PAGE_B64);
    spy.mockRestore();
  });
});

describe('ChatView smart routing — freeform input', () => {
  it('page-referential freeform attaches page context', async () => {
    seedPage();
    const spy = jest.spyOn(fakeProvider, 'send');
    const tree = render();
    act(() => {
      findByTestID(tree, 'chat-input').props.onChangeText('Summarize this page');
    });
    act(() => {
      findByTestID(tree, 'chat-send').props.onPress();
    });
    await flushSend();
    const call = spy.mock.calls[0][0];
    expect(call.userText).toContain('--- Page content (transcribed) ---');
    expect(call.imageBase64).toBe(PAGE_B64);
    spy.mockRestore();
  });

  it('off-topic freeform does NOT attach page context or image', async () => {
    seedPage();
    const spy = jest.spyOn(fakeProvider, 'send');
    const tree = render();
    act(() => {
      findByTestID(tree, 'chat-input').props.onChangeText(
        "What's the capital of France?",
      );
    });
    act(() => {
      findByTestID(tree, 'chat-send').props.onPress();
    });
    await flushSend();
    const call = spy.mock.calls[0][0];
    expect(call.userText).not.toContain('--- Page content (transcribed) ---');
    expect(call.userText).not.toContain(PAGE_TEXT);
    expect(call.imageBase64).toBeUndefined();
    spy.mockRestore();
  });

  it('off-topic freeform on a text-only provider sends just the prompt', async () => {
    seedPage();
    const spy = jest.spyOn(fakeProvider, 'send');
    const tree = render({keyFile: DEEPSEEK_KEY, provider: 'DeepSeek'});
    act(() => {
      findByTestID(tree, 'chat-input').props.onChangeText(
        'how does quicksort work?',
      );
    });
    act(() => {
      findByTestID(tree, 'chat-send').props.onPress();
    });
    await flushSend();
    const call = spy.mock.calls[0][0];
    expect(call.userText).not.toContain('--- Page content (transcribed) ---');
    // No image regardless (deepseek), and crucially no page text.
    expect(call.imageBase64).toBeUndefined();
    expect(call.userText).not.toContain(PAGE_TEXT);
    spy.mockRestore();
  });

  it('quick action attaches even if pageContext is absent (composed userText is just the prompt)', async () => {
    // Don't seed page context — but quick actions still try to await
    // it. getPageContext returns null; composer drops the page
    // section; no image attaches. The action prompt itself still
    // routes to the model.
    const spy = jest.spyOn(fakeProvider, 'send');
    const tree = render();
    act(() => {
      findByTestID(tree, 'chat-suggestion-explain').props.onPress();
    });
    await flushSend();
    const call = spy.mock.calls[0][0];
    expect(call.userText).toBe('Explain this page');
    expect(call.imageBase64).toBeUndefined();
    spy.mockRestore();
  });
});
