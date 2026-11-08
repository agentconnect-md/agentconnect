// Fence-aware Markdown splitting shared by platforms; the budget counts UTF-8 bytes unless a platform passes its own measure.

/** Opening/closing CommonMark fence: up to 3 spaces of indent, then 3+ backticks or tildes. */
export const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** UTF-16 code units — how Telegram counts a message's length. */
export function utf16Units(text: string): number {
  return text.length
}

/** Does `line` close the fence opened by `marker`: same character, at least as long, alone on its line. */
export function closesFence(line: string, marker: string): boolean {
  const [, run = '', rest = ''] = FENCE.exec(line) ?? []
  return run !== '' && run[0] === marker[0] && run.length >= marker.length && !rest.trim()
}

/** Cut one line into pieces of at most `maxBytes` by `measure`, never inside a code point. */
function hardCut(line: string, maxBytes: number, measure: (text: string) => number): string[] {
  if (measure(line) <= maxBytes) return [line]
  const pieces: string[] = []
  let piece = ''
  let pieceBytes = 0
  for (const ch of line) {
    const bytes = measure(ch)
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
export function splitMarkdownByBytes(text: string, budgetBytes: number): string[] {
  return splitMarkdown(text, budgetBytes, utf8Bytes)
}

/** {@link splitMarkdownByBytes} against any length `measure`, e.g. {@link utf16Units}. */
export function splitMarkdown(text: string, budget: number, measure: (text: string) => number): string[] {
  const body = text.replace(/\s+$/, '')
  if (!body.trim()) return []
  if (measure(body) <= budget) return [body]
  const segments: string[] = []
  let current: string[] = []
  let currentSize = 0
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
    const reopenSize = fence ? measure(fenceLine) + measure(closeOf(fence)) + 2 : 0
    for (const line of hardCut(rawLine, Math.max(1, budget - reopenSize), measure)) {
      const reserve = fence ? measure(closeOf(fence)) + 1 : 0
      // Cut until the line fits: a paragraph cut can leave a remainder that still overflows with it.
      while (current.length && currentSize + measure(line) + 1 + reserve > budget) {
        if (paragraphCut > 0 && paragraphCut < current.length) {
          emit(current.slice(0, paragraphCut))
          current = current.slice(paragraphCut)
        } else if (fence && !(current.length === 1 && current[0] === fenceLine)) {
          emit([...current, closeOf(fence)])
          current = [fenceLine]
        } else {
          // Plain text, or a fence marker too long to ever share a message with a line: start empty.
          emit(current)
          current = []
        }
        currentSize = measure(current.join('\n'))
        paragraphCut = 0
      }
      currentSize += measure(line) + (current.length ? 1 : 0)
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
