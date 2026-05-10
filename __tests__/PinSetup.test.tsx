/**
 * Tests for src/ui/PinSetup. Pins:
 *   1. Submit disabled until both inputs match a valid PIN.
 *   2. Validation message: short PIN, non-digit PIN, mismatched confirm.
 *   3. Mode toggle switches validation rules (pin → passphrase).
 *   4. Show toggle flips secureTextEntry on both inputs.
 *   5. Submit calls onSubmit with the entered secret; double-tap is a no-op.
 *   6. Cancel button only renders when onCancel is provided.
 *   7. "create" intent shows the no-recovery warning; "change" doesn't.
 */
import React from 'react';
import {act, create, ReactTestRenderer} from 'react-test-renderer';
import PinSetup from '../src/ui/PinSetup';
import {findAllText, findByTestID, maybeFindByTestID} from './helpers/textTraversal';

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

const render = (
  overrides: Partial<React.ComponentProps<typeof PinSetup>> = {},
): {tree: ReactTestRenderer; props: React.ComponentProps<typeof PinSetup>} => {
  const props: React.ComponentProps<typeof PinSetup> = {
    intent: 'create',
    onSubmit: jest.fn(),
    ...overrides,
  };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<PinSetup {...props} />);
  });
  return {tree, props};
};

const setText = (tree: ReactTestRenderer, testID: string, text: string) => {
  act(() => {
    findByTestID(tree, testID).props.onChangeText(text);
  });
};

describe('PinSetup — initial render', () => {
  it('shows the no-recovery warning in create intent', () => {
    const {tree} = render({intent: 'create'});
    expect(findAllText(tree).join(' | ')).toContain('no recovery');
  });

  it('hides the no-recovery warning in change intent', () => {
    const {tree} = render({intent: 'change'});
    expect(findAllText(tree).join(' | ')).not.toContain('no recovery');
  });

  it('renders a Cancel button only when onCancel is provided', () => {
    const {tree: t1} = render();
    expect(maybeFindByTestID(t1, 'pin-cancel')).toBeNull();
    const {tree: t2} = render({onCancel: jest.fn()});
    expect(maybeFindByTestID(t2, 'pin-cancel')).not.toBeNull();
  });
});

describe('PinSetup — validation', () => {
  it('submit disabled with empty input', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'pin-submit').props.disabled).toBe(true);
  });

  it('flags short PIN', () => {
    const {tree} = render();
    setText(tree, 'pin-input-primary', '123');
    setText(tree, 'pin-input-confirm', '123');
    expect(findByTestID(tree, 'pin-validation-message')).toBeDefined();
    expect(findByTestID(tree, 'pin-submit').props.disabled).toBe(true);
  });

  it('flags non-digit PIN in PIN mode', () => {
    const {tree} = render();
    setText(tree, 'pin-input-primary', 'abcdef');
    setText(tree, 'pin-input-confirm', 'abcdef');
    expect(
      findAllText(tree).join(' | '),
    ).toContain('PIN must contain digits only');
  });

  it('flags mismatched confirm', () => {
    const {tree} = render();
    setText(tree, 'pin-input-primary', '123456');
    setText(tree, 'pin-input-confirm', '654321');
    expect(findAllText(tree).join(' | ')).toContain('do not match');
    expect(findByTestID(tree, 'pin-submit').props.disabled).toBe(true);
  });

  it('flags PIN longer than 12 digits', () => {
    const {tree} = render();
    setText(tree, 'pin-input-primary', '1234567890123');
    setText(tree, 'pin-input-confirm', '1234567890123');
    expect(findAllText(tree).join(' | ')).toContain('at most 12 digits');
  });

  it('enables submit when valid PIN matches confirm', () => {
    const {tree} = render();
    setText(tree, 'pin-input-primary', '987654');
    setText(tree, 'pin-input-confirm', '987654');
    expect(findByTestID(tree, 'pin-submit').props.disabled).toBe(false);
  });

  it('passphrase mode: requires ≥ 12 chars', () => {
    const {tree} = render({initialMode: 'passphrase'});
    setText(tree, 'pin-input-primary', 'short');
    setText(tree, 'pin-input-confirm', 'short');
    expect(
      findAllText(tree).join(' | '),
    ).toContain('Passphrase must be at least 12 characters');
  });

  it('passphrase mode: accepts any chars', () => {
    const {tree} = render({initialMode: 'passphrase'});
    setText(tree, 'pin-input-primary', 'correct horse battery staple');
    setText(tree, 'pin-input-confirm', 'correct horse battery staple');
    expect(findByTestID(tree, 'pin-submit').props.disabled).toBe(false);
  });
});

describe('PinSetup — mode toggle', () => {
  it('clears inputs on mode switch', () => {
    const {tree} = render();
    setText(tree, 'pin-input-primary', '123456');
    setText(tree, 'pin-input-confirm', '123456');
    act(() => {
      findByTestID(tree, 'pin-mode-passphrase').props.onPress();
    });
    expect(findByTestID(tree, 'pin-input-primary').props.value).toBe('');
    expect(findByTestID(tree, 'pin-input-confirm').props.value).toBe('');
  });

  it('switching back from passphrase to PIN also clears inputs', () => {
    const {tree} = render({initialMode: 'passphrase'});
    setText(tree, 'pin-input-primary', 'long enough passphrase');
    setText(tree, 'pin-input-confirm', 'long enough passphrase');
    act(() => {
      findByTestID(tree, 'pin-mode-pin').props.onPress();
    });
    expect(findByTestID(tree, 'pin-input-primary').props.value).toBe('');
    expect(findByTestID(tree, 'pin-input-confirm').props.value).toBe('');
  });
});

describe('PinSetup — show toggle', () => {
  it('flips secureTextEntry on both inputs', () => {
    const {tree} = render();
    expect(findByTestID(tree, 'pin-input-primary').props.secureTextEntry).toBe(true);
    expect(findByTestID(tree, 'pin-input-confirm').props.secureTextEntry).toBe(true);
    act(() => {
      findByTestID(tree, 'pin-toggle-show').props.onPress();
    });
    expect(findByTestID(tree, 'pin-input-primary').props.secureTextEntry).toBe(false);
    expect(findByTestID(tree, 'pin-input-confirm').props.secureTextEntry).toBe(false);
  });
});

describe('PinSetup — submit', () => {
  it('calls onSubmit with the entered secret on tap', async () => {
    const onSubmit = jest.fn();
    const {tree} = render({onSubmit});
    setText(tree, 'pin-input-primary', '123456');
    setText(tree, 'pin-input-confirm', '123456');
    await act(async () => {
      findByTestID(tree, 'pin-submit').props.onPress();
      await flushPromises();
    });
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  it('blocks double-tap by setting submitting=true', async () => {
    let resolveSubmit!: () => void;
    const onSubmit = jest.fn(
      () =>
        new Promise<void>((res) => {
          resolveSubmit = res;
        }),
    );
    const {tree} = render({onSubmit});
    setText(tree, 'pin-input-primary', '123456');
    setText(tree, 'pin-input-confirm', '123456');
    act(() => {
      findByTestID(tree, 'pin-submit').props.onPress();
    });
    act(() => {
      findByTestID(tree, 'pin-submit').props.onPress();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSubmit();
      await flushPromises();
    });
  });

  it('cancel button calls onCancel', () => {
    const onCancel = jest.fn();
    const {tree} = render({onCancel});
    act(() => {
      findByTestID(tree, 'pin-cancel').props.onPress();
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
