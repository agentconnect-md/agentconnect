import type { DecisionPreviewSample } from '@agentconnect.md/protocol'
import { PREVIEW_SENDER } from './decision-gate-preview.js'

/** The thread id a sample's established-thread situation carries, so the state reads as a reply. */
export const PREVIEW_THREAD = 'preview-thread'

export type RoutingPreviewSituation =
  { type: 'new' } | { type: 'mention' | 'thread'; agentIds: readonly string[]; participantAgentIds: readonly string[] }

/** A routing Try sample in the router's live state shape (decisions.md §8.2), addressed as the situation says. */
export function routingSampleState(
  sample: DecisionPreviewSample,
  situation: RoutingPreviewSituation,
  opts: { conversationName?: string } = {}
): Record<string, unknown> {
  const threadId = situation.type === 'thread' ? PREVIEW_THREAD : null
  const history = sample.history.map((entry, index) => ({
    id: `preview-${index + 1}`,
    sender: { id: entry.sender },
    text: entry.text,
    threadId
  }))
  const participants = situation.type === 'new' ? [] : situation.participantAgentIds
  const eligible = situation.type === 'new' ? [] : situation.agentIds.filter((id) => !participants.includes(id))
  return {
    currentMessage: {
      id: `preview-${history.length + 1}`,
      sender: { id: sample.currentMessage.sender ?? PREVIEW_SENDER },
      text: sample.currentMessage.text,
      threadId
    },
    history,
    conversation: opts.conversationName ? { name: opts.conversationName } : {},
    addressing: {
      mentions: situation.type === 'mention' ? [...situation.agentIds] : [],
      constraint: { eligibleAgentIds: [...eligible], participantAgentIds: [...participants] }
    },
    context: { partial: false, reasons: [], omittedMessages: 0 }
  }
}

export type RoutingNotAppliedReason = 'off' | 'outside_scope' | 'paused' | 'needs_review' | 'unsupported'

/** The precedence a routing preview is Not applied by, checked before any model call (decisions.md §3.2, §9.3). */
export function routingNotApplied(input: {
  channelOff: boolean
  inScope: boolean
  enabled: boolean
  savedNeedsReview: boolean
  draftIsSaved: boolean
  unsupported: boolean
}): RoutingNotAppliedReason | null {
  if (input.channelOff) return 'off'
  if (!input.inScope) return 'outside_scope'
  if (!input.enabled) return 'paused'
  if (input.savedNeedsReview && input.draftIsSaved) return 'needs_review'
  if (input.unsupported) return 'unsupported'
  return null
}
