/** Last-mile Slack formatting: split verbatim Markdown without breaking mention addresses. */

import { splitIntoSections as splitTextIntoSections } from '../messages/split-sections.js'

/** Slack caps the combined text of a payload's `markdown` blocks at 12,000 characters. */
export const SLACK_MARKDOWN_BLOCK_LIMIT = 12000

/** Native mentions, user groups, broadcasts, and channel links must stay whole to preserve delivery. */
const SLACK_ADDRESS_RE = /<[@!#][^>]*>/g

/** Merge native addresses and caller-supplied shared-bot addresses into indivisible spans (§5.3). */
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
      // Merge overlapping addresses so no boundary can fall inside either one.
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

/** Fail delivery when an address cannot fit, rather than silently sending a broken mention (§5.3). */
export class UnsplittableAddressError extends Error {
  constructor(readonly address: string) {
    super(`slack: mention address (${address.length} chars) exceeds one message and cannot be split`)
    this.name = 'UnsplittableAddressError'
  }
}

/** Split on line boundaries within `maxLen`, never inside an address; `join('')` reproduces the input. */
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
