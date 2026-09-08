import { referenceBufferStart } from './agent-links.js'

/** Opening/closing CommonMark fence: up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** Split at a completed paragraph before any block whose reference definitions may still arrive. */
export function splitAtParagraphBoundary(text: string): { ready: string; tail: string } {
  let cut = 0
  let fence: string | undefined
  let pos = 0
  const referenceStart = referenceBufferStart(text) ?? text.length
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos)
    // A trailing line without its newline is still streaming.
    if (nl < 0) break
    const line = text.slice(pos, nl)
    pos = nl + 1
    const [, run = '', rest = ''] = FENCE.exec(line) ?? []
    if (fence) {
      // A fence closes on the same character, at least as long, alone on its line.
      if (run && run[0] === fence[0] && run.length >= fence.length && !rest.trim()) fence = undefined
      continue
    }
    if (run) {
      fence = run
      continue
    }
    if (!line.trim() && pos <= referenceStart) cut = pos
  }
  const ready = text.slice(0, cut)
  return ready.trim() ? { ready, tail: text.slice(cut) } : { ready: '', tail: text }
}
