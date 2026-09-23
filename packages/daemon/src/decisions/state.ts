import type { DecisionQuestion } from '@agentconnect.md/protocol'
import { transcriptQuoted, type ChannelTextRow } from '../store/local-store.js'
import { DECISION_REQUEST_MAX_BYTES, decisionRequestBody } from './evaluator.js'

/** decisions.md §8.2: the whole request targets this many tokens, estimated at four bytes each. */
export const DECISION_TOKEN_BUDGET = 8_000
const BYTES_PER_TOKEN = 4
/** decisions.md §8.1: one history entry's text cap; the current message is never truncated. */
export const DECISION_HISTORY_ENTRY_MAX_BYTES = 16 * 1024

export interface DecisionStateInput {
  source?: 'chat'
  current: ChannelTextRow
  /** Newest-first, as `LocalStore.decisionWindow` returns it. */
  history: readonly ChannelTextRow[]
  conversation?: { name?: string }
  addressing: {
    mentions: readonly string[]
    /** A gate's bound target; a router has none before its selection. */
    target?: { agentId: string; via: 'mention' | 'implicit' }
    /** A router's target constraint (message-intake.md §6 step 2). */
    constraint?: { eligibleAgentIds: readonly string[]; participantAgentIds: readonly string[] }
  }
  /** The read window was full, so older rows exist outside it. */
  full: boolean
  /** This record of the conversation began after the conversation did. */
  rootMissing: boolean
  forwardedHistory?: boolean
  question: DecisionQuestion
  model: string
}

export type DecisionStateResult =
  | { unsupported: true }
  | { unsupported?: false; state: Record<string, unknown>; omittedMessages: number; reasons: string[] }

interface Entry {
  id: string
  sender: { id: string }
  text: string
  quote?: { sender?: string; text: string }
  threadId: string | null
  time?: string
  truncated?: true
}

function truncateUtf8(text: string, max: number): string | undefined {
  if (Buffer.byteLength(text, 'utf8') <= max) return undefined
  let out = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8')
  while (Buffer.byteLength(out, 'utf8') > max) out = out.slice(0, -1)
  return out.replace(/�$/, '')
}

function entryOf(row: ChannelTextRow, truncate: boolean): Entry {
  const quoted = transcriptQuoted(row)
  const cut = truncate ? truncateUtf8(row.text, DECISION_HISTORY_ENTRY_MAX_BYTES) : undefined
  return {
    id: row.ts ?? String(row.seq),
    sender: { id: row.sender },
    text: cut ?? row.text,
    ...(quoted?.text ? { quote: { ...(quoted.sender ? { sender: quoted.sender } : {}), text: quoted.text } } : {}),
    threadId: row.thread,
    ...(row.eventTimeUs ? { time: new Date(Math.floor(row.eventTimeUs / 1000)).toISOString() } : {}),
    ...(cut !== undefined ? { truncated: true as const } : {})
  }
}

/** Build the frozen Jev state at a verdict's row: newest history that fits, presented oldest-first. */
export function buildDecisionState(input: DecisionStateInput): DecisionStateResult {
  const current = entryOf(input.current, false)
  const candidates = input.history.map((row) => entryOf(row, true))
  const compose = (included: Entry[]): { state: Record<string, unknown>; reasons: string[] } => {
    const omitted = candidates.length - included.length
    const reasons: string[] = []
    if (input.full) reasons.push('history_limit')
    if (omitted > 0) reasons.push('budget_trimmed')
    if (current.threadId === null || included.some((entry) => entry.threadId === null))
      reasons.push('legacy_thread_unknown')
    if (input.rootMissing) reasons.push('observation_started_after_conversation')
    if (input.forwardedHistory) reasons.push('forwarded_history')
    return {
      reasons,
      state: {
        ...(input.source ? { source: input.source } : {}),
        currentMessage: current,
        history: [...included].reverse(),
        conversation: input.conversation ?? {},
        addressing: {
          mentions: [...input.addressing.mentions],
          ...(input.addressing.target ? { target: input.addressing.target } : {}),
          ...(input.addressing.constraint
            ? {
                constraint: {
                  eligibleAgentIds: [...input.addressing.constraint.eligibleAgentIds],
                  participantAgentIds: [...input.addressing.constraint.participantAgentIds]
                }
              }
            : {})
        },
        context: {
          partial: reasons.length > 0,
          reasons,
          omittedMessages: omitted,
          snapshotSequence: input.current.seq,
          tokenCount: 'estimate'
        }
      }
    }
  }
  const fits = (state: Record<string, unknown>): boolean => {
    const bytes = Buffer.byteLength(
      decisionRequestBody({ decision: { model: input.model, question: input.question }, state }),
      'utf8'
    )
    return bytes <= DECISION_REQUEST_MAX_BYTES && Math.ceil(bytes / BYTES_PER_TOKEN) <= DECISION_TOKEN_BUDGET
  }
  // Newest first until the next one no longer fits; the kept set is a newest-suffix of the window.
  const included: Entry[] = []
  for (const entry of candidates) {
    if (!fits(compose([...included, entry]).state)) break
    included.push(entry)
  }
  let built = compose(included)
  while (!fits(built.state) && included.length > 0) {
    included.pop()
    built = compose(included)
  }
  if (!fits(built.state)) return { unsupported: true }
  return { state: built.state, omittedMessages: candidates.length - included.length, reasons: built.reasons }
}
