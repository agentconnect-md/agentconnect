// Google Chat's Markdown renderer and byte-budget splitter (google-chat-integration.md §5).

/** Google's hard cap on one message, text and metadata together (§5). */
export const GOOGLE_CHAT_MESSAGE_MAX_BYTES = 32_000
/** The text budget per message: the cap less headroom for the JSON envelope, the id and the thread coordinate. */
export const GOOGLE_CHAT_TEXT_BUDGET_BYTES = 30_000

/** Opening/closing CommonMark fence: up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-{3,})[ \t]*$/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const TASK_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s)/

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Does `line` close the fence opened by `marker`: same character, at least as long, alone on its line. */
function closesFence(line: string, marker: string): boolean {
  const [, run = '', rest = ''] = FENCE.exec(line) ?? []
  return run !== '' && run[0] === marker[0] && run.length >= marker.length && !rest.trim()
}

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

/** Cut one line into pieces of at most `maxBytes` UTF-8 bytes, never inside a code point. */
function hardCut(line: string, maxBytes: number): string[] {
  if (utf8Bytes(line) <= maxBytes) return [line]
  const pieces: string[] = []
  let piece = ''
  let pieceBytes = 0
  for (const ch of line) {
    const bytes = utf8Bytes(ch)
    if (piece && pieceBytes + bytes > maxBytes) {
      pieces.push(piece)
      piece = ''
      pieceBytes = 0
    }
    piece += ch
    pieceBytes += bytes
  }
  if (piece) pieces.push(piece)
  return pieces
}

/** Split into messages within `budgetBytes` of UTF-8: at a paragraph break outside a fence, else at a line break with the fence closed and reopened, else inside an overlong line at a code point. */
export function splitGoogleChatText(text: string, budgetBytes = GOOGLE_CHAT_TEXT_BUDGET_BYTES): string[] {
  const body = text.replace(/\s+$/, '')
  if (!body.trim()) return []
  if (utf8Bytes(body) <= budgetBytes) return [body]
  const segments: string[] = []
  let current: string[] = []
  let currentBytes = 0
  let fence: string | undefined
  let fenceLine = ''
  // Index into `current` just past the last blank line outside a fence — a cut the reader can see.
  let paragraphCut = 0
  const emit = (lines: string[]): void => {
    const segment = lines.join('\n').replace(/\s+$/, '')
    if (segment.trim()) segments.push(segment)
  }
  const closeOf = (marker: string): string => marker
  for (const rawLine of body.split('\n')) {
    const reopenBytes = fence ? utf8Bytes(fenceLine) + utf8Bytes(closeOf(fence)) + 2 : 0
    for (const line of hardCut(rawLine, Math.max(1, budgetBytes - reopenBytes))) {
      const reserve = fence ? utf8Bytes(closeOf(fence)) + 1 : 0
      if (current.length && currentBytes + utf8Bytes(line) + 1 + reserve > budgetBytes) {
        if (paragraphCut > 0 && paragraphCut < current.length) {
          emit(current.slice(0, paragraphCut))
          current = current.slice(paragraphCut)
        } else if (fence) {
          emit([...current, closeOf(fence)])
          current = [fenceLine]
        } else {
          emit(current)
          current = []
        }
        currentBytes = utf8Bytes(current.join('\n'))
        paragraphCut = 0
      }
      currentBytes += utf8Bytes(line) + (current.length ? 1 : 0)
      current.push(line)
      if (fence) {
        if (closesFence(line, fence)) fence = undefined
      } else {
        const opening = FENCE.exec(line)
        if (opening) {
          fence = opening[1]!
          fenceLine = line
        } else if (!line.trim()) paragraphCut = current.length
      }
    }
  }
  emit(current)
  return segments
}
