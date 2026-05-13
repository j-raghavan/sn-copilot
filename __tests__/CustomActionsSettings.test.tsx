/**
 * Tests for src/ui/CustomActionsSettings. Pins:
 *   1. Empty state shows the hint + Add button.
 *   2. Add → form → Save persists the new action (id minted).
 *   3. Save is disabled when any field is blank or over its cap.
 *   4. Edit prefills the form, Save replaces in place.
 *   5. Delete drops the row and persists the rest.
 *   6. Add button disabled at CUSTOM_ACTION_LIMIT.
 *   7. Cancel discards in-flight edits.
 *   8. Edit/Delete buttons disabled while the form is open.
 */
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import CustomActionsSettings from '../src/ui/CustomActionsSettings';
import {
  CUSTOM_ACTION_LABEL_MAX,
  CUSTOM_ACTION_LIMIT,
  CUSTOM_ACTION_PROMPT_MAX,
  type CustomAction,
} from '../src/types';
import {findByTestID, maybeFindByTestID, textOf} from './helpers/textTraversal';

const sample = (over: Partial<CustomAction> = {}): CustomAction => ({
  id: 'id-1',
  label: 'Glossary',
  icon: '📖',
  prompt: 'Define key terms on this page.',
  ...over,
});

function render(over: Partial<React.ComponentProps<typeof CustomActionsSettings>> = {}) {
  // Explicit signature so onSave.mock.calls[i][0] is typed as
  // CustomAction[] rather than the never[] you get from
  // `jest.fn(async () => {})`'s inferred parameter list.
  const onSave = jest.fn<Promise<void>, [CustomAction[]]>(async () => {});
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <CustomActionsSettings current={undefined} onSave={onSave} {...over} />,
    );
  });
  return {tree, onSave};
}

describe('CustomActionsSettings — empty state', () => {
  it('shows the empty hint + an enabled Add button', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'custom-actions-empty')).toBeDefined();
    expect(findByTestID(tree, 'custom-actions-add').props.disabled).toBe(false);
  });
});

