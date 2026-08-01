/**
 * Where a *streamed* reply may be cut into separate chat messages (§9.1 text-buffer).
 *
 * The daemon's idle-flush timer fires on a pause in the ACP stream, which says nothing
 * about whether the reply's text is complete: ACP text deltas are token-sized, so the
 * buffer routinely ends mid-sentence — and even mid-word ("…rebuilding the depend" /
 * "ency graph"). Posting it verbatim splits one answer across two chat messages at that
 * arbitrary point.
 *
 * A time-triggered flush therefore cuts only at a paragraph break — a blank line outside a
 * fenced code block, the one place CommonMark guarantees the preceding block has ended.
 * Anything after the last such break stays buffered for the next flush, for a semantic
 * boundary (tool call / plan / thinking, where the model really did finish a text block),
 * or for turn end. A buffer with no break yet is held whole.
 *
 * Semantic boundaries and turn end still drain the whole buffer — they are not this
 * function's business.
 */

/** Opening/closing CommonMark fence: up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * Split a streaming body into the part that is safe to send now and the tail that must stay
 * buffered. `ready` ends just past the last top-level blank line; `tail` is the rest.
 * `ready` is empty (and `tail` is the whole input) when no paragraph break has arrived yet.
 * `ready + tail` always reconstructs the input exactly, so no content is lost or duplicated.
 */
export function splitAtParagraphBoundary(text: string): { ready: string; tail: string } {
  let cut = 0
  let fence: string | undefined
  let pos = 0
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos)
    // The trailing line has no newline yet — it is still streaming, so it can never be a
    // boundary and nothing after the last complete line matters.
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
    if (!line.trim()) cut = pos
  }
  const ready = text.slice(0, cut)
  return ready.trim() ? { ready, tail: text.slice(cut) } : { ready: '', tail: text }
}
