/**
 * Last-mile Slack formatting (§9.1 / §9.3). One pure helper:
 *  - splitIntoSections: break a message into <= maxLen sections.
 *
 * The chunking algorithm itself is platform-neutral and lives in
 * messages/split-sections.ts; this module supplies the Slack-specific parts — the block
 * limit, which spans are indivisible, and the error raised when one cannot fit.
 *
 * The daemon posts the agent's reply as a Block Kit `markdown` block (which renders
 * standard CommonMark natively), so NO markdown→mrkdwn conversion happens here — the
 * agent's text is sent verbatim. We only chunk it: a single `markdown` block caps at
 * 12000 chars, so a long body is split across blocks/messages on line boundaries.
 */

import { splitIntoSections as splitTextIntoSections } from '../messages/split-sections.js'

/** Slack `markdown` block hard cap (12000 chars per block). */
export const SLACK_MARKDOWN_BLOCK_LIMIT = 12000

/**
 * Every platform-native address Slack encodes as one indivisible token: a user or bot
 * mention (`<@U123>` / `<@U123|label>`), a user group (`<!subteam^S1|@team>`), and the
 * special broadcast addresses (`<!here>`, `<!channel>`, `<!everyone>`).
 *
 * Cutting inside one of these does not degrade gracefully — half a mention renders as
 * literal `<@U12` text, so the addressee is never notified AND the message displays
 * broken markup. Since send-message-routing-rework.md §2.1 makes an ordinary reply with
 * an explicit mention THE way an agent addresses a peer or human in its current thread,
 * a cut mention now silently drops a delivery, not just a notification.
 */
const SLACK_ADDRESS_RE = /<[@!#][^>]*>/g

/**
 * Character spans that a section boundary must not fall inside
 * (send-message-routing-rework.md §5.3).
 *
 * Two sources, because Slack has two address shapes:
 *  - every `<…>` platform address, which is self-delimiting and found by scanning; and
 *  - `extraAddresses`, exact strings the CALLER rendered and knows are one logical
 *    address even though the platform does not — specifically a shared Slack bot's
 *    `<@U_SHARED> reviewer`, where the bot user id alone cannot identify an agent and
 *    the trailing slug is what selects it. The splitter cannot infer that pairing (the
 *    slug is ordinary text), so the sender passes the addresses it built.
 *
 * Returned sorted by start, non-overlapping — a later span that starts inside an
 * accepted one is dropped, so `<@U_SHARED>` nested in `<@U_SHARED> reviewer` cannot
 * produce a boundary in the middle of the longer address.
 */
function protectedSpans(text: string, extraAddresses: readonly string[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  for (const match of text.matchAll(SLACK_ADDRESS_RE)) {
    spans.push({ start: match.index, end: match.index + match[0].length })
  }
  for (const address of extraAddresses) {
    if (!address) continue
    for (let at = text.indexOf(address); at >= 0; at = text.indexOf(address, at + 1)) {
      spans.push({ start: at, end: at + address.length })
    }
  }
  // Longest-first at equal starts, so the wider address wins the overlap filter below.
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: { start: number; end: number }[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start < last.end) {
      // Overlapping addresses are one indivisible region: extend rather than drop, so a
      // boundary can never land in the gap between two overlapping spans either.
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

/** Thrown when one protected address is itself longer than a section can hold. §5.3:
 *  delivery FAILS rather than publishing a broken address — a truncated mention would
 *  drop the delivery it was supposed to make, silently. */
export class UnsplittableAddressError extends Error {
  constructor(readonly address: string) {
    super(`slack: mention address (${address.length} chars) exceeds one message and cannot be split`)
    this.name = 'UnsplittableAddressError'
  }
}

/**
 * Split text into sections no longer than maxLen, preferring line boundaries;
 * a single line longer than maxLen is hard-cut. Whitespace-only input yields no
 * sections. Content is never lost across sections — `sections.join('')` reproduces the
 * input byte for byte, including boundary newlines and the whitespace around a mention.
 *
 * A boundary that would fall INSIDE a platform address (or a caller-supplied shared-bot
 * address) is moved back to the start of that address, so the following section begins
 * with the complete token (§5.3). Moving back can only shorten a section, never grow one
 * past `maxLen`. Throws {@link UnsplittableAddressError} if a single address cannot fit.
 */
export function splitIntoSections(
  text: string,
  maxLen = SLACK_MARKDOWN_BLOCK_LIMIT,
  extraAddresses: readonly string[] = []
): string[] {
  return splitTextIntoSections(text, maxLen, {
    protectedSpans: protectedSpans(text, extraAddresses),
    unsplittable: (address) => new UnsplittableAddressError(address)
  })
}
