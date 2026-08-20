// Pure inputs for virtualizing the webchat transcript (deepseek-harness style): a length
// threshold below which plain rendering wins, and a per-turn size ESTIMATE. The estimate only
// seeds the virtualizer's initial scroll math — `measureElement` replaces it with the real height
// once a row mounts — so it just needs to be a sane first guess, not exact.

/** Turn counts at or below this render plainly (no virtualization): short chats don't pay the DOM
 *  cost, and the plain path keeps the existing `useStickToBottom` follow untouched. */
export const VIRTUALIZE_THRESHOLD = 60

/** Whether a transcript of `turnCount` turns is worth virtualizing. */
export function shouldVirtualizeTranscript(turnCount: number): boolean {
  return turnCount > VIRTUALIZE_THRESHOLD
}

/** The minimal turn shape the estimate reads — a structural subset of the view's `Turn`. */
export interface EstimableTurn {
  kind: 'user' | 'bot'
  text?: string
  image?: unknown
  steps?: readonly { text?: string; code?: string }[]
}

const BASE_ROW = 44 // the turn's time line + vertical gaps
const USER_BASE = 40 // one right-aligned bubble
const BOT_STEP = 56 // one agent step (a bubble / tool row / collapsed work line)
const IMAGE = 220 // an attached image, before it decodes
const CHARS_PER_LINE = 64
const LINE = 20

function textHeight(text: string | undefined): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_LINE) * LINE
}

/** A rough first-paint height for one turn, refined by measurement on mount. User turns are one
 *  bubble; bot turns grow with their step count and the text they carry. */
export function estimateTurnSize(turn: EstimableTurn): number {
  if (turn.kind === 'user') {
    return BASE_ROW + USER_BASE + textHeight(turn.text) + (turn.image ? IMAGE : 0)
  }
  const steps = turn.steps ?? []
  const stepsHeight = steps.reduce(
    (sum, step) => sum + BOT_STEP + textHeight(step.text) + (step.code ? textHeight(step.code) : 0),
    0
  )
  return BASE_ROW + Math.max(BOT_STEP, stepsHeight)
}
