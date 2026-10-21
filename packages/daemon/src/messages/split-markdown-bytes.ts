// Byte-budget Markdown splitting shared by platforms whose message limit counts UTF-8 bytes.

/** Opening/closing CommonMark fence: up to 3 spaces of indent, then 3+ backticks or tildes. */
export const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Does `line` close the fence opened by `marker`: same character, at least as long, alone on its line. */
export function closesFence(line: string, marker: string): boolean {
  const [, run = '', rest = ''] = FENCE.exec(line) ?? []
  return run !== '' && run[0] === marker[0] && run.length >= marker.length && !rest.trim()
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
export function splitMarkdownByBytes(text: string, budgetBytes: number): string[] {
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
      // Cut until the line fits: a paragraph cut can leave a remainder that still overflows with it.
      while (current.length && currentBytes + utf8Bytes(line) + 1 + reserve > budgetBytes) {
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
