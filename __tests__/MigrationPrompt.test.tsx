/**
 * Tests for src/ui/MigrationPrompt. Pins:
 *   1. Renders detected file paths.
 *   2. The three buttons fire the right callbacks.
 *   3. Pluralisation handles 1 vs N files.
 */
import React from 'react';
import {act, create} from 'react-test-renderer';
import MigrationPrompt from '../src/ui/MigrationPrompt';
import {findByTestID, findAllText} from './helpers/textTraversal';

const render = (
  overrides: Partial<React.ComponentProps<typeof MigrationPrompt>> = {},
) => {
  const props: React.ComponentProps<typeof MigrationPrompt> = {
    detectedFiles: ['/MyStyle/SnCopilot/copilot-key-anthropic.txt'],
    onEncrypt: jest.fn(),
    onKeepPlaintext: jest.fn(),
    onDecideLater: jest.fn(),
    ...overrides,
  };
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<MigrationPrompt {...props} />);
  });
  return {tree, props};
};

describe('MigrationPrompt — rendering', () => {
  it('lists each detected file path', () => {
    const {tree} = render({
      detectedFiles: [
        '/MyStyle/SnCopilot/copilot-key-anthropic.txt',
        '/MyStyle/SnCopilot/copilot-key-openai.txt',
      ],
    });
    const text = findAllText(tree).join(' | ');
    expect(text).toContain('copilot-key-anthropic.txt');
    expect(text).toContain('copilot-key-openai.txt');
    // Plural "key files" wording.
    expect(text).toContain('key files');
  });

  it('uses singular "a key file" when there is just one', () => {
    const {tree} = render({
      detectedFiles: ['/MyStyle/SnCopilot/copilot-key-deepseek.txt'],
    });
    expect(findAllText(tree).join(' | ')).toContain('a key file');
  });
});

describe('MigrationPrompt — actions', () => {
  it('fires onEncrypt', () => {
    const {tree, props} = render();
    act(() => {
      findByTestID(tree, 'migration-encrypt').props.onPress();
    });
    expect(props.onEncrypt).toHaveBeenCalledTimes(1);
  });

  it('fires onKeepPlaintext', () => {
    const {tree, props} = render();
    act(() => {
      findByTestID(tree, 'migration-keep-plaintext').props.onPress();
    });
    expect(props.onKeepPlaintext).toHaveBeenCalledTimes(1);
  });

  it('fires onDecideLater', () => {
    const {tree, props} = render();
    act(() => {
      findByTestID(tree, 'migration-decide-later').props.onPress();
    });
    expect(props.onDecideLater).toHaveBeenCalledTimes(1);
  });
});
