// Telegram's approval-card facet (§7.3): an inline keyboard whose buttons carry an option's position, settled with `editMessageText`.
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
import type { InlineButton, TelegramConnection } from '../../telegram/connection.js'
import { TELEGRAM_CALLBACK_ANSWER_LIMIT, TELEGRAM_MESSAGE_LIMIT } from '../../telegram/render.js'
import { clampTo, permToolLabel, type SubsessionNoticeOutcome } from '../../slack/render.js'
import { TELEGRAM_BUTTON_LABEL_CAP, TELEGRAM_ELICIT_MAX_BUTTONS } from './elicit-card.js'
import type { TelegramTurnState } from './turn-output.js'

/** The elicitation keyboard's measured button count plus the Dismiss slot a permission card does not need. */
export const TELEGRAM_APPROVAL_MAX_OPTIONS = TELEGRAM_ELICIT_MAX_BUTTONS + 1

/** Telegram's cap on one button's `callback_data`, in UTF-8 bytes. */
const TELEGRAM_CALLBACK_DATA_CAP = 64

/** How much of a settlement's words the card echoes. */
const TELEGRAM_APPROVAL_DECISION_CAP = 300

/** One option button's `callback_data`: the request and the option's position. Pure. */
export function telegramApprovalData(requestId: string, option: number): string {
  return `ac_pm:${requestId}:${option}`
}

/** A tapped permission button: its request and option position; null for data this scheme did not mint. Pure. */
export function parseTelegramApproval(data: string): { requestId: string; option: number } | null {
  const m = /^ac_pm:([0-9a-fA-F-]{1,64}):(\d{1,2})$/.exec(data)
  return m ? { requestId: m[1] as string, option: Number(m[2]) } : null
}

/** A Telegram card or notice: plain text, and a keyboard where it has one (an empty one drops the buttons on a rewrite). */
interface TelegramApprovalDraft {
  text: string
  buttons?: InlineButton[][]
}

/** The lines above a sub-session's request naming who asks, how long it waits, and where it is. */
function intro(asker: SubsessionAsker): string {
  return `${subsessionAskerText(asker.agentName, asker.title, clampTo)} is asking for permission. ${subsessionWaitText(asker.waitHours)}\nOpen the task: ${asker.sessionUrl}\n\n`
}

/** Plain text needs no defusing: the card is posted with no `parse_mode`. */
const plain = (text: string): string => clampTo(text, TELEGRAM_MESSAGE_LIMIT)

/** Where a post outside a turn lands: a numeric forum topic, or the reply chain a `tg:<root>` session lives in. */
function anchorOf(place: ApprovalCardPlace): { threadTs?: string; replyTo?: number } {
  if (place.thread && /^\d+$/.test(place.thread)) return { threadTs: place.thread }
  const root = place.thread ? /^tg:(\d+)$/.exec(place.thread) : null
  return root ? { replyTo: Number(root[1]) } : {}
}

