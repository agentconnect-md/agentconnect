import type { ContentBlock } from '@agentclientprotocol/sdk/unstable'
import { sessionThreadOf, type NormalizedMessage } from '../messages/normalized.js'
import { isCoordinatorCoordinate } from '../session/append-coordinate.js'
import { isSubsessionCoordinate } from '../session/subsession-coordinate.js'
import { attachmentMention } from '../session/attachment-block.js'
import { MAX_STEERS_PER_TURN } from './constants.js'
import type { Pending, QueueEntry } from './turn-types.js'

// Pure decisions behind "steer instead of queue" (issue #1847): which arrivals may ride the live
// turn, which turn they ride, and what the runtime receives. dispatch() owns the side effects.

type SteerCandidate = Pick<
  QueueEntry,
  'msg' | 'isQueueCmd' | 'hookContext' | 'callMeta' | 'admissionWait' | 'coordinationWait'
>

/** Only an ordinary human chat message outside a coordinator or a task may be steered; everything else stays serialised. */
export function steerEligibleEntry(entry: SteerCandidate): boolean {
  return (
    entry.msg.source === 'user' &&
    // A steer carries only the marker, never an upload's download link, so a message with uploads queues.
    !entry.msg.attachments?.some((attachment) => attachment.transfer !== undefined) &&
    entry.isQueueCmd !== true &&
    entry.hookContext === undefined &&
    entry.callMeta === undefined &&
    entry.admissionWait === undefined &&
    entry.coordinationWait === undefined &&
    // A coordinator decides each message in a turn of its own batch, never inside a running one (auto-session-mode.md §4.3).
    !isCoordinatorCoordinate(sessionThreadOf(entry.msg)) &&
    // A message on a task's page runs as its own turn, so its answer reaches the page rather than the parent's report (auto-session-mode.md §10).
    !isSubsessionCoordinate(sessionThreadOf(entry.msg))
  )
}

/** The live prompt of the key a same-key arrival may ride: not being cut, with budget left, answering in the arrival's channel; undefined ⇒ queue. */
export function selectSteerTarget(
  pendings: Iterable<Pending>,
  sessionKey: string,
  cap: number = MAX_STEERS_PER_TURN,
  channel?: string
): Pending | undefined {
  for (const pending of pendings) {
    if (pending.plan.sessionKey !== sessionKey) continue
    // A task's session answers in a channel it holds and in its origin thread, so a turn in one takes no message from the other (auto-session-mode.md §6.8).
    if (channel !== undefined && pending.plan.channel !== channel) return undefined
    // An interrupt marks the entry before it silences the output, so either one means the turn is going.
    const cut = pending.outputSuppressed !== undefined || pending.entry.cancelledReason !== undefined
    if (pending.promptInFlight !== true || cut) return undefined
    return (pending.steerCount ?? 0) < cap ? pending : undefined
  }
  return undefined
}

/** The text the message's transcript row carries — what the fences compare against. */
export function steeredTranscriptText(msg: NormalizedMessage): string {
  const mention = attachmentMention(msg.attachments)
  return mention ? `${msg.text}\n${mention}`.trim() : msg.text
}

/** What the running turn receives: the same `[sender] text` shape as a trigger prompt, with the
 *  attachment marker the agent needs to forward a file by name. Attachment bytes are not sent. */
export function steerPromptBlocks(
  msg: NormalizedMessage,
  intake: { background?: string; evidence?: string } = {}
): ContentBlock[] {
  const text = `[${msg.sender.id}] ${msg.turnBody?.prompt ?? msg.text}`
  const mention = attachmentMention(msg.attachments)
  // A By decision delivery carries its background before and its evidence after, as a trigger prompt does.
  return [
    ...(intake.background ? [{ type: 'text' as const, text: intake.background }] : []),
    { type: 'text', text: mention ? `${text}\n${mention}` : text },
    ...(intake.evidence ? [{ type: 'text' as const, text: intake.evidence }] : [])
  ]
}
