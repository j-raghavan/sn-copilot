/**
 * Tests for src/ui/ChatView. Pins the chat-UX contracts:
 *   1. Renders header (title + [X]), context line, four quick-action
 *      buttons (with icons), PII row + toggle, empty hint, three
 *      insert-back buttons, text input + send.
 *   2. Quick action tap → user msg appended → thinking placeholder →
 *      AI message replaces placeholder when fakeProvider resolves.
 *   3. Free-form input + send → same flow.
 *   4. Empty input → send is a no-op (and disabled-style applied).
 *   5. Action buttons disabled while a request is in flight; freed
 *      after.
 *   6. Re-entrancy guard rejects a second concurrent send.
 *   7. PII toggle flips on tap.
 *   8. Insert-back buttons log distinctly per id.
 *   9. [X] fires onClose; ⚙ Settings link fires onSettingsTap.
 *   10. fakeProvider rejection appends an "Error: …" assistant msg.
 */
const fakeProviderModule = jest.requireActual('../src/providers/fakeProvider');

jest.useFakeTimers();

import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import ChatView from '../src/ui/ChatView';
import {__testing__ as guardTesting} from '../src/reentrancy/inFlightGuard';
import {
  findAllText,
  findByTestID,
  maybeFindByTestID,
  pressByTestID,
  textOf,
} from './helpers/textTraversal';

beforeEach(() => {
  guardTesting.reset();
});

function render(overrides: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  const onSettingsTap = jest.fn();
  const onClose = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ChatView
        scopeLabel="Current Page"
        provider="Claude"
        initialPiiRedaction={true}
        onSettingsTap={onSettingsTap}
        onClose={onClose}
        {...overrides}
      />,
    );
  });
  return {tree, onSettingsTap, onClose};
}

async function flushFakeProvider(): Promise<void> {
  // ORDER MATTERS. The send flow goes:
  //   await getPageContext()           ← microtask
  //   await client.send(...)           ← fakeProvider schedules setTimeout(600)
  //   …setMessages(...)                ← microtask after timer fires
  // If we advance timers BEFORE the first await resolves, no
  // setTimeout is queued yet so advancing does nothing. Drain
  // microtasks first → fakeProvider schedules its sleep → THEN
  // advance the clock → drain again so React commits the AI msg.
  await act(async () => {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(700);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });
}

describe('ChatView — initial render', () => {
  it('shows header, context, all four quick actions, PII row, insert row, input', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'chat-view')).toBeDefined();
    expect(findByTestID(tree, 'chat-close')).toBeDefined();
    expect(findByTestID(tree, 'chat-context')).toBeDefined();
    expect(textOf(tree, 'chat-context')).toContain('Current Page');

    expect(findByTestID(tree, 'chat-action-summarize')).toBeDefined();
    expect(findByTestID(tree, 'chat-action-explain')).toBeDefined();
    expect(findByTestID(tree, 'chat-action-clarify')).toBeDefined();
    expect(findByTestID(tree, 'chat-action-snapshot')).toBeDefined();

    expect(findByTestID(tree, 'chat-pii-row')).toBeDefined();
    expect(findByTestID(tree, 'chat-pii-toggle')).toBeDefined();

    expect(findByTestID(tree, 'chat-empty')).toBeDefined();

    // Font controls are deliberately hidden until the first AI reply
    // arrives — there's nothing to scale yet.
    expect(maybeFindByTestID(tree, 'chat-font-controls')).toBeNull();

    expect(findByTestID(tree, 'chat-input')).toBeDefined();
    expect(findByTestID(tree, 'chat-send')).toBeDefined();
  });

  it('renders quick-action icons (Unicode glyphs)', () => {
    const {tree} = render();
    const allText = findAllText(tree).join(' | ');
    // ☰ (Summarize), ✦ (Clarify), ⊡ (Snapshot) — `?` for Explain
    expect(allText).toContain('☰');
    expect(allText).toContain('✦');
    expect(allText).toContain('⊡');
  });

  it('PII redaction toggle reflects ON/OFF state', () => {
    const {tree} = render({initialPiiRedaction: true});
    // Toggle renders its current state as visible text ("ON"/"OFF").
    expect(textOf(tree, 'chat-pii-toggle')).toBe('ON');
    act(() => {
      pressByTestID(tree, 'chat-pii-toggle');
    });
    expect(textOf(tree, 'chat-pii-toggle')).toBe('OFF');
  });

  it('shows the provider in the footer; settings cog is on the context row', () => {
    const {tree} = render({provider: 'OpenAI'});
    expect(textOf(tree, 'chat-footer')).toContain('Provider: OpenAI');
    expect(findByTestID(tree, 'chat-settings')).toBeDefined();
  });

  it('fires onClose when [X] is tapped', () => {
    const {tree, onClose} = render();
    act(() => {
      findByTestID(tree, 'chat-close').props.onPress();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onSettingsTap when ⚙ Settings is tapped', () => {
    const {tree, onSettingsTap} = render();
    act(() => {
      findByTestID(tree, 'chat-settings').props.onPress();
    });
    expect(onSettingsTap).toHaveBeenCalledTimes(1);
  });
});

