/**
 * Telegram's **elicitation-card facet** (§7.3) — the second implementer of
 * {@link ElicitCardFacet}, and the reason the member exists rather than being guessed from Slack.
 *
 * WHAT TELEGRAM ACTUALLY HAS is one control: an inline keyboard of tappable buttons, each echoing
 * a ≤64-BYTE `callback_data` back as a `callback_query`. There is no multi-select widget and no
 * typed box — a Bot API keyboard is buttons and nothing else — so a MULTI-SELECT is assembled out
 * of the one control there is: one button per option, its label carrying the checkbox, a tap
 * toggling it and redrawing the keyboard, and a Confirm submitting the set. The state that lives
 * in a Slack message's own `state.values` lives here in the card's `cardState` slot instead,
 * because 64 bytes of `callback_data` cannot carry a selection. Everything else — a typed box, a
 * multi-question form, URL mode — is still declined with the notice #1819/#1839 already post.
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
import { elicitFormBlockId } from '@agentconnect.md/protocol'
import type {
  ElicitCardAsk,
  ElicitCardDraft,
  ElicitCardFacet,
  ElicitCardHandle,
  ElicitCardHost,
  ElicitCardMark,
  ElicitCardSettlement,
  ElicitCardTap,
  ElicitCardTapTarget,
  ElicitCardTurn
} from '../elicit-card.js'
import type { InlineButton, TelegramConnection } from '../../telegram/connection.js'
import { TELEGRAM_MESSAGE_LIMIT } from '../../telegram/render.js'
import type { TelegramTurnState } from './turn-output.js'
import {
  clampTo,
  elicitCardShape,
  elicitFormFieldHint,
  elicitOptionToken,
  type ElicitKind,
  type ElicitSurface,
  type ElicitTarget
} from '../../slack/render.js'

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
 * produce — and a longer list is declined whole, never trimmed to fit. A checkbox card adds one
 * more button and a two-character tick per label, which the same headroom covers.
 */
const TELEGRAM_ELICIT_MAX_BUTTONS = 24

/** Telegram's own cap on one button's `callback_data`, in BYTES of UTF-8 — verified live
 *  2026-09-08: 64 bytes is accepted, 65 is `BUTTON_DATA_INVALID`, and 32 two-byte characters
 *  (64 bytes) are accepted where 64 of them (128 bytes) are not. */
const TELEGRAM_CALLBACK_DATA_CAP = 64

const TELEGRAM_ELICIT_PREFIX = 'ac_el'

/** The token a Dismiss button carries. Not a position, because Dismiss answers no option. */
const TELEGRAM_ELICIT_DISMISS = 'x'

/** The token a Confirm button carries — the tap that SUBMITS an assembled card. Not a position
 *  for the same reason Dismiss is not: it names no option, it names the set of them. */
const TELEGRAM_ELICIT_CONFIRM = 'ok'

/** How an assembled card draws one option's checkbox. Literal emoji, as the marks are. */
const TELEGRAM_ELICIT_CHECKED = '\u2611\ufe0f'
const TELEGRAM_ELICIT_UNCHECKED = '\u2b1c\ufe0f'

/**
 * How much of the ANSWER a settled card echoes back. The decision core supplies is not bounded —
 * a scalar's is `String(answer)`, and an enum option's value can be a path, an id or a long URL —
 * so the surface that renders it is what bounds it. What the READER sees is clamped; what the
 * AGENT receives is not (#1844's rule), because the accepted content is built from the raw answer
 * and never from this text.
 */
const TELEGRAM_ELICIT_DECISION_CAP = 300

/** How much of the question one card carries: whatever is left once the settlement line is
 *  reserved, so the rewrite still fits after the ask did. Derived from the decision cap rather
 *  than written beside it — the two drifting apart is exactly how a settlement stops landing.
 *  The 8 covers the mark, the space and the newline with room to spare. */
const TELEGRAM_ELICIT_MESSAGE_CAP = TELEGRAM_MESSAGE_LIMIT - TELEGRAM_ELICIT_DECISION_CAP - 8

