/**
 * Tests for src/ui/PersonaSettings. Pins:
 *   1. Renders with the current value pre-filled and a counter.
 *   2. Save is disabled until the user types something new.
 *   3. Save passes the new value through onSave.
 *   4. Saving an empty draft → onSave called with null (clear).
 *   5. Reset → onSave(null) and the draft clears.
 *   6. Over-length input disables Save with a hint in the counter.
 *   7. External update to `current` flows back into the draft.
 */
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import PersonaSettings from '../src/ui/PersonaSettings';
import {CUSTOM_SYSTEM_PROMPT_MAX} from '../src/types';
import {findByTestID, textOf} from './helpers/textTraversal';

function render(over: Partial<React.ComponentProps<typeof PersonaSettings>> = {}) {
  const onSave = jest.fn(async () => {});
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<PersonaSettings current={undefined} onSave={onSave} {...over} />);
  });
  return {tree, onSave};
}

describe('PersonaSettings', () => {
  it('renders with an empty draft when no current is set', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'persona-input').props.value).toBe('');
    expect(textOf(tree, 'persona-counter')).toContain(
      `0 / ${CUSTOM_SYSTEM_PROMPT_MAX}`,
    );
  });

  it('pre-fills the draft from the current value', () => {
    const {tree} = render({current: 'be a kind tutor'});
    expect(findByTestID(tree, 'persona-input').props.value).toBe('be a kind tutor');
  });

  it('Save is disabled when draft equals current (no dirty edit)', () => {
    const {tree} = render({current: 'persona x'});
    expect(findByTestID(tree, 'persona-save').props.disabled).toBe(true);
  });

  it('Save enabled and routes the new value to onSave', async () => {
    const {tree, onSave} = render({current: 'old'});
    act(() => {
      findByTestID(tree, 'persona-input').props.onChangeText('something new');
    });
    expect(findByTestID(tree, 'persona-save').props.disabled).toBe(false);
    await act(async () => {
      findByTestID(tree, 'persona-save').props.onPress();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith('something new');
  });

  it('Save with empty draft routes onSave(null)', async () => {
    const {tree, onSave} = render({current: 'old'});
    act(() => {
      findByTestID(tree, 'persona-input').props.onChangeText('');
    });
    await act(async () => {
      findByTestID(tree, 'persona-save').props.onPress();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('Reset calls onSave(null) and clears the draft', async () => {
    const {tree, onSave} = render({current: 'preset'});
    await act(async () => {
      findByTestID(tree, 'persona-reset').props.onPress();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith(null);
    expect(findByTestID(tree, 'persona-input').props.value).toBe('');
  });

  it('Reset is disabled when nothing is set and draft is empty', () => {
    const {tree} = render({current: undefined});
    expect(findByTestID(tree, 'persona-reset').props.disabled).toBe(true);
  });

  it('over-length draft disables Save and flags the counter', () => {
    const {tree} = render({current: undefined});
    act(() => {
      findByTestID(tree, 'persona-input').props.onChangeText(
        'x'.repeat(CUSTOM_SYSTEM_PROMPT_MAX + 5),
      );
    });
    expect(findByTestID(tree, 'persona-save').props.disabled).toBe(true);
    expect(textOf(tree, 'persona-counter')).toContain('too long');
  });

  it('external current update flows into the input', () => {
    const onSave = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<PersonaSettings current="first" onSave={onSave} />);
    });
    expect(findByTestID(tree, 'persona-input').props.value).toBe('first');
    act(() => {
      tree.update(<PersonaSettings current="second" onSave={onSave} />);
    });
    expect(findByTestID(tree, 'persona-input').props.value).toBe('second');
  });

  it('force-tap Save while over-length does NOT call onSave (defensive guard)', () => {
    const {tree, onSave} = render({current: undefined});
    act(() => {
      findByTestID(tree, 'persona-input').props.onChangeText(
        'x'.repeat(CUSTOM_SYSTEM_PROMPT_MAX + 1),
      );
    });
    // Button is disabled, but test-renderer still lets us invoke
    // onPress — the guard inside onPressSave is what we're exercising.
    act(() => {
      findByTestID(tree, 'persona-save').props.onPress();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('rapid double-tap on Save does not call onSave twice', async () => {
    let resolveOuter: () => void = () => {};
    const slow = jest.fn(
      () =>
        new Promise<void>((res) => {
          resolveOuter = res;
        }),
    );
    const {tree} = render({current: undefined, onSave: slow});
    act(() => {
      findByTestID(tree, 'persona-input').props.onChangeText('x');
    });
    act(() => {
      findByTestID(tree, 'persona-save').props.onPress();
    });
    act(() => {
      // Second tap while the first is still pending.
      findByTestID(tree, 'persona-save').props.onPress();
    });
    expect(slow).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveOuter();
      await Promise.resolve();
    });
  });
});
