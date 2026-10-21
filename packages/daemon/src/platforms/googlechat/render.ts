// Google Chat's Markdown renderer and byte-budget splitter (google-chat-integration.md §5).
import { closesFence, FENCE, splitMarkdownByBytes } from '../../messages/split-markdown-bytes.js'

/** Google's hard cap on one message, text and metadata together (§5). */
export const GOOGLE_CHAT_MESSAGE_MAX_BYTES = 32_000
/** The text budget per message: the cap less headroom for the JSON envelope, the id and the thread coordinate. */
export const GOOGLE_CHAT_TEXT_BUDGET_BYTES = 30_000

const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-{3,})[ \t]*$/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const TASK_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s)/

/** Render for `MARKUP_SYNTAX_MARKDOWN`: the supported subset passes through; a heading becomes bold, an image its link, a table a monospace block, a rule a blank line, a task box a glyph. */
export function renderGoogleChatMarkdown(markdown: string): string {
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
    // A pipe table: columns only line up in monospace, so the whole run becomes one fenced block.
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      let end = i + 2
      while (end < lines.length && TABLE_ROW.test(lines[end]!)) end += 1
      out.push('```', ...lines.slice(i, end).map((row) => row.trim()), '```')
      i = end - 1
      continue
    }
    const heading = ATX_HEADING.exec(line)
    if (heading) {
      const title = (heading[1] ?? '').trim()
      out.push(title ? `**${title}**` : '')
      continue
    }
    const next = lines[i + 1]
    if (next !== undefined && SETEXT_UNDERLINE.test(next) && line.trim() && !LIST_ITEM.test(line)) {
      out.push(`**${line.trim()}**`)
      i += 1
      continue
    }
    if (THEMATIC_BREAK.test(line)) {
      out.push('')
      continue
    }
    out.push(
      line
        .replace(IMAGE, (_m, alt: string, url: string) => `[${alt.trim() || 'image'}](${url})`)
        .replace(TASK_ITEM, (_m, prefix: string, mark: string) => `${prefix}${mark === ' ' ? '☐' : '☑'}`)
    )
  }
  return out.join('\n')
}

/** Split into messages within `budgetBytes` of UTF-8 (see {@link splitMarkdownByBytes}). */
export function splitGoogleChatText(text: string, budgetBytes = GOOGLE_CHAT_TEXT_BUDGET_BYTES): string[] {
  return splitMarkdownByBytes(text, budgetBytes)
}
