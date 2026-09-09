import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { NormalizedMessage } from '../messages/normalized.js'
import { attachmentMention } from '../session/attachment-block.js'
import { MAX_STEERS_PER_TURN } from './constants.js'
import type { Pending, QueueEntry } from './turn-types.js'

// Pure decisions behind "steer instead of queue" (issue #1847): which arrivals may ride the live
// turn, which turn they ride, and what the runtime receives. dispatch() owns the side effects.

type SteerCandidate = Pick<
  QueueEntry,
  'msg' | 'isQueueCmd' | 'hookContext' | 'callMeta' | 'admissionWait' | 'coordinationWait'
>

/** Only an ordinary human chat message may be steered. `!queue`, code-host hooks, scheduler
 *  wakes, agent→agent calls, and entries holding an admission barrier stay serialised. */
export function steerEligibleEntry(entry: SteerCandidate): boolean {
  return (
    entry.msg.source === 'user' &&
    entry.isQueueCmd !== true &&
    entry.hookContext === undefined &&
    entry.callMeta === undefined &&
    entry.admissionWait === undefined &&
    entry.coordinationWait === undefined
  )
}

/** The turn a same-key arrival can be steered into: its prompt is awaiting the runtime, its output
 *  is not suppressed, and it still has steering budget. Undefined ⇒ queue as before. */
export function selectSteerTarget(
  pendings: Iterable<Pending>,
  sessionKey: string,
  cap: number = MAX_STEERS_PER_TURN
): Pending | undefined {
  for (const pending of pendings) {
    if (pending.plan.sessionKey !== sessionKey) continue
    if (pending.promptInFlight !== true || pending.outputSuppressed !== undefined) return undefined
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
export function steerPromptBlocks(msg: NormalizedMessage): ContentBlock[] {
  const text = `[${msg.sender.id}] ${msg.turnBody?.prompt ?? msg.text}`
  const mention = attachmentMention(msg.attachments)
  return [{ type: 'text', text: mention ? `${text}\n${mention}` : text }]
}
