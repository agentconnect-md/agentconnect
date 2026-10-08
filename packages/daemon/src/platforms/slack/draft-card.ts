// Slack's assistant-mode draft card surface (assistant-mode.md §5.5): the DM card and its settled rewrite.
import { encodeSharedSlackStatusTarget } from '@agentconnect.md/protocol'
import type { DraftCardPort } from '../../assistant/drafts.js'
import type { SlackConnection } from '../../slack/connection.js'
import { buildAssistantDraftCard, buildAssistantDraftSettledCard } from '../../slack/render.js'

type DraftCardConnection = Pick<
  SlackConnection,
  'openDirectMessage' | 'isFullMember' | 'workspaceId' | 'postBlocks' | 'updateBlocks'
>

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
      return await conn.postBlocks(
        channel,
        blocks,
        `${card.view.agentName} is waiting for your approval to post`,
        undefined,
        {
          username: card.view.agentName,
          chrome: true
        }
      )
    },
    updateCard: async (channel, ts, card) => {
      if (!('outcome' in card)) return
      await conn.updateBlocks(channel, ts, buildAssistantDraftSettledCard(card.view, card.outcome), card.outcome, true)
    }
  }
}
