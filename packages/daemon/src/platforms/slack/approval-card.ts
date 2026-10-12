// Slack's approval-card facet (§7.3): Block Kit cards rewritten with `chat.update`, a refused click told by an ephemeral message.
import type {
  ApprovalCardAsk,
  ApprovalCardDraft,
  ApprovalCardFacet,
  ApprovalCardHandle,
  ApprovalCardOrphan,
  ApprovalCardPlace,
  ApprovalCardSettlement,
  SubsessionAsker,
  SubsessionNoticeView
} from '../approval-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import type { SlackConnection } from '../../slack/connection.js'
import {
  buildApprovalOrphanCard,
  buildPermissionCard,
  buildPermissionResolvedCard,
  buildSubsessionApprovalIntro,
  buildSubsessionApprovalNotice,
  buildSubsessionApprovalSettledNotice,
  SLACK_PERMISSION_MAX_OPTIONS,
  type SubsessionNoticeOutcome
} from '../../slack/render.js'
import { slackAgentIdentityOptions } from './turn-output.js'

/** A Slack card or notice: its blocks and the notification text beside them. */
interface SlackApprovalDraft {
  blocks: unknown[]
  fallback: string
}

/** A sub-session's card keeps the header naming who asks on every rewrite. */
const withIntro = (subsession: SubsessionAsker | undefined, blocks: unknown[]): unknown[] =>
  subsession ? [...buildSubsessionApprovalIntro(subsession), ...blocks] : blocks

const postOptions = (turn: ElicitCardTurn) => ({ ...(slackAgentIdentityOptions(turn.plan) ?? {}), chrome: true })

export const slackApprovalCards: ApprovalCardFacet = {
  platform: 'slack',
  maxOptions: SLACK_PERMISSION_MAX_OPTIONS,

  build(ask: ApprovalCardAsk): ApprovalCardDraft | null {
    const card = buildPermissionCard(ask.requestId, ask.params, ask.sessionTarget)
    if (!card) return null
    const fallback = ask.subsession
      ? `Permission requested by ${ask.subsession.agentName}`
      : `Permission requested: ${ask.params.toolCall?.title ?? 'a tool call'}`
    return { blocks: withIntro(ask.subsession, card), fallback } satisfies SlackApprovalDraft
  },

  settled(card: ApprovalCardSettlement): ApprovalCardDraft {
    const blocks = buildPermissionResolvedCard(card.params, card.text, card.allowed)
    return { blocks: withIntro(card.subsession, blocks), fallback: card.fallback } satisfies SlackApprovalDraft
  },

  notice(asker: SubsessionAsker): ApprovalCardDraft {
    return {
      blocks: buildSubsessionApprovalNotice(asker),
      fallback: `${asker.agentName} is waiting for permission`
    } satisfies SlackApprovalDraft
  },

  noticeSettled(view: SubsessionNoticeView, outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    return {
      blocks: buildSubsessionApprovalSettledNotice(view, outcome),
      fallback: 'Permission request settled'
    } satisfies SlackApprovalDraft
  },

  orphaned(row: ApprovalCardOrphan): ApprovalCardDraft {
    return {
      blocks: buildApprovalOrphanCard(row.command, row.status, row.resolvedByName),
      fallback: 'Permission resolved'
    } satisfies SlackApprovalDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as SlackApprovalDraft
    return await host.postCardSerialized(turn, (conn) =>
      (conn as SlackConnection).postBlocks(turn.plan.channel, d.blocks, d.fallback, turn.plan.thread, postOptions(turn))
    )
  },

  async post(
    conn: unknown,
    place: ApprovalCardPlace,
    draft: ApprovalCardDraft,
    turn: ElicitCardTurn
  ): Promise<string | undefined> {
    const d = draft as SlackApprovalDraft
    return await (conn as SlackConnection).postBlocks(
      place.channel,
      d.blocks,
      d.fallback,
      place.thread,
      postOptions(turn)
    )
  },

  rewrite(handle: ApprovalCardHandle, draft: ApprovalCardDraft): void {
    if (handle.ts === undefined) return
    const d = draft as SlackApprovalDraft
    void (handle.conn as SlackConnection)
      .updateBlocks(handle.channel, handle.ts, d.blocks, d.fallback, true)
      .catch(() => {})
  },

  tellPrivately(handle: ApprovalCardHandle, userId: string, text: string): void {
    void (handle.conn as SlackConnection).postEphemeral(handle.channel, userId, text, handle.thread)
  },

  answerScope(handle: ApprovalCardHandle): string | undefined {
    return (handle.conn as SlackConnection).workspaceId()
  },

  nameOf(handle: ApprovalCardHandle, userId: string): Promise<string | undefined> {
    return (handle.conn as SlackConnection).memberName(userId)
  }
}
