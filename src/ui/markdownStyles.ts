// Per-element styles for react-native-markdown-display. The renderer
// accepts a flat record keyed by markdown element name. Multiplying
// each font size by `scale` lets the user-controlled font selector
// flow through every block-level element. Tables are excluded
// because the system prompt forbids them.

export const buildMarkdownStyles = (
  scale: number,
): Record<string, Record<string, unknown>> => ({
  body: {fontSize: 17 * scale, color: '#000000'},
  paragraph: {fontSize: 17 * scale, marginTop: 0, marginBottom: 6 * scale},
  heading1: {fontSize: 24 * scale, fontWeight: '700', marginTop: 4, marginBottom: 4},
  heading2: {fontSize: 21 * scale, fontWeight: '700', marginTop: 4, marginBottom: 4},
  heading3: {fontSize: 19 * scale, fontWeight: '700', marginTop: 4, marginBottom: 4},
  heading4: {fontSize: 17 * scale, fontWeight: '700', marginTop: 4, marginBottom: 4},
  strong: {fontWeight: '700'},
  em: {fontStyle: 'italic'},
  bullet_list: {marginTop: 0, marginBottom: 6},
  ordered_list: {marginTop: 0, marginBottom: 6},
  list_item: {fontSize: 17 * scale, marginBottom: 2},
  code_inline: {
    fontFamily: 'monospace',
    fontSize: 16 * scale,
    backgroundColor: '#EEEEEE',
    paddingHorizontal: 4,
  },
  code_block: {
    fontFamily: 'monospace',
    fontSize: 15 * scale,
    backgroundColor: '#EEEEEE',
    padding: 6,
    borderRadius: 4,
  },
  fence: {
    fontFamily: 'monospace',
    fontSize: 15 * scale,
    backgroundColor: '#EEEEEE',
    padding: 6,
    borderRadius: 4,
  },
});