describe('CustomActionsSettings — Add flow', () => {
  it('opens the form on Add', () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    expect(findByTestID(tree, 'custom-action-form')).toBeDefined();
  });

  it('Save is disabled until all three fields are filled', () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    expect(findByTestID(tree, 'custom-action-save').props.disabled).toBe(true);
    act(() => {
      findByTestID(tree, 'custom-action-icon').props.onChangeText('🔍');
    });
    expect(findByTestID(tree, 'custom-action-save').props.disabled).toBe(true);
    act(() => {
      findByTestID(tree, 'custom-action-label').props.onChangeText('Find');
    });
    expect(findByTestID(tree, 'custom-action-save').props.disabled).toBe(true);
    act(() => {
      findByTestID(tree, 'custom-action-prompt').props.onChangeText(
        'Find references to the topic.',
      );
    });
    expect(findByTestID(tree, 'custom-action-save').props.disabled).toBe(false);
  });

  it('Save calls onSave with a freshly-minted action', async () => {
    const {tree, onSave} = render();
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'custom-action-icon').props.onChangeText('🔍');
    });
    act(() => {
      findByTestID(tree, 'custom-action-label').props.onChangeText('Find');
    });
    act(() => {
      findByTestID(tree, 'custom-action-prompt').props.onChangeText(
        'Find references to the topic.',
      );
    });
    await act(async () => {
      findByTestID(tree, 'custom-action-save').props.onPress();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const next = onSave.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(next[0].label).toBe('Find');
    expect(next[0].icon).toBe('🔍');
    expect(next[0].prompt).toBe('Find references to the topic.');
    expect(next[0].id).toMatch(/^c_/);
  });

  it('Save disabled when a field exceeds its cap', () => {
    const {tree} = render();
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'custom-action-icon').props.onChangeText('A');
    });
    act(() => {
      findByTestID(tree, 'custom-action-label').props.onChangeText(
        'x'.repeat(CUSTOM_ACTION_LABEL_MAX + 1),
      );
    });
    act(() => {
      findByTestID(tree, 'custom-action-prompt').props.onChangeText(
        'short prompt',
      );
    });
    expect(findByTestID(tree, 'custom-action-save').props.disabled).toBe(true);
    // Now exceed the prompt cap separately.
    act(() => {
      findByTestID(tree, 'custom-action-label').props.onChangeText('OK');
    });
    act(() => {
      findByTestID(tree, 'custom-action-prompt').props.onChangeText(
        'x'.repeat(CUSTOM_ACTION_PROMPT_MAX + 1),
      );
    });
    expect(findByTestID(tree, 'custom-action-save').props.disabled).toBe(true);
  });

  it('Cancel closes the form without saving', () => {
    const {tree, onSave} = render();
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'custom-action-cancel').props.onPress();
    });
    expect(maybeFindByTestID(tree, 'custom-action-form')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('CustomActionsSettings — Edit flow', () => {
  it('prefills the form from the row being edited', () => {
    const a = sample();
    const {tree} = render({current: [a]});
    act(() => {
      findByTestID(tree, `custom-action-edit-${a.id}`).props.onPress();
    });
    expect(findByTestID(tree, 'custom-action-icon').props.value).toBe(a.icon);
    expect(findByTestID(tree, 'custom-action-label').props.value).toBe(a.label);
    expect(findByTestID(tree, 'custom-action-prompt').props.value).toBe(
      a.prompt,
    );
  });

  it('Save on edit replaces the existing row in place', async () => {
    const a = sample();
    const b = sample({id: 'id-2', label: 'Risks', icon: '⚠', prompt: 'risks?'});
    const {tree, onSave} = render({current: [a, b]});
    act(() => {
      findByTestID(tree, `custom-action-edit-${a.id}`).props.onPress();
    });
    act(() => {
      findByTestID(tree, 'custom-action-label').props.onChangeText('Definitions');
    });
    await act(async () => {
      findByTestID(tree, 'custom-action-save').props.onPress();
      await Promise.resolve();
    });
    const next = onSave.mock.calls[0][0];
    expect(next).toHaveLength(2);
    expect(next.find((x) => x.id === a.id)?.label).toBe('Definitions');
    expect(next.find((x) => x.id === b.id)?.label).toBe('Risks');
  });

  it('Edit and Delete are disabled while the form is open', () => {
    const a = sample();
    const {tree} = render({current: [a]});
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    expect(findByTestID(tree, `custom-action-edit-${a.id}`).props.disabled).toBe(
      true,
    );
    expect(findByTestID(tree, `custom-action-delete-${a.id}`).props.disabled).toBe(
      true,
    );
  });
});

describe('CustomActionsSettings — Delete', () => {
  it('removes the row and persists the rest', async () => {
    const a = sample();
    const b = sample({id: 'id-2', label: 'Risks', icon: '⚠', prompt: 'risks?'});
    const {tree, onSave} = render({current: [a, b]});
    await act(async () => {
      findByTestID(tree, `custom-action-delete-${a.id}`).props.onPress();
      await Promise.resolve();
    });
    const next = onSave.mock.calls[0][0];
    expect(next).toEqual([b]);
  });
});

describe('CustomActionsSettings — defensive guards', () => {
  it('force-tap Save with blank fields after open → no onSave', () => {
    const {tree, onSave} = render();
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    // Save is disabled, but test-renderer lets us invoke onPress.
    // The internal guard at the top of saveEdit early-returns.
    act(() => {
      findByTestID(tree, 'custom-action-save').props.onPress();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('force-tap Save with over-cap fields → no onSave', () => {
    const {tree, onSave} = render();
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'custom-action-icon').props.onChangeText('A');
    });
    act(() => {
      findByTestID(tree, 'custom-action-label').props.onChangeText(
        'x'.repeat(CUSTOM_ACTION_LABEL_MAX + 5),
      );
    });
    act(() => {
      findByTestID(tree, 'custom-action-prompt').props.onChangeText('p');
    });
    act(() => {
      findByTestID(tree, 'custom-action-save').props.onPress();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('double-tap Delete on the same row only fires onSave once (busy guard)', async () => {
    const a = sample();
    let resolveOuter: () => void = () => {};
    const slow = jest.fn(
      () =>
        new Promise<void>((res) => {
          resolveOuter = res;
        }),
    );
    const {tree} = render({current: [a], onSave: slow});
    act(() => {
      findByTestID(tree, `custom-action-delete-${a.id}`).props.onPress();
    });
    act(() => {
      // Second tap while the first delete is still pending — the
      // busy guard at the top of deleteAction early-returns.
      findByTestID(tree, `custom-action-delete-${a.id}`).props.onPress();
    });
    expect(slow).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveOuter();
      await Promise.resolve();
    });
  });

  it('double-tap Save during an in-flight save fires onSave once (busy guard)', async () => {
    let resolveOuter: () => void = () => {};
    const slow = jest.fn(
      () =>
        new Promise<void>((res) => {
          resolveOuter = res;
        }),
    );
    const {tree} = render({current: undefined, onSave: slow});
    act(() => {
      findByTestID(tree, 'custom-actions-add').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'custom-action-icon').props.onChangeText('📖');
    });
    act(() => {
      findByTestID(tree, 'custom-action-label').props.onChangeText('Glossary');
    });
    act(() => {
      findByTestID(tree, 'custom-action-prompt').props.onChangeText(
        'Define terms.',
      );
    });
    act(() => {
      findByTestID(tree, 'custom-action-save').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'custom-action-save').props.onPress();
    });
    expect(slow).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveOuter();
      await Promise.resolve();
    });
  });
});

describe('CustomActionsSettings — Limit', () => {
  it('Add button is disabled at the limit', () => {
    const full = Array.from({length: CUSTOM_ACTION_LIMIT}, (_, i) =>
      sample({id: `id-${i}`, label: `Act ${i}`}),
    );
    const {tree} = render({current: full});
    expect(findByTestID(tree, 'custom-actions-add').props.disabled).toBe(true);
    expect(textOf(tree, 'custom-actions-add')).toContain('Limit reached');
  });
});