/** How Telegram spells each settlement mark. Literal emoji: a Telegram message has no shortcode
 *  vocabulary, so Slack's `:white_check_mark:` would reach the reader as its own source text. */
const TELEGRAM_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

/**
 * What a Telegram elicitation card can render AND collect: the two kinds one TAP answers, plus the
 * multi-select a keyboard of checkboxes assembles over several taps. A typed box is still absent —
 * nothing in a keyboard accepts characters — so `text` and `number`, and therefore every form
 * carrying one, stay declined rather than posted as a control that cannot take an answer.
 */
export const TELEGRAM_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum']),
  optionLimits: {
    enum: { maxOptions: TELEGRAM_ELICIT_MAX_BUTTONS },
    // A checkbox keyboard is the SAME keyboard, one row longer for its Confirm — so it is bounded
    // by the same measured refusal, not by a second number that could drift away from it.
    'multi-enum': { maxOptions: TELEGRAM_ELICIT_MAX_BUTTONS }
  }
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

/** One tappable button per option, each carrying its own checkbox, plus a Confirm/Dismiss row.
 *  `chosen` holds POSITIONS, which is what the buttons carry and what the Confirm submits. Pure. */
export function telegramElicitCheckboxes(
  requestId: string,
  options: readonly { label: string }[],
  chosen: ReadonlySet<number>
): InlineButton[][] {
  const rows = options.map((o, i) => [
    {
      text: `${chosen.has(i) ? TELEGRAM_ELICIT_CHECKED : TELEGRAM_ELICIT_UNCHECKED} ${o.label}`,
      callbackData: telegramElicitData(requestId, elicitOptionToken(i))
    }
  ])
  rows.push([
    { text: 'Confirm', callbackData: telegramElicitData(requestId, TELEGRAM_ELICIT_CONFIRM) },
    { text: 'Dismiss', callbackData: telegramElicitData(requestId, TELEGRAM_ELICIT_DISMISS) }
  ])
  return rows
}

/** An assembled card's own text: the question, then what the reader has to know to answer it that
 *  no checkbox can say — the field's description and a multi-select's bounds, which Telegram
 *  cannot enforce on the keyboard the way Slack's `max_selected_items` does. Pure. */
export function telegramElicitFormText(message: string, target: ElicitTarget): string {
  const hint = elicitFormFieldHint(target)
  return `${telegramElicitText(message)}${hint ? `\n${hint}` : ''}`
}

/** The one field an assembled Telegram card renders, or null when this form is not one — today
 *  exactly a lone multi-select, the only kind a keyboard can assemble without a typed box. Pure. */
export function telegramAssembledField(form: readonly ElicitTarget[]): ElicitTarget | null {
  const only = form.length === 1 ? form[0]! : null
  return only && only.kind === 'multi-enum' ? only : null
}

/** Telegram's per-turn elicitation draft: the message and the keyboard under it. */
interface TelegramElicitDraft {
  text: string
  buttons: InlineButton[][]
}

/** What a checkbox card has collected so far — the POSITIONS ticked, kept in the card's own state
 *  slot because a 64-byte `callback_data` cannot carry a selection back the way a Slack message's
 *  `state.values` does. It never leaves this module: core stores it opaquely and drops it with the
 *  record, so a card that ends without a Confirm leaves nothing behind. */
interface TelegramElicitCardState {
  chosen: Set<number>
}

function cardStateOf(handle: ElicitCardHandle): TelegramElicitCardState {
  const existing = handle.cardState as TelegramElicitCardState | undefined
  if (existing) return existing
  const fresh: TelegramElicitCardState = { chosen: new Set<number>() }
  handle.cardState = fresh
  return fresh
}