describe('ChatView — quick action flow', () => {
  it('appends user message + thinking placeholder + AI message on Summarize tap', async () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    // After tap: user msg + thinking msg are appended; empty hint gone.
    expect(maybeFindByTestID(tree, 'chat-empty')).toBeNull();
    expect(findAllText(tree).join(' | ')).toContain('Summarize this page');
    // The thinking placeholder shows "…"
    expect(findAllText(tree).join(' | ')).toContain('…');

    await flushFakeProvider();

    // After resolve: thinking gone, AI msg has the canned summary.
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('Notes are too long to skim');
    // Without a key file (default render), ChatView falls back to
    // fakeProvider, which echoes the model passed to it; we pass
    // 'fake-model-1' as the demo model.
    expect(text).toContain('fake-model-1');
  });

  it('Explain action sends "Explain this page"', async () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-action-explain').props.onPress();
    });
    expect(findAllText(tree).join(' | ')).toContain('Explain this page');
    await flushFakeProvider();
    expect(findAllText(tree).join(' | ')).toContain('AI assistant plugin');
  });

  it('Clarify action sends "What is unclear?"', async () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-action-clarify').props.onPress();
    });
    expect(findAllText(tree).join(' | ')).toContain('What is unclear?');
  });

  it('Snapshot action sends "Snapshot this page"', () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-action-snapshot').props.onPress();
    });
    expect(findAllText(tree).join(' | ')).toContain('Snapshot this page');
  });
});

describe('ChatView — free-form input', () => {
  it('typing + send appends user msg → AI msg', async () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-input').props.onChangeText('Custom question?');
    });
    act(() => {
      findByTestID(tree, 'chat-send').props.onPress();
    });
    expect(findAllText(tree).join(' | ')).toContain('Custom question?');
    // Input is cleared after send
    expect(findByTestID(tree, 'chat-input').props.value).toBe('');

    await flushFakeProvider();

    // Fallback canned response (no keyword match for "Custom question?")
    expect(findAllText(tree).join(' | ')).toContain('fake provider');
  });

  it('empty input is a no-op', () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-send').props.onPress();
    });
    // No user message added; empty hint still shown
    expect(findByTestID(tree, 'chat-empty')).toBeDefined();
  });

  it('whitespace-only input is a no-op', () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-input').props.onChangeText('   \n   ');
    });
    act(() => {
      findByTestID(tree, 'chat-send').props.onPress();
    });
    expect(findByTestID(tree, 'chat-empty')).toBeDefined();
  });
});

describe('ChatView — re-entrancy', () => {
  it('disables action buttons while in-flight; re-enables after', async () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    expect(findByTestID(tree, 'chat-action-summarize').props.disabled).toBe(true);
    expect(findByTestID(tree, 'chat-send').props.disabled).toBe(true);

    await flushFakeProvider();

    expect(findByTestID(tree, 'chat-action-summarize').props.disabled).toBe(false);
  });

  it('a second tap during in-flight is dropped (logged + no extra user msg)', () => {
    // Hold the guard so the first tap takes the in-flight short-circuit.
    const {tryAcquire: prime} = require('../src/reentrancy/inFlightGuard');
    expect(prime()).toBe(true);
    const {tree} = render();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      // No user message should have been appended.
      expect(maybeFindByTestID(tree, 'chat-empty')).not.toBeNull();
      const lines = log.mock.calls.map(c => c.join(' '));
      expect(lines.some(l => l.includes('already in flight'))).toBe(true);
    } finally {
      log.mockRestore();
      guardTesting.reset();
    }
  });
});

