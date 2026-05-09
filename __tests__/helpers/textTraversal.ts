/**
 * Shared test helpers for walking react-test-renderer trees.
 *
 * Why this exists: a `<Text>Scope: {label}</Text>` renders to a host
 * Text node whose `children` array is two separate fragments
 * (`"Scope: "` and the value of `label`). Naive helpers that just
 * `.flatMap(n => n.children)` lose the within-Text concatenation,
 * which made several PanelView / ResultView / SettingsView tests
 * fail with phantom separators ("Scope: | Current Page" instead of
 * "Scope: Current Page").
 *
 * `textOf` and `findAllText` here concatenate WITHIN each Text node
 * before returning, so substring assertions work as expected.
 */
import type {ReactTestInstance, ReactTestRenderer} from 'react-test-renderer';

const collectStrings = (node: unknown): string => {
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectStrings).join('');
  }
  if (
    node &&
    typeof node === 'object' &&
    'children' in node &&
    Array.isArray((node as ReactTestInstance).children)
  ) {
    return collectStrings((node as ReactTestInstance).children);
  }
  return '';
};

export function findByTestID(
  tree: ReactTestRenderer,
  testID: string,
): ReactTestInstance {
  return tree.root.findByProps({testID});
}

export function maybeFindByTestID(
  tree: ReactTestRenderer,
  testID: string,
): ReactTestInstance | null {
  const matches = tree.root.findAllByProps({testID});
  return matches.length > 0 ? matches[0] : null;
}

/** Concatenated text inside the subtree rooted at `testID`. */
export function textOf(tree: ReactTestRenderer, testID: string): string {
  return collectStrings(findByTestID(tree, testID));
}

/**
 * One concatenated string per `<Text>` host element in the tree.
 * Use `.join(' | ')` (or any separator) to test for substrings
 * across the panel without losing intra-Text content.
 */
export function findAllText(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll(n => (n.type as unknown as string) === 'Text', {deep: true})
    .map(n => collectStrings(n));
}

/**
 * Press the (host) element with the given testID and an `onPress`
 * handler. Necessary when a function component (like Toggle) forwards
 * its testID to a host child (like Pressable): findByProps then
 * matches both, with the FC instance returned first — its props
 * have no onPress, only the host child does.
 */
export function pressByTestID(
  tree: ReactTestRenderer,
  testID: string,
): void {
  const matches = tree.root.findAllByProps({testID});
  const pressable = matches.find(
    m => typeof (m.props as {onPress?: unknown}).onPress === 'function',
  );
  if (!pressable) {
    throw new Error(
      `pressByTestID: no element with testID="${testID}" has an onPress`,
    );
  }
  (pressable.props as {onPress: () => void}).onPress();
}