export const telegramElicitCards: ElicitCardFacet = {
  platform: 'telegram',
  reduction: TELEGRAM_ELICIT_SURFACE,

  build(_host: ElicitCardHost, _turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    // No consent control, and no control for a typed box or a form carrying one.
    if (ask.url || !ask.form?.length) return null
    const oneTap = elicitCardShape(ask.form) === 'buttons'
    const assembled = oneTap ? null : telegramAssembledField(ask.form)
    if (!oneTap && !assembled) return null
    const target = assembled ?? ask.form[0]!
    if (!target.options.length || !telegramElicitDataFits(ask.requestId, target.options.length)) return null
    const draft: TelegramElicitDraft = assembled
      ? {
          text: telegramElicitFormText(ask.message, assembled),
          buttons: telegramElicitCheckboxes(ask.requestId, assembled.options, new Set())
        }
      : {
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
    // The card anchors exactly as every other post of this turn does — through the turn's own
    // state slot, the same `replyTo` `applyTelegramAction` reads. `threadTs` alone is not an
    // anchor off a forum: `postCard` only turns a NUMERIC thread into `message_thread_id`, so a
    // `tg:<root>` supergroup session would drop the card at the chat root, and a reader replying
    // to it would root a fresh reply chain on the card instead of continuing this session.
    const { replyTo } = host.turnState(turn) as TelegramTurnState
    return await host.postCardSerialized(turn, (conn) =>
      (conn as TelegramConnection).postCard(turn.plan.channel, d.text, d.buttons, {
        threadTs: turn.plan.thread,
        ...(replyTo !== undefined ? { replyTo } : {})
      })
    )
  },

  /**
   * Fold one tap into a checkbox card: an option position TOGGLES and the keyboard is redrawn in
   * place, and the Confirm submits every ticked position as the field's carried value — the same
   * `ac_o<n>` list a Slack multi-select's Confirm carries, under the same block id, so core's one
   * re-derivation (#1815) validates both without knowing which surface sent it.
   *
   * Nothing is enforced here that core enforces on the answer: a selection breaking the field's
   * own `minItems`/`maxItems` is refused by the submission with the field's own words, exactly as
   * a Slack Confirm's is. Toggling is free; the Confirm is where a card is judged.
   */
  tap(handle: ElicitCardHandle, card: ElicitCardTapTarget, token: string): ElicitCardTap | null {
    const target = telegramAssembledField(card.form)
    if (!target) return null
    const state = cardStateOf(handle)
    if (token === TELEGRAM_ELICIT_CONFIRM) {
      const picked = [...state.chosen].sort((a, b) => a - b).map(elicitOptionToken)
      return { kind: 'submit', fields: { [elicitFormBlockId(0)]: picked } }
    }
    const index = target.options.findIndex((_o, i) => elicitOptionToken(i) === token)
    if (index < 0) return null
    if (state.chosen.has(index)) state.chosen.delete(index)
    else state.chosen.add(index)
    // Best effort, like every other card rewrite: a redraw that fails leaves the reader looking at
    // the previous ticks, and the Confirm still submits what THIS daemon recorded.
    const messageId = handle.ts === undefined ? NaN : Number(handle.ts)
    if (Number.isInteger(messageId)) {
      const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
      void (handle.conn as TelegramConnection)
        .editCard(
          handle.channel,
          messageId,
          telegramElicitFormText(message, target),
          telegramElicitCheckboxes(card.requestId, target.options, state.chosen)
        )
        .catch(() => {})
    }
    return { kind: 'pending' }
  },

  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    if (handle.ts === undefined) return
    const messageId = Number(handle.ts)
    if (!Number.isInteger(messageId)) return
    const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
    const decision = `${TELEGRAM_ELICIT_MARK[card.mark]} ${clampTo(card.text, TELEGRAM_ELICIT_DECISION_CAP)}`
    // Belt to the reserve's braces. The reserve only holds while both halves are bounded, and an
    // edit refused for length lands AFTER ACP accepted and the pending record went — there is
    // nothing left to retry against, so the card would keep offering buttons that answer nothing.
    // Clamping by UTF-16 length is conservative: Telegram's 4096 counts CODEPOINTS, of which a
    // JS string never has more than it has units (verified live 2026-09-08).
    const text = clampTo(`${telegramElicitText(message)}\n${decision}`, TELEGRAM_MESSAGE_LIMIT)
    // An empty keyboard is what drops the buttons; the answered card stays readable in the chat.
    void (handle.conn as TelegramConnection).editCard(handle.channel, messageId, text, []).catch(() => {})
  }
}
