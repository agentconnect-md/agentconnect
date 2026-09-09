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
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
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
  elicitFieldExpectation,
  elicitFormFieldHint,
  elicitFormFieldLabel,
  elicitOptionLiteral,
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

/** The token that returns a field's own keyboard to the card's overview. Names no field: there
 *  is one overview, and going back to it is the same act whichever field was open. */
const TELEGRAM_ELICIT_BACK = 'bk'

/** A form field's own token: `f<i>` opens field i, `f<i>o<n>` picks or ticks its option n. A field
 *  index and an option position both fit what a 64-byte `callback_data` has left after the request
 *  id (21 characters), and both are bounded — ten fields, twenty-four options. Pure. */
export function telegramElicitFieldToken(field: number, option?: number): string {
  return option === undefined ? `f${field}` : `f${field}o${option}`
}

/** The field, and the option within it, one form token names — null for anything else. Pure. */
export function parseTelegramElicitField(token: string): { field: number; option?: number } | null {
  const m = /^f(\d{1,2})(?:o(\d{1,3}))?$/.exec(token)
  if (!m) return null
  const field = Number(m[1])
  return m[2] === undefined ? { field } : { field, option: Number(m[2]) }
}

/** The token the button that OPENS A PROMPT carries — the one control a keyboard has for a field
 *  that must be typed. It names no option either: it asks for the box, it does not answer. */
const TELEGRAM_ELICIT_PROMPT = 'ed'

/** How an assembled card draws one option's checkbox, and — for a field that takes ONE of them —
 *  its radio. Two vocabularies because they promise different things: a tick accumulates, a dot
 *  replaces. Literal emoji, as the marks are. */
const TELEGRAM_ELICIT_CHECKED = '\u2611\ufe0f'
const TELEGRAM_ELICIT_UNCHECKED = '\u2b1c\ufe0f'
const TELEGRAM_ELICIT_PICKED = '\ud83d\udd35'
const TELEGRAM_ELICIT_UNPICKED = '\u26aa'

/** How long one button's label may be. Telegram publishes no per-button cap — an over-large
 *  `reply_markup` is refused as a whole (see {@link TELEGRAM_ELICIT_MAX_BUTTONS}) — so this is the
 *  75 characters a reduced option label already clamps to, applied to the composed labels a form
 *  card builds so the measured headroom keeps holding. */
const TELEGRAM_BUTTON_LABEL_CAP = 75

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

/** The one field an assembled SINGLE-FIELD Telegram card renders, or null when this form is not
 *  one — a LONE multi-select, which the keyboard ticks, or a lone typed field, which a prompt
 *  collects. Several questions take the form card instead. Pure. */
export function telegramAssembledField(form: readonly ElicitTarget[]): ElicitTarget | null {
  const only = form.length === 1 ? form[0]! : null
  if (!only) return null
  return only.kind === 'multi-enum' || only.kind === 'text' || only.kind === 'number' ? only : null
}

/**
 * Which of Telegram's four elicitation cards a reduction takes, or null for none.
 *
 * One keyboard, four uses, decided ONCE here rather than re-derived by `build` and again by `tap`
 * — the two disagreeing is how a card gets a control its own fold does not understand.
 *
 * - `buttons` — a lone single-select or boolean: one tap is the whole answer.
 * - `checkboxes` — a lone multi-select: a flat tick list with one Confirm.
 * - `prompt` — a lone typed field: a button that opens a `force_reply` box.
 * - `form` — several questions: one row per field over the same keyboard, each opening the field's
 *   own controls, with ONE Confirm for the whole card. This is also the shape a question that
 *   brought a free-text companion takes ("pick one, or type your own"), which is two TARGETS.
 */
export type TelegramCardShape = 'buttons' | 'checkboxes' | 'prompt' | 'form'

export function telegramCardShape(form: readonly ElicitTarget[]): TelegramCardShape | null {
  if (!form.length) return null
  if (form.length > 1) return 'form'
  const only = form[0]!
  if (only.kind === 'enum' || only.kind === 'boolean') return only.options.length ? 'buttons' : null
  if (only.kind === 'multi-enum') return only.options.length ? 'checkboxes' : null
  return 'prompt'
}

/** What a form card's row says a field currently holds — the chosen labels, in the card's own
 *  words, or an em dash for a field nobody has filled in yet.
 *
 *  A form card holds its answers as the wire holds them: an option field's value is that option's
 *  POSITION (`ac_o<n>`), because that is what the Confirm submits and what core re-derives against
 *  the card's own form (#1815). So the label is looked up THROUGH the position, never from the
 *  stored string. A typed field has no options and holds its own words. Pure. */
