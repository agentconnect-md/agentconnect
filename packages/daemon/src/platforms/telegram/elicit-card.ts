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
  ElicitCardReply,
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
  elicitFieldExpectation,
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

/** The token the button that OPENS A PROMPT carries — the one control a keyboard has for a field
 *  that must be typed. It names no option either: it asks for the box, it does not answer. */
const TELEGRAM_ELICIT_PROMPT = 'ed'

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
 * What a Telegram elicitation card can render AND collect: the two kinds one TAP answers, the
 * multi-select a keyboard of checkboxes assembles over several taps, and — since a `force_reply`
 * IS the Bot API's input box — a typed one. A keyboard accepts no characters, so the card carries
 * a button that opens the box instead, and the reply comes back naming the message it answers.
 *
 * A form of SEVERAL questions is still declined: one prompt at a time is a state machine across
 * fields, and a reader who walks away mid-way would leave half a form standing.
 */
export const TELEGRAM_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum', 'text', 'number']),
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
 *  cannot enforce on the keyboard the way Slack's `max_selected_items` does.
 *
 *  The hint is inside the same budget the question is, and it is the QUESTION that yields: a hint
 *  runs to 2000 characters where the message limit is 4096, so appending it to an already-clamped
 *  question could push the whole card past what `sendMessage` takes — and a refused post is not a
 *  shortened card, it is no card at all, cancelled without even the unrenderable notice. Pure. */
export function telegramElicitFormText(message: string, target: ElicitTarget): string {
  const hint = elicitFormFieldHint(target)
  if (!hint) return telegramElicitText(message)
  return `${telegramElicitText(clampTo(message, Math.max(0, TELEGRAM_ELICIT_MESSAGE_CAP - hint.length - 1)))}\n${hint}`
}

/** The one field an assembled Telegram card renders, or null when this form is not one — a LONE
 *  multi-select, which the keyboard ticks, or a lone typed field, which a prompt collects. Several
 *  questions are not one of these: they would need a prompt per field. Pure. */
export function telegramAssembledField(form: readonly ElicitTarget[]): ElicitTarget | null {
  const only = form.length === 1 ? form[0]! : null
  if (!only) return null
  return only.kind === 'multi-enum' || only.kind === 'text' || only.kind === 'number' ? only : null
}

/** The keyboard under a card whose answer must be TYPED: the button that opens the box, and
 *  Dismiss. There is no Confirm — the reply IS the submission, so a second tap would only be a
 *  chance to lose it. Pure. */
export function telegramElicitPromptButtons(requestId: string): InlineButton[][] {
  return [
    [
      { text: 'Answer', callbackData: telegramElicitData(requestId, TELEGRAM_ELICIT_PROMPT) },
      { text: 'Dismiss', callbackData: telegramElicitData(requestId, TELEGRAM_ELICIT_DISMISS) }
    ]
  ]
}

/** What the prompt message says above the reader's own compose box: the question again, because a
 *  reply box on Telegram quotes only a snippet and the card may have scrolled away. Pure. */
export function telegramElicitPromptText(message: string, target: ElicitTarget): string {
  return telegramElicitFormText(message, target)
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
  /** The open `force_reply` prompt's own message id, which is what a reply to it names. Absent
   *  until the reader asks for the box, and again once the prompt has been answered. */
  promptTs?: string
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
    // A typed field offers no options at all; every other card's widest button must fit 64 bytes.
    const typed = target.kind === 'text' || target.kind === 'number'
    if (!typed && (!target.options.length || !telegramElicitDataFits(ask.requestId, target.options.length))) return null
    if (typed && !telegramElicitDataFits(ask.requestId, 1)) return null
    const draft: TelegramElicitDraft = typed
      ? {
          text: telegramElicitFormText(ask.message, target),
          buttons: telegramElicitPromptButtons(ask.requestId)
        }
      : assembled
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
    const messageId = handle.ts === undefined ? NaN : Number(handle.ts)
    // A typed field is answered in a box, never on the keyboard: the one button it has asks for
    // that box. Opening it is not an answer, so the card stays exactly as open as it was.
    if (target.kind === 'text' || target.kind === 'number') {
      if (token !== TELEGRAM_ELICIT_PROMPT || !Number.isInteger(messageId)) return null
      const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
      // The prompt REPLIES to the card, which is also what keeps it inside a forum topic: Telegram
      // places a reply where the message it answers is, so no thread coordinate is re-derived here.
      void (handle.conn as TelegramConnection)
        .postPrompt(handle.channel, telegramElicitPromptText(message, target), {
          replyTo: messageId,
          placeholder: elicitFieldExpectation(target)
        })
        .then((ts) => {
          if (ts !== undefined) state.promptTs = ts
        })
        .catch(() => {})
      return { kind: 'pending' }
    }
    if (token === TELEGRAM_ELICIT_CONFIRM) {
      const picked = [...state.chosen].sort((a, b) => a - b).map(elicitOptionToken)
      return { kind: 'submit', fields: { [elicitFormBlockId(0)]: picked } }
    }
    const index = target.options.findIndex((_o, i) => elicitOptionToken(i) === token)
    if (index < 0) return null
    // A tick nobody can be shown is not recorded. What the keyboard shows and what a Confirm would
    // submit are ONE fact here — unlike Slack, where the message itself holds the reader's half-
    // filled state — so a card with no addressable message refuses the tap instead of remembering
    // a selection its own boxes still show unticked.
    if (!Number.isInteger(messageId)) return null
    if (state.chosen.has(index)) state.chosen.delete(index)
    else state.chosen.add(index)
    // Best effort, like every other card rewrite: a redraw that fails leaves the reader looking at
    // the previous ticks, and the Confirm still submits what THIS daemon recorded.
    const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
    void (handle.conn as TelegramConnection)
      .editCard(
        handle.channel,
        messageId,
        telegramElicitFormText(message, target),
        telegramElicitCheckboxes(card.requestId, target.options, state.chosen)
      )
      .catch(() => {})
    return { kind: 'pending' }
  },

  /**
   * Claim a typed reply for this card: it answers only the PROMPT this card opened, matched by the
   * message the reply names. That is the whole of the scoping — anyone who can see the card may
   * answer it, exactly as its buttons allow, and one prompt belongs to one card, so an answer can
   * never land on a question its writer never saw (#1828's rule, kept).
   *
   * The words go back as the field's own carried value, which for a typed field IS the text: core
   * then validates it the way it validates a Confirm, so a number that is not a number and a
   * string breaking its own `pattern` are refused with the field's own words.
   */
  claimReply(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null {
    const target = telegramAssembledField(card.form)
    if (!target || (target.kind !== 'text' && target.kind !== 'number')) return null
    const state = handle.cardState as TelegramElicitCardState | undefined
    if (!state?.promptTs || state.promptTs !== reply.replyTo) return null
    const text = reply.text.trim()
    if (!text) return null
    // The prompt is deliberately NOT spent here. An accepted answer settles the card, and a card
    // that is gone claims nothing more; a REFUSED one is still open, and the reader who has just
    // been told what was wrong is typing into the very box that should still take their retry.
    return { kind: 'submit', fields: { [elicitFormBlockId(0)]: text } }
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
    // And a prompt still standing would keep offering a box for a question that is over. Editing
    // it is what drops its `force_reply`, so no reader is left typing into a closed card.
    const promptTs = (handle.cardState as TelegramElicitCardState | undefined)?.promptTs
    const promptId = promptTs === undefined ? NaN : Number(promptTs)
    if (Number.isInteger(promptId))
      void (handle.conn as TelegramConnection).editCard(handle.channel, promptId, decision, []).catch(() => {})
  }
}