describe('ChatView — font scaling', () => {
  // Helper: drive a fakeProvider response so the controls appear.
  const renderWithReply = async () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    await flushFakeProvider();
    return tree;
  };

  it('hidden initially; appears once the first AI reply lands', async () => {
    const {tree} = render();
    expect(maybeFindByTestID(tree, 'chat-font-controls')).toBeNull();
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    // While "thinking" placeholder is up — still no AI reply — controls
    // should remain hidden.
    expect(maybeFindByTestID(tree, 'chat-font-controls')).toBeNull();
    await flushFakeProvider();
    expect(maybeFindByTestID(tree, 'chat-font-controls')).not.toBeNull();
  });

  it('indicator is the literal "A" — not the size letter', async () => {
    const tree = await renderWithReply();
    expect(textOf(tree, 'chat-font-indicator')).toBe('A');
  });

  it('starts at smallest (− disabled, + enabled)', async () => {
    const tree = await renderWithReply();
    expect(findByTestID(tree, 'chat-font-smaller').props.disabled).toBe(true);
    expect(findByTestID(tree, 'chat-font-larger').props.disabled).toBe(false);
  });

  it('+ steps up to the cap (3 sizes total); − steps back down; bounds clamp', async () => {
    const tree = await renderWithReply();
    // Start: − disabled, + enabled. Tap + twice → at cap, + disabled.
    act(() => {
      findByTestID(tree, 'chat-font-larger').props.onPress();
    });
    expect(findByTestID(tree, 'chat-font-larger').props.disabled).toBe(false);
    act(() => {
      findByTestID(tree, 'chat-font-larger').props.onPress();
    });
    expect(findByTestID(tree, 'chat-font-larger').props.disabled).toBe(true);
    // Now − is enabled.
    expect(findByTestID(tree, 'chat-font-smaller').props.disabled).toBe(false);
    // Step back down twice → at floor, − disabled, + enabled.
    act(() => {
      findByTestID(tree, 'chat-font-smaller').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'chat-font-smaller').props.onPress();
    });
    expect(findByTestID(tree, 'chat-font-smaller').props.disabled).toBe(true);
    expect(findByTestID(tree, 'chat-font-larger').props.disabled).toBe(false);
  });
});