export function telegramFieldValueLabel(target: ElicitTarget, value: string | string[] | undefined): string {
  if (value === undefined) return '—'
  if (!target.options.length) return Array.isArray(value) ? value.join(', ') : value
  const label = (carried: string) => {
    const literal = elicitOptionLiteral(target, carried)
    return target.options.find((o) => o.value === literal)?.label ?? carried
  }
  if (Array.isArray(value)) return value.length ? value.map(label).join(', ') : 'none'
  return label(value)
}

/** A form card's OVERVIEW keyboard: one row per field, saying what it holds and opening its own
 *  controls, then the single Confirm the whole card submits on and Dismiss. Pure. */
export function telegramElicitFormButtons(
  requestId: string,
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[],
  values: readonly (string | string[] | undefined)[]
): InlineButton[][] {
  const rows = form.map((target, i) => [
    {
      text: clampTo(
        `${elicitFormFieldLabel(params, target)}: ${telegramFieldValueLabel(target, values[i])}`,
        TELEGRAM_BUTTON_LABEL_CAP
      ),
      callbackData: telegramElicitData(requestId, telegramElicitFieldToken(i))
    }
  ])
  rows.push([
    { text: 'Confirm', callbackData: telegramElicitData(requestId, TELEGRAM_ELICIT_CONFIRM) },
    { text: 'Dismiss', callbackData: telegramElicitData(requestId, TELEGRAM_ELICIT_DISMISS) }
  ])
  return rows
}

/** ONE field's own keyboard, opened from the overview: its options, each marked with what it
 *  currently is, and the way back. A single-select's pick returns to the overview by itself (the
 *  pick IS the whole of that field), so its way back is only for a reader who changed their mind;
 *  a multi-select's ticks accumulate, so `Done` is how it closes. Pure. */