export const telegramApprovalCards: ApprovalCardFacet = {
  platform: 'telegram',
  maxOptions: TELEGRAM_APPROVAL_MAX_OPTIONS,
  // A refused tap is told in the tap's own answer, an alert of at most 200 characters.
  privateTextLimit: TELEGRAM_CALLBACK_ANSWER_LIMIT,

  build(ask: ApprovalCardAsk): ApprovalCardDraft | null {
    const options = ask.params.options
    if (!options.length || options.length > TELEGRAM_APPROVAL_MAX_OPTIONS) return null
    const widest = telegramApprovalData(ask.requestId, options.length - 1)
    if (Buffer.byteLength(widest, 'utf8') > TELEGRAM_CALLBACK_DATA_CAP) return null
    const buttons = options.map((o, i) => [
      { text: clampTo(o.name, TELEGRAM_BUTTON_LABEL_CAP), callbackData: telegramApprovalData(ask.requestId, i) }
    ])
    const head = ask.subsession ? intro(ask.subsession) : ''
    return {
      text: plain(`${head}🔒 Permission requested — ${permToolLabel(ask.params)}`),
      buttons
    } satisfies TelegramApprovalDraft
  },

  settled(card: ApprovalCardSettlement): ApprovalCardDraft {
    const head = card.subsession ? intro(card.subsession) : ''
    const decision = `${approvalMark(card.allowed)} ${clampTo(card.text, TELEGRAM_APPROVAL_DECISION_CAP)}`
    return {
      text: plain(`${head}🔒 Permission — ${permToolLabel(card.params)}\n${decision}`),
      buttons: []
    } satisfies TelegramApprovalDraft
  },

  notice(asker: SubsessionAsker): ApprovalCardDraft {
    const who = subsessionAskerText(asker.agentName, asker.title, clampTo)
    return {
      text: plain(
        `🔒 ${who} is waiting for permission. Ask an Agent editor to allow it from the Agent or Session page. ${subsessionWaitText(asker.waitHours)}\nOpen the task: ${asker.sessionUrl}`
      )
    } satisfies TelegramApprovalDraft
  },

  noticeSettled(view: SubsessionNoticeView, outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const line = subsessionSettledText(subsessionAskerText(view.agentName, view.title, clampTo), outcome, (s) =>
      clampTo(s, 60)
    )
    const link = view.sessionUrl ? `\nOpen the task: ${view.sessionUrl}` : ''
    return { text: plain(`${line}${link}`) } satisfies TelegramApprovalDraft
  },

  turnNotice(): ApprovalCardDraft {
    return { text: TURN_NOTICE_TEXT } satisfies TelegramApprovalDraft
  },

  turnNoticeSettled(outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    return { text: plain(turnNoticeSettledText(outcome, (s) => clampTo(s, 60))) } satisfies TelegramApprovalDraft
  },

  orphaned(row: ApprovalCardOrphan): ApprovalCardDraft {
    const by = row.resolvedByName ? ` by ${clampTo(row.resolvedByName, 60)}` : ''
    return {
      text: plain(`🔒 Permission — ${clampTo(row.command, 150)}\n${orphanMark(row.status)} ${row.status}${by}`),
      buttons: []
    } satisfies TelegramApprovalDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as TelegramApprovalDraft
    // Anchored as the turn's other posts are, so a `tg:<root>` session keeps the card in its reply chain.
    const { replyTo } = host.turnState(turn) as TelegramTurnState
    const anchor = { threadTs: turn.plan.thread, ...(replyTo !== undefined ? { replyTo } : {}) }
    // A notice has no keyboard, so it is posted as the plain line `rewrite` edits.
    return await host.postCardSerialized(turn, (conn) =>
      d.buttons
        ? (conn as TelegramConnection).postCard(turn.plan.channel, d.text, d.buttons, anchor)
        : (conn as TelegramConnection).postChrome(turn.plan.channel, d.text, anchor)
    )
  },

  async post(conn: unknown, place: ApprovalCardPlace, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as TelegramApprovalDraft
    const tg = conn as TelegramConnection
    const anchor = anchorOf(place)
    return d.buttons?.length
      ? await tg.postCard(place.channel, d.text, d.buttons, anchor)
      : await tg.postChrome(place.channel, d.text, anchor)
  },

  rewrite(handle: ApprovalCardHandle, draft: ApprovalCardDraft): void {
    const id = handle.ts === undefined ? NaN : Number(handle.ts)
    if (!Number.isInteger(id)) return
    const d = draft as TelegramApprovalDraft
    const tg = handle.conn as TelegramConnection
    // A keyboard, even an empty one, is what removes a card's buttons; a notice never had any.
    const done = d.buttons
      ? tg.editCard(handle.channel, id, d.text, d.buttons)
      : tg.updateMessage(handle.channel, String(id), d.text)
    void done.catch(() => {})
  }
}
