// Feishu/Lark's approval-card facet (§7.3): a CardKit card of buttons whose callback names the request and the option's position, rewritten in place.
import type { WireFeishuCardActionTarget } from '@agentconnect.md/protocol'
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
import {
  approvalMark,
  orphanMark,
  subsessionAskerText,
  subsessionSettledText,
  subsessionWaitText,
  TURN_NOTICE_TEXT,
  turnNoticeSettledText
} from '../approval-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import type { FeishuConnection } from '../../feishu/connection.js'
import { FEISHU_MESSAGE_LIMIT, feishuCardTarget } from '../../feishu/render.js'
import { clampTo, permToolLabel, type SubsessionNoticeOutcome } from '../../slack/render.js'
import {
  FEISHU_ELICIT_MAX_OPTIONS,
  FEISHU_LABEL_CAP,
  feishuButtonRow,
  feishuCard,
  feishuPlainText
} from './elicit-card.js'

/** The elicitation card's own option cap plus the Dismiss slot a permission card does not need. */
export const FEISHU_APPROVAL_MAX_OPTIONS = FEISHU_ELICIT_MAX_OPTIONS + 1

/** What a permission card's callbacks name themselves, apart from an elicitation card's and a session-control card's. */
export const FEISHU_APPROVAL_ACTION = 'agentconnect_approval'

/** How much of a settlement's words the card echoes. */
const FEISHU_APPROVAL_DECISION_CAP = 300

/** One option button's callback payload: the request, the option's position, and the integration the relay routes it to. Pure. */
export function feishuApprovalValue(
  requestId: string,
  option: number,
  target?: WireFeishuCardActionTarget
): Record<string, unknown> {
  return { action: FEISHU_APPROVAL_ACTION, request: requestId, option: String(option), ...(target ? { target } : {}) }
}

/** A clicked permission button: its request and option position; null for a payload this scheme did not mint. Pure. */
export function parseFeishuApproval(value: unknown): { requestId: string; option: number } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.action !== FEISHU_APPROVAL_ACTION || typeof v.request !== 'string' || !v.request) return null
  if (typeof v.option !== 'string' || !/^\d{1,2}$/.test(v.option)) return null
  return { requestId: v.request, option: Number(v.option) }
}

/** A Feishu card or notice: the whole CardKit card, ready to post or patch. */
interface FeishuApprovalDraft {
  card: Record<string, unknown>
}

/** Allow primary, reject danger, anything else plain. */
const typeOf = (kind: string): string =>
  kind === 'allow_once' || kind === 'allow_always'
    ? 'primary'
    : kind === 'reject_once' || kind === 'reject_always'
      ? 'danger'
      : 'default'

/** The console link as a markdown element: the URL is ours, so only it may render as a link. */
const link = (url: string): Record<string, unknown> => ({
  tag: 'markdown',
  content: `[Open the task](${url})`
})

/** The elements above a sub-session's request naming who asks, how long it waits, and where it is; agent words stay plain text. */
function intro(asker: SubsessionAsker): Record<string, unknown>[] {
  const who = subsessionAskerText(asker.agentName, asker.title, clampTo)
  return [
    feishuPlainText(`${who} is asking for permission. ${subsessionWaitText(asker.waitHours)}`),
    link(asker.sessionUrl)
  ]
}

const fit = (text: string): string => clampTo(text, FEISHU_MESSAGE_LIMIT)

export const feishuApprovalCards: ApprovalCardFacet = {
  platform: 'feishu',
  maxOptions: FEISHU_APPROVAL_MAX_OPTIONS,

  build(ask: ApprovalCardAsk): ApprovalCardDraft | null {
    const options = ask.params.options
    if (!options.length || options.length > FEISHU_APPROVAL_MAX_OPTIONS) return null
    const target = ask.via && feishuCardTarget(ask.via.agentId, ask.via.integrationId)
    const buttons = options.map((o, i) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: clampTo(o.name, FEISHU_LABEL_CAP) },
      type: typeOf(o.kind),
      behaviors: [{ type: 'callback', value: feishuApprovalValue(ask.requestId, i, target) }]
    }))
    const head = ask.subsession ? intro(ask.subsession) : []
    const card = feishuCard([
      ...head,
      feishuPlainText(fit(`🔒 Permission requested — ${permToolLabel(ask.params)}`)),
      feishuButtonRow(buttons)
    ])
    return { card } satisfies FeishuApprovalDraft
  },

  settled(card: ApprovalCardSettlement): ApprovalCardDraft {
    const head = card.subsession ? intro(card.subsession) : []
    const decision = `${approvalMark(card.allowed)} ${clampTo(card.text, FEISHU_APPROVAL_DECISION_CAP)}`
    return {
      card: feishuCard([...head, feishuPlainText(fit(`🔒 Permission — ${permToolLabel(card.params)}\n${decision}`))])
    } satisfies FeishuApprovalDraft
  },

  notice(asker: SubsessionAsker): ApprovalCardDraft {
    const who = subsessionAskerText(asker.agentName, asker.title, clampTo)
    const text = `🔒 ${who} is waiting for permission. Ask an Agent editor to allow it from the Agent or Session page. ${subsessionWaitText(asker.waitHours)}`
    return { card: feishuCard([feishuPlainText(fit(text)), link(asker.sessionUrl)]) } satisfies FeishuApprovalDraft
  },

  noticeSettled(view: SubsessionNoticeView, outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const line = subsessionSettledText(subsessionAskerText(view.agentName, view.title, clampTo), outcome, (s) =>
      clampTo(s, 60)
    )
    const elements = [feishuPlainText(fit(line)), ...(view.sessionUrl ? [link(view.sessionUrl)] : [])]
    return { card: feishuCard(elements) } satisfies FeishuApprovalDraft
  },

  turnNotice(): ApprovalCardDraft {
    return { card: feishuCard([feishuPlainText(TURN_NOTICE_TEXT)]) } satisfies FeishuApprovalDraft
  },

  turnNoticeSettled(outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const text = turnNoticeSettledText(outcome, (s) => clampTo(s, 60))
    return { card: feishuCard([feishuPlainText(fit(text))]) } satisfies FeishuApprovalDraft
  },

  orphaned(row: ApprovalCardOrphan): ApprovalCardDraft {
    const by = row.resolvedByName ? ` by ${clampTo(row.resolvedByName, 60)}` : ''
    const text = `🔒 Permission — ${clampTo(row.command, 150)}\n${orphanMark(row.status)} ${row.status}${by}`
    return { card: feishuCard([feishuPlainText(fit(text))]) } satisfies FeishuApprovalDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as FeishuApprovalDraft
    // Anchored as the turn's other posts are: an `om_` thread is replied into, a chat is posted to.
    return await host.postCardSerialized(turn, (conn) =>
      (conn as FeishuConnection).postElicitCard(turn.plan.channel, turn.plan.thread, d.card)
    )
  },

  async post(conn: unknown, place: ApprovalCardPlace, draft: ApprovalCardDraft): Promise<string | undefined> {
    return await (conn as FeishuConnection).postElicitCard(
      place.channel,
      place.thread,
      (draft as FeishuApprovalDraft).card
    )
  },

  rewrite(handle: ApprovalCardHandle, draft: ApprovalCardDraft): void {
    if (handle.ts === undefined) return
    void (handle.conn as FeishuConnection)
      .updateElicitCard(handle.ts, (draft as FeishuApprovalDraft).card)
      .catch(() => {})
  }
}
