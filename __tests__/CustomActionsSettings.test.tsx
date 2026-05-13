/**
 * Tests for src/ui/CustomActionsSettings (post-#7 redesign).
 *
 * Custom actions are now user-managed via a plain-text file at
 * MyStyle/SnCopilot/custom_actions.txt. The Settings component is a
 * read-only preview + reload button — no in-app CRUD.
 *
 * Pins:
 *   1. Empty state shows the missing-file hint.
 *   2. Populated state renders one row per action with the numbered
 *      icon, label, and prompt preview.
 *   3. The file path is rendered (so the user knows what to edit).
 *   4. Reload button invokes onReload and disables while in flight.
 */
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import CustomActionsSettings from '../src/ui/CustomActionsSettings';
import type {CustomAction} from '../src/types';
import {findByTestID, maybeFindByTestID, textOf} from './helpers/textTraversal';

const PATH = '/storage/emulated/0/MyStyle/SnCopilot/custom_actions.txt';

const sample = (over: Partial<CustomAction> = {}): CustomAction => ({
  id: 'file-0',
  label: 'Glossary',
  icon: '1',
  prompt: 'Define key terms on this page.',
  ...over,
});

function render(
  over: Partial<React.ComponentProps<typeof CustomActionsSettings>> = {},
) {
  const onReload = jest.fn<Promise<void>, []>(async () => {});
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <CustomActionsSettings
        actions={[]}
        filePath={PATH}
        onReload={onReload}
        {...over}
      />,
    );
  });
  return {tree, onReload};
}

describe('CustomActionsSettings — empty state', () => {
  it('shows the missing-file hint when no actions parsed', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'custom-actions-empty')).toBeDefined();
    expect(textOf(tree, 'custom-actions-empty')).toContain(
      'No custom actions parsed',
    );
  });

  it('renders the file path so the user knows where to edit', () => {
    const {tree} = render();
    expect(textOf(tree, 'custom-actions-path')).toBe(PATH);
  });
});

describe('CustomActionsSettings — populated state', () => {
  it('renders one row per parsed action', () => {
    const actions = [
      sample({id: 'file-0', icon: '1', label: 'Glossary'}),
      sample({id: 'file-1', icon: '2', label: 'Risks', prompt: 'List risks.'}),
    ];
    const {tree} = render({actions});
    expect(findByTestID(tree, 'custom-action-preview-file-0')).toBeDefined();
    expect(findByTestID(tree, 'custom-action-preview-file-1')).toBeDefined();
    // The empty-state hint is gone when at least one action exists.
    expect(maybeFindByTestID(tree, 'custom-actions-empty')).toBeNull();
  });
});

describe('CustomActionsSettings — Reload', () => {
  it('invokes onReload when tapped', async () => {
    const {tree, onReload} = render();
    await act(async () => {
      findByTestID(tree, 'custom-actions-reload').props.onPress();
      await Promise.resolve();
    });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('disables while a reload is in flight', async () => {
    let resolveOuter: () => void = () => {};
    const slow = jest.fn<Promise<void>, []>(
      () =>
        new Promise<void>((res) => {
          resolveOuter = res;
        }),
    );
    const {tree} = render({onReload: slow});
    act(() => {
      findByTestID(tree, 'custom-actions-reload').props.onPress();
    });
    expect(findByTestID(tree, 'custom-actions-reload').props.disabled).toBe(
      true,
    );
    // Second tap while the first is pending — no-op (busy guard).
    act(() => {
      findByTestID(tree, 'custom-actions-reload').props.onPress();
    });
    expect(slow).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveOuter();
      await Promise.resolve();
    });
  });
});
