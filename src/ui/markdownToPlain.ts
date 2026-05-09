// Converts the LLM's markdown source into plain text suitable for
// the system clipboard. The on-screen Markdown component renders the
// same source as proper headings, bullets, and bold; pasting into a
// plain-text target would otherwise dump the raw `###`, `-`, `**`
// syntax.
//
// Scope: every markdown construct our system prompt asks the LLM to
// produce — headings, bullet/numbered lists, bold, italic, inline
// code, fenced code blocks, links, blockquotes, strikethrough,
// horizontal rules. Tables and HTML embeds are out of scope because
// the system prompt forbids them and LLMs rarely emit them.
//
// Pure function — no React, no SDK, no IO.

export const markdownToPlainText = (md: string): string => {
  if (md.length === 0) {
    return '';
  }
  let text = md;

  // 1. Fenced code blocks — keep the inner content, drop the ``` lines
  //    and any optional language tag. The inner text is preserved
  //    verbatim, so multi-line code stays multi-line on the clipboard.
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => code);

  // 2. Inline code — `x` → x.
  text = text.replace(/`([^`]+)`/g, '$1');

  // 3. Strikethrough — ~~x~~ → x.
  text = text.replace(/~~(.+?)~~/g, '$1');

  // 4. Bold — **x** or __x__ → x. Run BEFORE italic so the inner
  //    `*x*` left over after a `**x**` strip doesn't get mistaken
  //    for italic.
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');

  // 5. Italic — *x* → x. We deliberately don't touch underscore-
  //    italic (`_x_`) because it collides with snake_case
  //    identifiers; LLMs prefer `*` for emphasis anyway.
  text = text.replace(/\*([^*\n]+)\*/g, '$1');

  // 6. Headings — strip leading #s and any trailing #s. Multi-line
  //    flag so each line is processed independently.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '$1');

  // 7. Blockquotes — `> x` → `x`.
  text = text.replace(/^[ \t]*>[ \t]?/gm, '');

  // 8. Bullet lists — `-` / `*` / `+` markers replaced with the
  //    Unicode bullet so plain-text paste destinations show a real
  //    bullet glyph instead of a dash. Indentation preserved.
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');

  // 9. Links — `[text](url)` → `text`. Reference-style links
  //    `[text][id]` are rare from LLMs; not handled.
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 10. Horizontal rules — `---`, `***`, `___` on their own line.
  text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '');

  // 11. Collapse 3+ consecutive newlines to 2 (single blank line).
  //     This cleans up after horizontal-rule removal which may
  //     leave consecutive blank lines.
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
};
