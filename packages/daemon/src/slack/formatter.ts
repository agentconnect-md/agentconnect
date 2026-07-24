/**
 * Last-mile Slack formatting (§9.1 / §9.3). One pure helper:
 *  - splitIntoSections: break a message into <= maxLen sections.
 *
 * The daemon posts the agent's reply as a Block Kit `markdown` block (which renders
 * standard CommonMark natively), so NO markdown→mrkdwn conversion happens here — the
 * agent's text is sent verbatim. We only chunk it: a single `markdown` block caps at
 * 12000 chars, so a long body is split across blocks/messages on line boundaries.
 */

/** Slack `markdown` block hard cap (12000 chars per block). */
export const SLACK_MARKDOWN_BLOCK_LIMIT = 12000

/**
 * Split text into sections no longer than maxLen, preferring line boundaries;
 * a single line longer than maxLen is hard-cut. Whitespace-only input yields no
 * sections. Content is never lost across sections.
 */
export function splitIntoSections(text: string, maxLen = SLACK_MARKDOWN_BLOCK_LIMIT): string[] {
  if (!text.trim()) return []
  if (text.length <= maxLen) return [text]
  const sections: string[] = []
  let remaining = text
  while (remaining.length > maxLen) {
    // Prefer ending immediately after the last newline that fits. If none fits (an
    // overlong line, or a newline exactly at maxLen), hard-cut at the limit. Slicing
    // the original string rather than reconstructing lines guarantees join('') is
    // byte-for-byte identical to the input, including boundary newlines.
    const newline = remaining.lastIndexOf('\n', maxLen - 1)
    const end = newline >= 0 ? newline + 1 : maxLen
    sections.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  if (remaining) sections.push(remaining)
  return sections
}
