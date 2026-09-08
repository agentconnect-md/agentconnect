/**
 * Telegram's **elicitation-card facet** (§7.3) — the second implementer of
 * {@link ElicitCardFacet}, and the reason the member exists rather than being guessed from Slack.
 *
 * WHAT TELEGRAM ACTUALLY HAS is one control: an inline keyboard of tappable buttons, each echoing
 * a ≤64-BYTE `callback_data` back as a `callback_query`. It has no multi-select, no text box and
 * no number box in a message — a Bot API keyboard is buttons and nothing else — so `reduction`
 * below claims exactly the two kinds one TAP can answer, and every other kind is declined with
 * the notice #1819/#1839 already post rather than half-rendered into a control that cannot
 * submit. That is the same line {@link SLACK_DM_ELICIT_SURFACE} draws, for the same reason.
 *
 * URL MODE IS DECLINED TOO, and not for want of a link button. An inline `url` button opens the
 * page but fires no `callback_query`, so the daemon would never learn the reader consented — and
 * consent is the whole of what that seam decides, since the ACP request resolves AT consent
 * (#1810). A callback button that merely pastes the URL is not a consent control, it is a link;
 * declining is the honest answer.
 *
 * THE WIRE ENCODING LIVES HERE with the buttons that carry it, as `command-chrome.ts` already
 * requires of this platform. It is `ac_el:<requestId>:<token>`, where the token is the option's
 * POSITION (#1844's `ac_o<n>`) or `x` for Dismiss — reused rather than re-derived, because a
 * position is exactly what a capped wire field can carry and 64 bytes is a hard cap: an enum of
 * paths or ids would not fit its own values. Resolution is core's, against the card's own
 * re-derived form (#1815), so the position names the very option that was offered.
 *
 * THE REWRITE is `editMessageText` with no keyboard, which strips the buttons (verified live
 * 2026-09-08 against the Bot API: an edit omitting `reply_markup`, and one sending an empty
 * `inline_keyboard`, both return a message with no markup).
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
import type { InlineButton, TelegramConnection } from '../../telegram/connection.js'
import { TELEGRAM_MESSAGE_LIMIT } from '../../telegram/render.js'
import { clampTo, elicitCardShape, elicitOptionToken, type ElicitKind, type ElicitSurface } from '../../slack/render.js'

/**
 * The most options one Telegram elicitation keyboard offers.
 *
 * Telegram publishes no button-count cap: what it refuses is an over-large `reply_markup` as a
 * whole (`Bad Request: reply markup is too long`), so a COUNT can never bound it on its own and
 * `optionLimits` is a count. Measured against the live Bot API on 2026-09-08, the smallest card
 * refused was 60 buttons whose labels were the full 75 characters a reduced option label can
 * reach; 24 such buttons plus Dismiss serialized to 5.7 KB and was accepted, as were 40 buttons
 * of 75 four-byte characters each (9.1 KB). 24 is therefore Slack's own button cap re-derived
 * from Telegram's own refusals, with better than 2x headroom on the worst list this reduction can
 * produce — and a longer list is declined whole, never trimmed to fit.
 */
const TELEGRAM_ELICIT_MAX_BUTTONS = 24

/** Telegram's own cap on one button's `callback_data`, in BYTES of UTF-8 — verified live
 *  2026-09-08: 64 bytes is accepted, 65 is `BUTTON_DATA_INVALID`, and 32 two-byte characters
 *  (64 bytes) are accepted where 64 of them (128 bytes) are not. */
const TELEGRAM_CALLBACK_DATA_CAP = 64

const TELEGRAM_ELICIT_PREFIX = 'ac_el'

/** The token a Dismiss button carries. Not a position, because Dismiss answers no option. */
const TELEGRAM_ELICIT_DISMISS = 'x'

/** How much of the question one card carries, leaving the whole settlement line room inside
 *  Telegram's message limit — a rewrite must never be refused for length after the ask fit. */
const TELEGRAM_ELICIT_MESSAGE_CAP = TELEGRAM_MESSAGE_LIMIT - 300

/** How Telegram spells each settlement mark. Literal emoji: a Telegram message has no shortcode
 *  vocabulary, so Slack's `:white_check_mark:` would reach the reader as its own source text. */
const TELEGRAM_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

