// Resolving a WeChat quote that names its message by id only (wechat-integration.md §4.3).
import { createHash } from 'node:crypto'
import type { WeChatPartialQuote } from '@agentconnect.md/message'

/** What the agent reads when the quoted message is older than this connection's record. */
export const WECHAT_QUOTE_UNAVAILABLE = '[quoted message is no longer available]'

// The start of the `index`-th (0-based) occurrence of `needle` at or after `from`; -1 when there is none.
function nth(text: string, needle: string, index: number, from = 0): number {
  let at = from - 1
  for (let i = 0; i <= index; i++) {
    at = text.indexOf(needle, at + 1)
    if (at < 0) return -1
  }
  return at
}

/** The selected part of `text`, verified by its MD5 when the quote carries one; undefined when it cannot be found. */
export function resolveWeChatPartial(text: string, partial: WeChatPartialQuote): string | undefined {
  const { start, end, startindex, endindex, quotemd5 } = partial
  if (!text || !start || !end || !Number.isInteger(startindex) || !Number.isInteger(endindex)) return undefined
  const from = nth(text, start, startindex!)
  if (from < 0) return undefined
  // Clients count the end occurrence either from the top of the text or from the start match, so both are tried.
  const candidates = [nth(text, end, endindex!), nth(text, end, endindex!, from)]
    .filter((to) => to >= from)
    .map((to) => text.slice(from, to + end.length))
  if (!quotemd5) return candidates[0]
  const want = quotemd5.toLowerCase()
  return candidates.find((c) => createHash('md5').update(c, 'utf8').digest('hex') === want)
}
