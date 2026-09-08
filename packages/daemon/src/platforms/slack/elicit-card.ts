/**
 * Slack's **elicitation-card facet** (§7.3) — the first implementer of
 * {@link ElicitCardFacet}, extracted verbatim from the `instanceof SlackConnection` arm of
 * `onAcpElicit`.
 *
 * Slack is the surface with every control: a row of buttons for a lone single-select or boolean,
 * `input` blocks with one Confirm for anything that has to be filled in first, and a consent card
 * for URL mode. Which of the three a card is comes from `elicitCardShape` and the ask's own shape,
 * not from anything core decides, which is why the whole choice lives here.
 *
 * The rewrite is `chat.update` on the same message, and the mark is a Slack emoji SHORTCODE —
 * `:white_check_mark:` and friends are Slack spelling, and rendering the mark is precisely the
 * half of a settlement that is not portable.
 */
import type {
  ElicitCardAsk,
  ElicitCardDraft,
  ElicitCardFacet,
  ElicitCardHandle,
  ElicitCardHost,
  ElicitCardMark,
  ElicitCardSettlement,
  ElicitCardTurn
} from '../elicit-card.js'
import type { SlackConnection } from '../../slack/connection.js'
import {
  buildElicitationCard,
  buildElicitationFormCard,
  buildElicitationResolvedCard,
  buildUrlConsentCard,
  buildUrlConsentResolvedCard,
  elicitCardShape,
  SLACK_ELICIT_SURFACE
} from '../../slack/render.js'
import { slackAgentIdentityOptions } from './turn-output.js'

/** How Slack spells each settlement mark. Shortcodes, because a Slack section renders them and a
 *  literal emoji would sit oddly beside the rest of this surface's chrome. */
const SLACK_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: ':white_check_mark:',
  dismissed: ':no_entry_sign:',
  waiting: ':hourglass:',
  blocked: ':lock:'
}

export const slackElicitCards: ElicitCardFacet = {
  platform: 'slack',
  reduction: SLACK_ELICIT_SURFACE,

  build(host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    const sessionTarget = host.sessionTarget(turn)
    if (ask.url) return buildUrlConsentCard(ask.requestId, ask.params, sessionTarget)
    if (!ask.form?.length) return null
    // ONE reduction decides the card's shape (#1794): anything the reader has to fill in before
    // submitting is `input` blocks with one Confirm; a lone single-select or boolean, which one
    // tap answers, keeps its row of buttons.
    return elicitCardShape(ask.form) === 'inputs'
      ? buildElicitationFormCard(ask.requestId, ask.params, [...ask.form], sessionTarget)
      : buildElicitationCard(ask.requestId, ask.params, sessionTarget, SLACK_ELICIT_SURFACE)
  },

  async send(
    host: ElicitCardHost,
    turn: ElicitCardTurn,
    ask: ElicitCardAsk,
    draft: ElicitCardDraft
  ): Promise<string | undefined> {
    return await host.postCardSerialized(turn, (conn) =>
      (conn as SlackConnection).postBlocks(
        turn.plan.channel,
        draft as unknown[],
        ask.fallback,
        turn.plan.statusThread,
        { ...(slackAgentIdentityOptions(turn.plan) ?? {}), chrome: true }
      )
    )
  },

  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    if (handle.ts === undefined) return
    const decision = `${SLACK_ELICIT_MARK[card.mark]} ${card.text}`
    // A consent card keeps its own shape so the settled message still records the URL.
    const blocks = card.consent
      ? buildUrlConsentResolvedCard(card.params, decision)
      : buildElicitationResolvedCard(card.params, decision)
    void (handle.conn as SlackConnection)
      .updateBlocks(handle.channel, handle.ts, blocks, card.fallback ?? decision, true)
      .catch(() => {})
  },

  answerScope(handle: ElicitCardHandle): string | undefined {
    return (handle.conn as SlackConnection).workspaceId()
  }
}