export function telegramElicitFieldButtons(
  requestId: string,
  field: number,
  target: ElicitTarget,
  value: string | string[] | undefined
): InlineButton[][] {
  const multi = target.kind === 'multi-enum'
  // Held as POSITIONS, which is what the buttons carry and what the Confirm submits.
  const chosen = new Set(Array.isArray(value) ? value : value === undefined ? [] : [value])
  const mark = (n: number) =>
    multi
      ? chosen.has(elicitOptionToken(n))
        ? TELEGRAM_ELICIT_CHECKED
        : TELEGRAM_ELICIT_UNCHECKED
      : chosen.has(elicitOptionToken(n))
        ? TELEGRAM_ELICIT_PICKED
        : TELEGRAM_ELICIT_UNPICKED
  const rows = target.options.map((o, n) => [
    {
      text: clampTo(`${mark(n)} ${o.label}`, TELEGRAM_BUTTON_LABEL_CAP),
      callbackData: telegramElicitData(requestId, telegramElicitFieldToken(field, n))
    }
  ])
  rows.push([{ text: multi ? 'Done' : 'Back', callbackData: telegramElicitData(requestId, TELEGRAM_ELICIT_BACK) }])
  return rows
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

/** What a form card says while ONE of its fields is open: the question it belongs to, then that
 *  field's own label and whatever the field has to say for itself. Pure. */
export function telegramElicitFieldText(
  message: string,
  target: ElicitTarget,
  params: CreateElicitationRequest
): string {
  const hint = elicitFormFieldHint(target)
  return `${telegramElicitText(message)}\n${elicitFormFieldLabel(params, target)}${hint ? ` — ${hint}` : ''}`
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
  /** EVERY `force_reply` prompt this card has posted: its message id — which is what a reply to
   *  one names — against the FIELD it was opened for. All of them stay answerable until the card
   *  settles: each tap posts its own box, so two readers can be typing at once (or one reader can
   *  tap twice), and a box still on screen must not have stopped working because a later one
   *  appeared. The field is what lets one form hold an open box per question at the same time. */
  prompts: Map<string, number>
  /** A form card's answers so far, by field position — the state a Slack message keeps for itself
   *  in `state.values`. */
  values: (string | string[] | undefined)[]
  /** Which field's own keyboard is currently showing, if the overview is not. */
  open?: number
}

function cardStateOf(handle: ElicitCardHandle): TelegramElicitCardState {
  const existing = handle.cardState as TelegramElicitCardState | undefined
  if (existing) return existing
  const fresh: TelegramElicitCardState = { chosen: new Set<number>(), prompts: new Map<string, number>(), values: [] }
  handle.cardState = fresh
  return fresh
}

/**
 * Fold one tap on a FORM card, whose keyboard has two levels: the overview, one row per field,
 * and one field's own controls opened from it.
 *
 * Nothing here decides whether an answer is GOOD. The Confirm hands core the fields it has, keyed
 * as a Slack Confirm's are, and core's one re-derivation says whether a required field is missing,
 * a selection breaks its bounds, or a typed value breaks its `pattern` — with the card left live
 * and the field named. Moving any of that here would be a second opinion on the same question.
 */
function telegramFoldForm(
  state: TelegramElicitCardState,
  card: ElicitCardTapTarget,
  token: string,
  message: string,
  redraw: (text: string, buttons: InlineButton[][]) => { kind: 'pending' },
  openBox: (field: number, target: ElicitTarget) => { kind: 'pending' }
): ElicitCardTap | null {
  const overview = () => {
    state.open = undefined
    return redraw(
      telegramElicitText(message),
      telegramElicitFormButtons(card.requestId, card.params, card.form, state.values)
    )
  }
  if (token === TELEGRAM_ELICIT_BACK) return overview()
  if (token === TELEGRAM_ELICIT_CONFIRM) {
    const fields: Record<string, string | string[]> = {}
    for (const [i, value] of state.values.entries()) {
      // A field nobody filled in is an OMISSION, not an empty answer — core lets an optional one
      // be absent and refuses a required one by name, which is the same verdict on every surface.
      if (value !== undefined) fields[elicitFormBlockId(i)] = value
    }
    return { kind: 'submit', fields }
  }
  const named = parseTelegramElicitField(token)
  const target = named ? card.form[named.field] : undefined
  if (!named || !target) return null
  // Opening a field: a typed one has no keyboard control at all and goes straight to its box.
  if (named.option === undefined) {
    if (target.kind === 'text' || target.kind === 'number') return openBox(named.field, target)
    state.open = named.field
    return redraw(
      telegramElicitFieldText(message, target, card.params),
      telegramElicitFieldButtons(card.requestId, named.field, target, state.values[named.field])
    )
  }
  if (!target.options[named.option]) return null
  const carried = elicitOptionToken(named.option)
  if (target.kind === 'multi-enum') {
    const held = new Set(Array.isArray(state.values[named.field]) ? (state.values[named.field] as string[]) : [])
    if (held.has(carried)) held.delete(carried)
    else held.add(carried)
    // Kept in the field's OWN option order, so what the agent receives reads as the card did.
    state.values[named.field] = target.options.map((_o, n) => elicitOptionToken(n)).filter((t) => held.has(t))
    return redraw(
      telegramElicitFieldText(message, target, card.params),
      telegramElicitFieldButtons(card.requestId, named.field, target, state.values[named.field])
    )
  }
  // One of them: the pick IS the whole of this field, so it closes the field and shows the card.
  state.values[named.field] = carried
  return overview()
}

export const telegramElicitCards: ElicitCardFacet = {
  platform: 'telegram',
  reduction: TELEGRAM_ELICIT_SURFACE,

  build(_host: ElicitCardHost, _turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    // No consent control: an inline `url` button fires no callback_query, so consent could never
    // be observed, and consent is the whole of what that seam decides.
    if (ask.url || !ask.form?.length) return null
    const shape = telegramCardShape(ask.form)
    if (!shape) return null
    // Every card's WIDEST `callback_data` must fit 64 bytes, or the API refuses the whole message.
    // A form's widest is its last field's last option; a flat card's is its last option; a prompt
    // card mints one token and no positions at all.
    const widest =
      shape === 'form' ? Math.max(...ask.form.map((t) => t.options.length), 1) : ask.form[0]!.options.length || 1
    if (!telegramElicitDataFits(ask.requestId, widest)) return null
    if (shape === 'form') {
      const values = ask.form.map(() => undefined)
      return {
        text: telegramElicitText(ask.message),
        buttons: telegramElicitFormButtons(ask.requestId, ask.params, ask.form, values)
      } satisfies TelegramElicitDraft
    }
    const target = ask.form[0]!
    if (shape === 'prompt')
      return {
        text: telegramElicitFormText(ask.message, target),
        buttons: telegramElicitPromptButtons(ask.requestId)
      } satisfies TelegramElicitDraft
    if (shape === 'checkboxes')
      return {
        text: telegramElicitFormText(ask.message, target),
        buttons: telegramElicitCheckboxes(ask.requestId, target.options, new Set())
      } satisfies TelegramElicitDraft
    return {
      text: telegramElicitText(ask.message),
      buttons: telegramElicitButtons(ask.requestId, target.options)
    } satisfies TelegramElicitDraft
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
    const shape = telegramCardShape(card.form)
    // A card with no addressable message can show nothing, and nothing this fold does is worth
    // remembering unshown: what the keyboard shows and what a Confirm would submit are ONE fact
    // here, unlike Slack, where the message itself holds the reader's half-filled state.
    const messageId = handle.ts === undefined ? NaN : Number(handle.ts)
    if (!shape || !Number.isInteger(messageId)) return null
    const state = cardStateOf(handle)
    const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
    const redraw = (text: string, buttons: InlineButton[][]) => {
      // Best effort, like every other card rewrite: a redraw that fails leaves the reader looking
      // at the previous state, and the Confirm still submits what THIS daemon recorded.
      void (handle.conn as TelegramConnection).editCard(handle.channel, messageId, text, buttons).catch(() => {})
      return { kind: 'pending' } as const
    }
    // The prompt REPLIES to the card, which is also what keeps it inside a forum topic: Telegram
    // places a reply where the message it answers is, so no thread coordinate is re-derived here.
    const openBox = (field: number, target: ElicitTarget) => {
      void (handle.conn as TelegramConnection)
        .postPrompt(handle.channel, telegramElicitPromptText(message, target), {
          replyTo: messageId,
          placeholder: elicitFieldExpectation(target)
        })
        .then((ts) => {
          if (ts !== undefined) state.prompts.set(ts, field)
        })
        .catch(() => {})
      return { kind: 'pending' } as const
    }

    if (shape === 'form') return telegramFoldForm(state, card, token, message, redraw, openBox)

    const target = card.form[0]!
    // A typed field is answered in a box, never on the keyboard: the one button it has asks for
    // that box. Opening it is not an answer, so the card stays exactly as open as it was.
    if (shape === 'prompt') return token === TELEGRAM_ELICIT_PROMPT ? openBox(0, target) : null
    if (shape !== 'checkboxes') return null
    if (token === TELEGRAM_ELICIT_CONFIRM) {
      const picked = [...state.chosen].sort((a, b) => a - b).map(elicitOptionToken)
      return { kind: 'submit', fields: { [elicitFormBlockId(0)]: picked } }
    }
    const index = target.options.findIndex((_o, i) => elicitOptionToken(i) === token)
    if (index < 0) return null
    if (state.chosen.has(index)) state.chosen.delete(index)
    else state.chosen.add(index)
    return redraw(
      telegramElicitFormText(message, target),
      telegramElicitCheckboxes(card.requestId, target.options, state.chosen)
    )
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
    const state = handle.cardState as TelegramElicitCardState | undefined
    if (reply.replyTo === undefined) return null
    const field = state?.prompts.get(reply.replyTo)
    if (field === undefined) return null
    const target = card.form[field]
    if (!target || (target.kind !== 'text' && target.kind !== 'number')) return null
    const text = reply.text.trim()
    if (!text) return null
    // The prompt is deliberately NOT spent here. An accepted answer settles the card, and a card
    // that is gone claims nothing more; a REFUSED one is still open, and the reader who has just
    // been told what was wrong is typing into the very box that should still take their retry.
    //
    // A FORM's box does not submit the card, though: it fills ONE field, and the whole card is
    // still submitted by its own Confirm. So the words are recorded and the overview redrawn,
    // exactly as a picked option is — a single typed question has no other field to wait for, and
    // its box IS the submission.
    if (telegramCardShape(card.form) === 'form') {
      state!.values[field] = text
      const messageId = handle.ts === undefined ? NaN : Number(handle.ts)
      if (Number.isInteger(messageId)) {
        const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
        state!.open = undefined
        void (handle.conn as TelegramConnection)
          .editCard(
            handle.channel,
            messageId,
            telegramElicitText(message),
            telegramElicitFormButtons(card.requestId, card.params, card.form, state!.values)
          )
          .catch(() => {})
      }
      // The answered box is retired now rather than at settlement: the card lives on, and a box
      // left open would take a second answer to a field the overview already shows filled in.
      state!.prompts.delete(reply.replyTo)
      void (handle.conn as TelegramConnection).deleteMessage(handle.channel, reply.replyTo).catch(() => {})
      return { kind: 'pending' }
    }
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
    // Every prompt still standing would keep offering a box for a question that is over, so each
    // is DELETED rather than edited: Telegram edits only a message carrying no markup or an inline
    // keyboard, so an edit aimed at a `force_reply` is refused and the box would simply remain.
    const prompts = (handle.cardState as TelegramElicitCardState | undefined)?.prompts
    for (const promptTs of prompts?.keys() ?? [])
      void (handle.conn as TelegramConnection).deleteMessage(handle.channel, promptTs).catch(() => {})
  }
}
