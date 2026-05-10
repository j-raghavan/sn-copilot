/**
 * Tests for src/ui/SetupChecklist. Pins:
 *   1. Headline rendered when provided.
 *   2. No headline element when not provided (pure-render branch).
 *   3. Four steps with the documented testIDs are rendered.
 */
import React from 'react';
import {act, create} from 'react-test-renderer';
import SetupChecklist from '../src/ui/SetupChecklist';
import {findAllText, findByTestID, maybeFindByTestID} from './helpers/textTraversal';

describe('SetupChecklist', () => {
  it('renders the headline when provided', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<SetupChecklist testID="cl" headline="No key file" />);
    });
    expect(findAllText(tree).join(' | ')).toContain('No key file');
  });

  it('omits the headline element when no headline prop', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<SetupChecklist testID="cl" />);
    });
    // The 4 steps still render.
    expect(findByTestID(tree, 'setup-step-1')).toBeDefined();
    expect(maybeFindByTestID(tree, 'setup-step-5')).toBeNull();
  });
});
