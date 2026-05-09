// Manual mock — react-native-markdown-display ships ESM that jest's
// default babel preset won't transform. Tests don't care about the
// rendered HTML/Text tree (we test the chat state machine, not the
// markdown layout); a passthrough Text is plenty.
import React from 'react';
import {Text} from 'react-native';

const Markdown = ({children}: {children: React.ReactNode}): React.JSX.Element => (
  <Text>{children}</Text>
);

export default Markdown;
