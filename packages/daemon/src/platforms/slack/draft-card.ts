// Slack's assistant-mode draft card surface (assistant-mode.md §5.5): the DM card and its settled rewrite.
import { encodeSharedSlackStatusTarget } from '@agentconnect.md/protocol'
import type { DraftCardPort } from '../../assistant/drafts.js'
import type { SlackConnection } from '../../slack/connection.js'
import {
  buildAssistantDraftCard,
  buildAssistantDraftSettledCard,
  type AssistantDraftCardView
} from '../../slack/render.js'

type DraftCardConnection = Pick<
  SlackConnection,
  'openDirectMessage' | 'isFullMember' | 'workspaceId' | 'postBlocks' | 'updateBlocks'
>

const fallbackText = (view: AssistantDraftCardView): string =>
  view.kind === 'task'
    ? `${view.agentName} is asking for your approval to run a task`
    : `${view.agentName} is waiting for your approval to post`

/** The draft card port of one Slack integration; the block id lets a relayed click find its daemon. */
export function slackDraftCardPort(conn: DraftCardConnection, integrationId: string): DraftCardPort {
  return {
    openDirectMessage: (user) => conn.openDirectMessage(user),
    isFullMember: (user) => conn.isFullMember(user),
    scope: () => conn.workspaceId() || undefined,
    postCard: async (channel, card) => {
      if (!('draftId' in card)) return undefined
      const routingTarget = encodeSharedSlackStatusTarget({
        agentId: card.agentId,
        integrationId,
        sessionKey: card.sessionKey ?? `assistant-draft:${card.draftId}`
      })
      const blocks = buildAssistantDraftCard(card.draftId, card.view, { offerAlways: card.offerAlways, routingTarget })
      return await conn.postBlocks(channel, blocks, fallbackText(card.view), undefined, {
        username: card.view.agentName,
        chrome: true
      })
    },
    updateCard: async (channel, ts, card) => {
      if ('outcome' in card) {
        await conn.updateBlocks(
          channel,
          ts,
          buildAssistantDraftSettledCard(card.view, card.outcome),
          card.outcome,
          true
        )
        return
      }
      // A pending card redrawn with a notice keeps its buttons and its routing.
      const routingTarget = encodeSharedSlackStatusTarget({
        agentId: card.agentId,
        integrationId,
        sessionKey: card.sessionKey ?? `assistant-draft:${card.draftId}`
      })
      const blocks = buildAssistantDraftCard(card.draftId, card.view, {
        offerAlways: card.offerAlways,
        routingTarget,
        ...(card.notice ? { notice: card.notice } : {})
      })
      await conn.updateBlocks(channel, ts, blocks, fallbackText(card.view), true)
    }
  }
}