describe('ChatView — provider rejection', () => {
  it('appends an Error assistant msg when fakeProvider rejects', async () => {
    const fp = require('../src/providers/fakeProvider').default;
    const spy = jest.spyOn(fp, 'send').mockRejectedValueOnce(new Error('boom'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const {tree} = render();
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const text = findAllText(tree).join(' | ');
      expect(text).toContain('Error: Error: boom');
      // The thinking placeholder should be gone.
      expect(text).not.toMatch(/^\s*…\s*$/);
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
  });
});

describe('ChatView — per-bubble copy', () => {
  const findCopyButton = (tree: ReactTestRenderer) => {
    const matches = tree.root.findAllByProps({
      accessibilityLabel: 'Copy reply to clipboard',
    });
    return matches.find(
      m => typeof (m.props as {onPress?: unknown}).onPress === 'function',
    );
  };

  it('AI bubble has a copy button that fires CopilotOverlay.copyToClipboard', async () => {
    const overlay = require('../src/native/CopilotOverlay').default;
    const copySpy = jest
      .spyOn(overlay, 'copyToClipboard')
      .mockResolvedValue({success: true, code: 'OK', message: 'fixture'});
    try {
      const {tree} = render();
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const pressable = findCopyButton(tree);
      expect(pressable).toBeDefined();
      act(() => {
        (pressable!.props as {onPress: () => void}).onPress();
      });
      expect(copySpy).toHaveBeenCalledWith(
        expect.stringContaining('Notes are too long to skim'),
        'Copilot reply',
      );
    } finally {
      copySpy.mockRestore();
    }
  });

  it('strips markdown syntax before writing to clipboard (paste shows plain text)', async () => {
    const fp = require('../src/providers/fakeProvider').default;
    const sendSpy = jest.spyOn(fp, 'send').mockResolvedValueOnce({
      text: '### Summary\n\n- **bold** point\n- a *italic* point',
      usage: {inputTokens: 1, outputTokens: 1},
      latencyMs: 1,
      modelId: 'fake-model-1',
    });
    const overlay = require('../src/native/CopilotOverlay').default;
    const copySpy = jest
      .spyOn(overlay, 'copyToClipboard')
      .mockResolvedValue({success: true, code: 'OK', message: 'fixture'});
    try {
      const {tree} = render();
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const pressable = findCopyButton(tree)!;
      act(() => {
        (pressable.props as {onPress: () => void}).onPress();
      });
      const [clipboardText] = copySpy.mock.calls[0] as [string, string];
      // Heading hashes gone; bullets converted to •; bold/italic stripped.
      expect(clipboardText).toBe('Summary\n\n• bold point\n• a italic point');
      // No raw markdown syntax leaked.
      expect(clipboardText).not.toContain('###');
      expect(clipboardText).not.toContain('**');
    } finally {
      copySpy.mockRestore();
      sendSpy.mockRestore();
    }
  });

  it('user bubbles + thinking bubbles do NOT show a copy button', async () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    // User msg + thinking placeholder are present, AI is not yet.
    const copyBtns = tree.root.findAllByProps({
      accessibilityLabel: 'Copy reply to clipboard',
    });
    expect(copyBtns).toHaveLength(0);
  });

  // Find the copy-button testID for the most recent assistant msg
  // (the one we just produced via flushFakeProvider). Walking
  // findAllByProps and picking the entry that has both testID
  // matching `chat-copy-…` AND an onPress handler.
  const findCopyTestID = (tree: ReactTestRenderer): string => {
    const matches = tree.root
      .findAllByProps({accessibilityLabel: 'Copy reply to clipboard'})
      .filter(
        m => typeof (m.props as {onPress?: unknown}).onPress === 'function',
      );
    const props = matches[0].props as {testID: string};
    return props.testID;
  };

  it('flips to "✓ Copied" on success then reverts after the timeout', async () => {
    const overlay = require('../src/native/CopilotOverlay').default;
    const copySpy = jest
      .spyOn(overlay, 'copyToClipboard')
      .mockResolvedValue({success: true, code: 'OK', message: 'fixture'});
    try {
      const {tree} = render();
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const copyId = findCopyTestID(tree);
      expect(textOf(tree, copyId)).toBe('📋 Copy');
      // Tap; flush the resolved promise to drive setCopyFeedback.
      const pressable = findCopyButton(tree)!;
      await act(async () => {
        (pressable.props as {onPress: () => void}).onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(textOf(tree, copyId)).toBe('✓ Copied');
      // Time advances → revert to idle.
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(textOf(tree, copyId)).toBe('📋 Copy');
    } finally {
      copySpy.mockRestore();
    }
  });

  it('flips to "✕ Failed" and logs when the native module rejects', async () => {
    const overlay = require('../src/native/CopilotOverlay').default;
    const copySpy = jest
      .spyOn(overlay, 'copyToClipboard')
      .mockRejectedValue(new Error('bridge gone'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const {tree} = render();
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const copyId = findCopyTestID(tree);
      const pressable = findCopyButton(tree)!;
      await act(async () => {
        (pressable.props as {onPress: () => void}).onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(textOf(tree, copyId)).toBe('✕ Failed');
      const lines = log.mock.calls.map(c => c.join(' '));
      expect(lines.some(l => l.includes('copyToClipboard threw'))).toBe(true);
    } finally {
      copySpy.mockRestore();
      log.mockRestore();
    }
  });

  it('flips to "✕ Failed" when the native module reports failure', async () => {
    const overlay = require('../src/native/CopilotOverlay').default;
    const copySpy = jest
      .spyOn(overlay, 'copyToClipboard')
      .mockResolvedValue({
        success: false,
        code: 'NO_CLIPBOARD_SERVICE',
        message: 'no clipboard',
      });
    try {
      const {tree} = render();
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const copyId = findCopyTestID(tree);
      const pressable = findCopyButton(tree)!;
      await act(async () => {
        (pressable.props as {onPress: () => void}).onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(textOf(tree, copyId)).toBe('✕ Failed');
    } finally {
      copySpy.mockRestore();
    }
  });
});

describe('ChatView — new chat button', () => {
  it('clears messages and the input field, returns the empty hint', async () => {
    const {tree} = render();
    // Type something + drive a reply so messages is non-empty.
    act(() => {
      findByTestID(tree, 'chat-input').props.onChangeText('partial draft');
    });
    act(() => {
      findByTestID(tree, 'chat-action-summarize').props.onPress();
    });
    await flushFakeProvider();
    // Sanity: chat-empty hint is gone, input still holds what was typed
    expect(maybeFindByTestID(tree, 'chat-empty')).toBeNull();
    // Tap New Chat
    act(() => {
      findByTestID(tree, 'chat-new').props.onPress();
    });
    // Empty hint should be back; input cleared.
    expect(findByTestID(tree, 'chat-empty')).toBeDefined();
    expect(findByTestID(tree, 'chat-input').props.value).toBe('');
  });
});

describe('ChatView — settings link moved to context row', () => {
  it('chat-settings is rendered (next to context, not in footer)', () => {
    const {tree, onSettingsTap} = render();
    expect(findByTestID(tree, 'chat-settings')).toBeDefined();
    act(() => {
      findByTestID(tree, 'chat-settings').props.onPress();
    });
    expect(onSettingsTap).toHaveBeenCalledTimes(1);
  });

  it('footer no longer contains the Settings link', () => {
    const {tree} = render();
    const footerText = textOf(tree, 'chat-footer');
    expect(footerText).not.toContain('Settings');
    expect(footerText).toContain('Provider:');
  });
});

describe('ChatView — pageContext composition', () => {
  it('appends "--- Page content (transcribed) ---" + pageText when pageContext.pageText is non-empty', async () => {
    const {
      setPageContext,
      __testing__,
    } = require('../src/scope/pageContext');
    setPageContext({
      notePath: '/sd/x.note',
      page: 1,
      screenshotPath: '/sd/png',
      screenshotBase64: 'AAAA',
      pageText: 'transcribed body',
    });
    const fakeProviderRef = require('../src/providers/fakeProvider').default;
    const sendSpy = jest.spyOn(fakeProviderRef, 'send').mockResolvedValueOnce({
      text: 'reply',
      usage: {inputTokens: 1, outputTokens: 1},
      latencyMs: 1,
      modelId: 'fake-model-1',
    });
    try {
      const {tree} = render();
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const sentReq = sendSpy.mock.calls[0][0] as {userText: string};
      expect(sentReq.userText).toContain(
        '--- Page content (transcribed) ---',
      );
      expect(sentReq.userText).toContain('transcribed body');
    } finally {
      sendSpy.mockRestore();
      __testing__.reset();
    }
  });
});

describe('ChatView — keyFile prop wires real provider client', () => {
  it('uses createProviderClient when keyFile is provided', async () => {
    // Mock fetch — Anthropic-shaped response.
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{type: 'text', text: 'real reply'}],
        usage: {input_tokens: 1, output_tokens: 2},
        model: 'claude-haiku-4-5',
      }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const {tree} = render({
        keyFile: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          key: 'sk-ant-real',
          mode: 'text',
          sourcePath: '/x/copilot-key-anthropic.txt',
        },
      });
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      expect(fetchSpy).toHaveBeenCalled();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(
        'sk-ant-real',
      );
      const text = findAllText(tree).join(' | ');
      expect(text).toContain('real reply');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('ChatView — hung send timeout', () => {
  it('aborts a hung request after the send timeout and releases the in-flight guard', async () => {
    const fp = require('../src/providers/fakeProvider').default;
    const guard = require('../src/reentrancy/inFlightGuard');
    // The mock never resolves on its own — only the AbortSignal
    // wakes it up, mirroring the way fetch behaves on a real hang.
    const sendSpy = jest.spyOn(fp, 'send').mockImplementation(((req: {
      signal: AbortSignal;
    }) =>
      new Promise((_, reject) => {
        req.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      })) as unknown as typeof fp.send);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const {tree} = render();
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      // Drain initial microtasks so getPageContext + sendSpy are
      // wired up before we advance the clock.
      await act(async () => {
        for (let i = 0; i < 3; i++) {
          await Promise.resolve();
        }
      });
      expect(guard.isInFlight()).toBe(true);
      // Advance past the 60s send timeout → controller aborts → the
      // mocked send rejects → finally block releases the guard.
      await act(async () => {
        jest.advanceTimersByTime(60_000);
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
      });
      expect(guard.isInFlight()).toBe(false);
    } finally {
      sendSpy.mockRestore();
      log.mockRestore();
    }
  });
});

describe('ChatView — KeyFile.mode gate on image attachment', () => {
  const seedContextWithImage = (): void => {
    const {setPageContext} = require('../src/scope/pageContext');
    setPageContext({
      notePath: '/sd/x.note',
      page: 1,
      screenshotPath: '/sd/png',
      screenshotBase64: 'IMGBYTES',
      pageText: 'page body',
    });
  };
  const resetCtx = (): void => {
    const {__testing__} = require('../src/scope/pageContext');
    __testing__.reset();
  };

  it('suppresses imageBase64 when keyFile.mode is "text" even with piiOn off', async () => {
    seedContextWithImage();
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{message: {content: 'ok'}}],
        usage: {prompt_tokens: 1, completion_tokens: 1},
        model: 'deepseek-chat',
      }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const {tree} = render({
        initialPiiRedaction: false,
        keyFile: {
          provider: 'deepseek',
          key: 'sk-deep',
          model: 'deepseek-chat',
          mode: 'text',
          sourcePath: '/sd/copilot-key-deepseek.txt',
        },
      });
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      expect(fetchSpy).toHaveBeenCalled();
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init.body as string);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('IMGBYTES');
    } finally {
      globalThis.fetch = originalFetch;
      resetCtx();
    }
  });

  it('forwards imageBase64 when keyFile.mode is "image" and piiOn off', async () => {
    seedContextWithImage();
    const fp = require('../src/providers/fakeProvider').default;
    const sendSpy = jest.spyOn(fp, 'send').mockResolvedValueOnce({
      text: 'ok',
      usage: {inputTokens: 1, outputTokens: 1},
      latencyMs: 1,
      modelId: 'fake-model-1',
    });
    try {
      // No keyFile → behaves as image-allowed (matches fake fallback).
      const {tree} = render({initialPiiRedaction: false});
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const sentReq = sendSpy.mock.calls[0][0] as {imageBase64?: string};
      expect(sentReq.imageBase64).toBe('IMGBYTES');
    } finally {
      sendSpy.mockRestore();
      resetCtx();
    }
  });
});

describe('ChatView — PII redaction enforcement', () => {
  const seedContext = (): void => {
    const {setPageContext} = require('../src/scope/pageContext');
    setPageContext({
      notePath: '/sd/x.note',
      page: 1,
      screenshotPath: '/sd/png',
      screenshotBase64: 'IMGBYTES',
      pageText: 'Reach me at jay@example.com or 5551234567.',
    });
  };

  const resetContext = (): void => {
    const {__testing__} = require('../src/scope/pageContext');
    __testing__.reset();
  };

  it('redacts email + long digits and drops image when piiOn is true', async () => {
    seedContext();
    const fp = require('../src/providers/fakeProvider').default;
    const sendSpy = jest.spyOn(fp, 'send').mockResolvedValueOnce({
      text: 'ok',
      usage: {inputTokens: 1, outputTokens: 1},
      latencyMs: 1,
      modelId: 'fake-model-1',
    });
    try {
      const {tree} = render({initialPiiRedaction: true});
      act(() => {
        findByTestID(tree, 'chat-input').props.onChangeText(
          'Forward to me@b.co at 9998887777',
        );
      });
      act(() => {
        findByTestID(tree, 'chat-send').props.onPress();
      });
      await flushFakeProvider();
      const sentReq = sendSpy.mock.calls[0][0] as {
        userText: string;
        imageBase64?: string;
      };
      expect(sentReq.userText).toContain('[REDACTED-EMAIL]');
      expect(sentReq.userText).toContain('[REDACTED-NUMBER]');
      expect(sentReq.userText).not.toContain('jay@example.com');
      expect(sentReq.userText).not.toContain('5551234567');
      expect(sentReq.imageBase64).toBeUndefined();
    } finally {
      sendSpy.mockRestore();
      resetContext();
    }
  });

  it('forwards raw text + image when piiOn is false', async () => {
    seedContext();
    const fp = require('../src/providers/fakeProvider').default;
    const sendSpy = jest.spyOn(fp, 'send').mockResolvedValueOnce({
      text: 'ok',
      usage: {inputTokens: 1, outputTokens: 1},
      latencyMs: 1,
      modelId: 'fake-model-1',
    });
    try {
      const {tree} = render({initialPiiRedaction: false});
      act(() => {
        findByTestID(tree, 'chat-action-summarize').props.onPress();
      });
      await flushFakeProvider();
      const sentReq = sendSpy.mock.calls[0][0] as {
        userText: string;
        imageBase64?: string;
      };
      expect(sentReq.userText).toContain('jay@example.com');
      expect(sentReq.userText).toContain('5551234567');
      expect(sentReq.imageBase64).toBe('IMGBYTES');
    } finally {
      sendSpy.mockRestore();
      resetContext();
    }
  });
});

// Side-effect: ensure jest.requireActual references stay alive (no
// dead-import lint). The test file uses the actual fakeProvider via
// the real module path, with one test using jest.spyOn for the
// reject path.
expect(fakeProviderModule).toBeDefined();
