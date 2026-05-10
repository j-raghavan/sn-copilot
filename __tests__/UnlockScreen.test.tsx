/**
 * Tests for src/ui/UnlockScreen. Pins:
 *   1. Submit calls onAttempt with the entered secret.
 *   2. ok result clears state (no error message; submit re-enables).
 *   3. wrong-pin result locks input for an exponentially-growing
 *      window; visible countdown ticks.
 *   4. corrupt result surfaces a "vault unreadable" message.
 *   5. After RESET_AFTER_FAILS failures, reset button becomes visible.
 *   6. Reset calls onReset.
 *   7. Submit disabled when input empty.
 */
import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import UnlockScreen, {type UnlockResult} from '../src/ui/UnlockScreen';
import {findAllText, findByTestID, maybeFindByTestID} from './helpers/textTraversal';

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

const render = (
  overrides: Partial<React.ComponentProps<typeof UnlockScreen>> = {},
): {tree: ReactTestRenderer; props: React.ComponentProps<typeof UnlockScreen>} => {
  const props: React.ComponentProps<typeof UnlockScreen> = {
    onAttempt: jest.fn(async () => ({kind: 'ok'} as UnlockResult)),
    onReset: jest.fn(),
    ...overrides,
  };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<UnlockScreen {...props} />);
  });
  return {tree, props};
};

const setText = (tree: ReactTestRenderer, testID: string, text: string) => {
  act(() => {
    findByTestID(tree, testID).props.onChangeText(text);
  });
};

describe('UnlockScreen — input + submit', () => {
  it('submit disabled with empty input', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'unlock-submit').props.disabled).toBe(true);
  });

  it('submit calls onAttempt with the entered secret', async () => {
    const onAttempt = jest.fn(async () => ({kind: 'ok'} as UnlockResult));
    const {tree} = render({onAttempt});
    setText(tree, 'unlock-input', '123456');
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    expect(onAttempt).toHaveBeenCalledWith('123456');
  });

  it('show toggle flips secureTextEntry', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'unlock-input').props.secureTextEntry).toBe(true);
    act(() => {
      findByTestID(tree, 'unlock-toggle-show').props.onPress();
    });
    expect(findByTestID(tree, 'unlock-input').props.secureTextEntry).toBe(false);
  });
});

describe('UnlockScreen — ok / wrong / corrupt', () => {
  it('ok result clears any previous message and input', async () => {
    const onAttempt = jest.fn(async () => ({kind: 'ok'} as UnlockResult));
    const {tree} = render({onAttempt});
    setText(tree, 'unlock-input', '987654');
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    expect(maybeFindByTestID(tree, 'unlock-message')).toBeNull();
    expect(findByTestID(tree, 'unlock-input').props.value).toBe('');
  });

  it('corrupt result shows the unreadable message', async () => {
    const onAttempt = jest.fn(async () => ({
      kind: 'corrupt' as const,
      reason: 'envelope shape',
    }));
    const {tree} = render({onAttempt});
    setText(tree, 'unlock-input', '987654');
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    expect(findAllText(tree).join(' | ')).toContain('Vault file is unreadable');
  });

  it('wrong-pin engages the exponential backoff', async () => {
    jest.useFakeTimers();
    const onAttempt = jest.fn(async () => ({kind: 'wrong-pin'} as UnlockResult));
    const {tree} = render({onAttempt});

    setText(tree, 'unlock-input', '111111');
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });

    expect(findAllText(tree).join(' | ')).toContain('Wrong PIN');
    expect(findByTestID(tree, 'unlock-input').props.editable).toBe(false);
    expect(maybeFindByTestID(tree, 'unlock-countdown')).not.toBeNull();

    // After 1 second the input becomes editable again.
    await act(async () => {
      jest.advanceTimersByTime(1_100);
      await flushPromises();
    });
    expect(findByTestID(tree, 'unlock-input').props.editable).toBe(true);
    jest.useRealTimers();
  });

  it('shows reset button after RESET_AFTER_FAILS wrong attempts', async () => {
    jest.useFakeTimers();
    const onAttempt = jest.fn(async () => ({kind: 'wrong-pin'} as UnlockResult));
    const {tree} = render({onAttempt});

    for (let i = 0; i < 5; i++) {
      setText(tree, 'unlock-input', '111111');
      await act(async () => {
        findByTestID(tree, 'unlock-submit').props.onPress();
        await flushPromises();
      });
      // Drain whatever backoff was set so the next submit isn't blocked.
      await act(async () => {
        jest.advanceTimersByTime(60_000);
        await flushPromises();
      });
    }

    expect(maybeFindByTestID(tree, 'unlock-reset')).not.toBeNull();
    jest.useRealTimers();
  });

  it('reset button calls onReset', async () => {
    jest.useFakeTimers();
    const onReset = jest.fn();
    const onAttempt = jest.fn(async () => ({kind: 'wrong-pin'} as UnlockResult));
    const {tree} = render({onAttempt, onReset});

    // Force the failure counter past the threshold (same pattern as
    // the visibility test — two separate act() blocks per iteration so
    // submit's state update flushes before the timer advance).
    for (let i = 0; i < 5; i++) {
      setText(tree, 'unlock-input', '111111');
      await act(async () => {
        findByTestID(tree, 'unlock-submit').props.onPress();
        await flushPromises();
      });
      await act(async () => {
        jest.advanceTimersByTime(60_000);
        await flushPromises();
      });
    }
    act(() => {
      findByTestID(tree, 'unlock-reset').props.onPress();
    });
    expect(onReset).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('unmount during the backoff cleans up the countdown interval', async () => {
    jest.useFakeTimers();
    const onAttempt = jest.fn(async () => ({kind: 'wrong-pin'} as UnlockResult));
    const {tree} = render({onAttempt});
    setText(tree, 'unlock-input', '111111');
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    // Now in backoff state; an interval is active. Unmount must not
    // throw and must clear the interval.
    expect(() => {
      act(() => {
        tree.unmount();
      });
    }).not.toThrow();
    jest.useRealTimers();
  });

  it('countdown elapses naturally and clears the interval', async () => {
    jest.useFakeTimers();
    const onAttempt = jest.fn(async () => ({kind: 'wrong-pin'} as UnlockResult));
    const {tree} = render({onAttempt});
    setText(tree, 'unlock-input', '111111');
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    // Advance past the 1-second backoff so the countdown elapses
    // naturally — this triggers the lockUntilMs <= now branch and the
    // tickRef cleanup inside the useEffect.
    await act(async () => {
      jest.advanceTimersByTime(1_500);
      await flushPromises();
    });
    expect(findByTestID(tree, 'unlock-input').props.editable).toBe(true);
    jest.useRealTimers();
  });

  it('submit is a no-op when the input is empty (defensive guard)', async () => {
    const onAttempt = jest.fn();
    const {tree} = render({onAttempt});
    // The button is disabled, but invoking onPress directly verifies
    // the in-handler guard is also in place.
    await act(async () => {
      findByTestID(tree, 'unlock-submit').props.onPress();
      await flushPromises();
    });
    expect(onAttempt).not.toHaveBeenCalled();
  });
});
