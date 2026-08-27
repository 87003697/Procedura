/**
 * Inline <think>…</think> handling.
 *
 * Some models stream their reasoning INLINE inside the content channel wrapped
 * in `<think>…</think>` tags, rather than via a separate reasoning field
 * (e.g. some GPT models behind an OpenAI-compatible proxy: `reasoning_content` is absent and
 * the thinking shows up as `<think>…</think>` at the head of `content`).
 *
 * Left in place, that text pollutes everything that PARSES the content — the
 * SCAD extractor would treat `<think>` as part of the source, the critic's
 * diagnosis would be prefixed with a reasoning dump, etc.
 *
 * `splitThinkTags` pulls those blocks out of an assistant message: it returns
 * the cleaned text plus the extracted think content, so callers can feed the
 * clean text to their parser and route the think content to the reasoning
 * channel (where it lands in thinking.txt, same as a native reasoning model).
 */

/** Strip `<think>…</think>` blocks out of `content`. Returns the cleaned text
 *  and the concatenated think content. Handles a dangling unclosed `<think>`
 *  (e.g. a truncated stream) by treating everything after it as think. */
export function splitThinkTags(content: string): { text: string; think: string } {
  if (!content) return { text: "", think: "" };
  const thinks: string[] = [];

  let text = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    thinks.push(inner.trim());
    return "";
  });

  // Dangling, unclosed <think> (stream cut off, or the model never closed it).
  const open = text.search(/<think>/i);
  if (open !== -1) {
    thinks.push(text.slice(open + "<think>".length).trim());
    text = text.slice(0, open);
  }

  return { text: text.trim(), think: thinks.filter(Boolean).join("\n\n") };
}
