/** Last-mile Slack formatting: split a reply into `markdown` blocks and rewrite the pipe tables such a block drops. */

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

/** Split on line boundaries into sections that fit `maxLen` once rendered, never inside an address; `join('')` is the input. */
export function splitIntoSections(
  text: string,
  maxLen = SLACK_MARKDOWN_BLOCK_LIMIT,
  extraAddresses: readonly string[] = []
): string[] {
  return splitFitting(text, maxLen, maxLen, extraAddresses)
}

/** Split at `cap`, halving it for any section whose rendered tables outgrow `maxLen`. */
function splitFitting(text: string, maxLen: number, cap: number, extraAddresses: readonly string[]): string[] {
  const sections = splitTextIntoSections(text, cap, {
    protectedSpans: protectedSpans(text, extraAddresses),
    unsplittable: (address) => new UnsplittableAddressError(address)
  })
  return sections.flatMap((section) =>
    cap > 1 && renderTablesForSlack(section).length > maxLen
      ? splitFitting(section, maxLen, Math.floor(cap / 2), extraAddresses)
      : [section]
  )
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** Does `line` close the fence opened by `marker`: same character, at least as long, alone on its line. */
function closesFence(line: string, marker: string): boolean {
  const [, run = '', rest = ''] = FENCE.exec(line) ?? []
  return run !== '' && run[0] === marker[0] && run.length >= marker.length && !rest.trim()
}

/** A row's cells, split on unescaped pipes, with `\|` unescaped as GFM does. */
function tableCells(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'))
}

/** Can `line` open a table: a piped row, not indented code or a quote. */
function isTableRow(line: string): boolean {
  return line.includes('|') && /^ {0,3}[^ >]/.test(line)
}

/** One data row as a list item labelled by its headers; empty cells are left out. */
function tableItem(indent: string, headers: string[], cells: string[]): string | undefined {
  const pairs = cells.flatMap((cell, i) => {
    if (!cell) return []
    const name = (headers[i] ?? '').replaceAll('**', '').replace(/:$/, '').trim()
    return [name ? `**${name}:** ${cell}` : cell]
  })
  return pairs.length > 0 ? `${indent}- ${pairs.join(' · ')}` : undefined
}

/** Rewrite GFM tables outside fences (a `markdown` block drops them): each row becomes `- **Header:** cell · **Header:** cell`. */
export function renderTablesForSlack(markdown: string, style: 'list' | 'code' = 'list'): string {
  if (!markdown.includes('|')) return markdown
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: string | undefined
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (fence) {
      out.push(line)
      if (closesFence(line, fence)) fence = undefined
      continue
    }
    const opening = FENCE.exec(line)
    if (opening) {
      fence = opening[1]!
      out.push(line)
      continue
    }
    const delimiter = lines[i + 1] ?? ''
    const headers = isTableRow(line) && TABLE_DELIMITER.test(delimiter) ? tableCells(line) : undefined
    if (!headers || !delimiter.includes('|') || tableCells(delimiter).length !== headers.length) {
      out.push(line)
      continue
    }
    const indent = /^ */.exec(line)![0]
    let end = i + 2
    while (end < lines.length && lines[end]!.trim() && isTableRow(lines[end]!) && !FENCE.test(lines[end]!)) end += 1
    const rows =
      style === 'code'
        ? ['```', ...lines.slice(i, end).map((row) => row.trim()), '```']
        : lines.slice(i + 2, end).flatMap((row) => tableItem(indent, headers, tableCells(row)) ?? [])
    // A header-only table still says something: its names, as one item.
    if (rows.length === 0 && headers.some(Boolean)) rows.push(`${indent}- ${headers.filter(Boolean).join(' · ')}`)
    if (out.length > 0 && out.at(-1)!.trim()) out.push('')
    out.push(...rows)
    if (end < lines.length && lines[end]!.trim()) out.push('')
    i = end - 1
  }
  return out.join('\n')
}

/** A `markdown` block's text: tables as list items, else as verbatim code when that alone fits the block, else unchanged. */
export function slackMarkdownBlockText(markdown: string): string {
  const listed = renderTablesForSlack(markdown)
  if (listed.length <= SLACK_MARKDOWN_BLOCK_LIMIT) return listed
  const coded = renderTablesForSlack(markdown, 'code')
  return coded.length <= SLACK_MARKDOWN_BLOCK_LIMIT ? coded : markdown
}