/**
 * What a Telegram elicitation card can render AND collect: the two kinds one TAP answers, and no
 * more. A keyboard button submits the instant it is tapped, so a kind needing something filled in
 * first could be shown but never confirmed — the same verdict, and the same reasoning, as the
 * approval DM's surface.
 */
export const TELEGRAM_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean']),
  optionLimits: { enum: { maxOptions: TELEGRAM_ELICIT_MAX_BUTTONS } }
}

/** One button's `callback_data`: the request and the option's position. Pure. */
export function telegramElicitData(requestId: string, token: string): string {
  return `${TELEGRAM_ELICIT_PREFIX}:${requestId}:${token}`
}

/** Whether every button of this card fits Telegram's 64-byte `callback_data`. Checked at build
 *  time so a longer request id could never mint a card the API silently refuses whole; the widest
 *  data a card mints is its LAST option's, so that one answers for all of them. Pure. */
export function telegramElicitDataFits(requestId: string, options: number): boolean {
  const widest = telegramElicitData(requestId, elicitOptionToken(Math.max(0, options - 1)))
  return Buffer.byteLength(widest, 'utf8') <= TELEGRAM_CALLBACK_DATA_CAP
}

/** Decode a tapped elicitation button: the request, and the position tapped (null for Dismiss,
 *  which settles the card as a decline). Null for callback data this scheme did not mint — a
 *  session-control tap (`m:2`) and a stray one alike. Pure. */
export function parseTelegramElicit(data: string): { requestId: string; token: string | null } | null {
  const m = /^ac_el:([0-9a-fA-F-]{1,64}):([A-Za-z0-9_]{1,16})$/.exec(data)
  if (!m) return null
  const token = m[2] as string
  return { requestId: m[1] as string, token: token === TELEGRAM_ELICIT_DISMISS ? null : token }
}

/** The card's own text: the question, on the same speech-balloon line every surface opens with.
 *  Plain text — the card is posted with no `parse_mode`, so there is no markup to defuse and
 *  nothing the agent can write that becomes a link or a label. Pure. */
export function telegramElicitText(message: string): string {
  return `💬 ${clampTo(message, TELEGRAM_ELICIT_MESSAGE_CAP)}`
}

/** One tappable button per option, plus Dismiss — one per row, so a long label is readable
 *  rather than squeezed. Each carries its option's POSITION. Pure. */
export function telegramElicitButtons(requestId: string, options: readonly { label: string }[]): InlineButton[][] {
  const rows = options.map((o, i) => [
    { text: o.label, callbackData: telegramElicitData(requestId, elicitOptionToken(i)) }
  ])
  rows.push([{ text: 'Dismiss', callbackData: telegramElicitData(requestId, TELEGRAM_ELICIT_DISMISS) }])
  return rows
}

/** Telegram's per-turn elicitation draft: the message and the keyboard under it. */
interface TelegramElicitDraft {
  text: string
  buttons: InlineButton[][]
}

export const telegramElicitCards: ElicitCardFacet = {
  platform: 'telegram',
  reduction: TELEGRAM_ELICIT_SURFACE,

  build(_host: ElicitCardHost, _turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    // No consent control, and no control for anything that has to be filled in first.
    if (ask.url || !ask.form?.length) return null
    if (elicitCardShape(ask.form) !== 'buttons') return null
    const target = ask.form[0]!
    if (!target.options.length || !telegramElicitDataFits(ask.requestId, target.options.length)) return null
    const draft: TelegramElicitDraft = {
      text: telegramElicitText(ask.message),
      buttons: telegramElicitButtons(ask.requestId, target.options)
    }
    return draft
  },

  async send(
    host: ElicitCardHost,
    turn: ElicitCardTurn,
    _ask: ElicitCardAsk,
    draft: ElicitCardDraft
  ): Promise<string | undefined> {
    const d = draft as TelegramElicitDraft
    return await host.postCardSerialized(turn, (conn) =>
      (conn as TelegramConnection).postCard(turn.plan.channel, d.text, d.buttons, { threadTs: turn.plan.thread })
    )
  },

  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    if (handle.ts === undefined) return
    const messageId = Number(handle.ts)
    if (!Number.isInteger(messageId)) return
    const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
    const text = `${telegramElicitText(message)}\n${TELEGRAM_ELICIT_MARK[card.mark]} ${card.text}`
    // An empty keyboard is what drops the buttons; the answered card stays readable in the chat.
    void (handle.conn as TelegramConnection).editCard(handle.channel, messageId, text, []).catch(() => {})
  }
}
