/**
 * Discord's **elicitation-card facet** (§7.3) — the third implementer of {@link ElicitCardFacet},
 * and the first surface that can put a whole form in front of the reader as one dialog.
 *
 * WHAT DISCORD ACTUALLY HAS is two places to put a control, and they take different ones. A
 * MESSAGE takes buttons and select menus but no typed box at all; a MODAL takes `Label`-wrapped
 * text inputs, select menus, radio groups and checkbox groups — verified against the installed
 * `discord-api-types@0.38.54` (`APIComponentInLabel`) and `discord.js@14.27`, which both sends raw
 * modal JSON (`showModal`) and reads every one of those back (`ModalSubmitFields.getField`).
 *
 * So the reader gets ONE dialog with every question in it, submitted atomically — closer to what
 * `elicitation/create` describes than any message-level card can be. The modal is not the Slack
 * modal that was removed in #1794: Slack had message-level input state, which made its modal a
 * second way to do what the card already did. Discord has NO way to type into a message, so the
 * modal is not a choice between surfaces — it is the only surface that can take a typed answer.
 *
 * ONE EXCEPTION, and it is the same one every other surface makes: a lone single-select or boolean
 * is a row of buttons in the message, because one tap already answers it and a dialog would be a
 * round trip for nothing.
 *
 * SELECT MENUS DO THE OPTION FIELDS, not radio and checkbox groups, though the modal takes all
 * three. A radio group is prettier but holds 2–10 options against a select's 25, and its arity is
 * a different component rather than a different bound — so choosing it would buy nicer pixels for
 * two more code paths and two more cliffs. One control, one bound, one read path.
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
  ElicitCardSettlement,
  ElicitCardTap,
  ElicitCardTapTarget,
  ElicitCardTurn
} from '../elicit-card.js'
import type { DiscordConnection } from '../../discord/connection.js'
import type { DiscordButton, DiscordComponents } from '../../discord/render.js'
import { DISCORD_MESSAGE_LIMIT } from '../../discord/render.js'
import {
  clampTo,
  elicitFormFieldHint,
  elicitFormFieldLabel,
  elicitOptionToken,
  elicitRequiredProps,
  type ElicitKind,
  type ElicitSurface,
  type ElicitTarget
} from '../../slack/render.js'

/** One `actions` row holds five buttons and a message holds five rows, so a one-tap card offers
 *  24 options and keeps its Dismiss. A longer list is declined whole, never trimmed to fit. */
const DISCORD_ELICIT_MAX_BUTTONS = 24

/** A select menu's own cap on `options` — the bound every FORM field is held to, whatever its
 *  arity, because one control is what a select is for both. */
const DISCORD_SELECT_MAX_OPTIONS = 25

/** How many components one modal takes (`APIModalInteractionResponseCallbackData.components`:
 *  "between 1 and 5"). A reduction with more fields than this has no dialog to be shown in and is
 *  declined whole — a modal missing its sixth question would collect an answer to a form the
 *  reader never saw. */
export const DISCORD_MODAL_MAX_FIELDS = 5

/** Discord's own caps on the strings a modal carries. */
const DISCORD_MODAL_TITLE_CAP = 45
const DISCORD_LABEL_CAP = 45
const DISCORD_LABEL_DESCRIPTION_CAP = 100
const DISCORD_OPTION_LABEL_CAP = 100
/** A `custom_id` anywhere in the component tree. */
const DISCORD_CUSTOM_ID_CAP = 100
/** What one text input accepts, and what a button's label holds. */
const DISCORD_TEXT_INPUT_CAP = 4000
const DISCORD_BUTTON_LABEL_CAP = 80

const DISCORD_ELICIT_PREFIX = 'ac_el'

/** The token a Dismiss button carries. Not a position, because Dismiss answers no option. */
const DISCORD_ELICIT_DISMISS = 'x'

/** The token the button that OPENS THE DIALOG carries. It answers nothing: it asks for the form. */
export const DISCORD_ELICIT_OPEN = 'ed'

/** The token the modal itself carries back on submit. */
export const DISCORD_ELICIT_MODAL = 'm'

/** How much of the answer a settled card echoes back, for the same reason Telegram's is bounded:
 *  the decision core supplies is not, and Discord's message limit is 2000 — a quarter of what a
 *  Slack block takes. What the READER sees is clamped; what the AGENT receives is not (#1844). */
const DISCORD_ELICIT_DECISION_CAP = 300

/** How much of the question one card carries: whatever is left once the settlement line is
 *  reserved, so the rewrite still fits after the ask did. Derived from the decision cap rather
 *  than written beside it — the two drifting apart is how a settlement stops landing. */
const DISCORD_ELICIT_MESSAGE_CAP = DISCORD_MESSAGE_LIMIT - DISCORD_ELICIT_DECISION_CAP - 8

/** How Discord spells each settlement mark. Literal emoji: a Discord message has no shortcode
 *  vocabulary, so Slack's `:white_check_mark:` would reach the reader as its own source text. */
const DISCORD_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

/**
 * What a Discord elicitation card can render AND collect: every kind, because the modal has a
 * control for every kind. The option bound is the BUTTON row's, not the select's, since the
 * reduction runs before the shape is known and a one-tap card is the tighter of the two.
 */
export const DISCORD_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum', 'text', 'number']),
  optionLimits: {
    enum: { maxOptions: DISCORD_ELICIT_MAX_BUTTONS },
    'multi-enum': { maxOptions: DISCORD_SELECT_MAX_OPTIONS }
  }
}

/** One component's `custom_id`: the request and what the component is. Pure. */
export function discordElicitId(requestId: string, token: string): string {
  return `${DISCORD_ELICIT_PREFIX}:${requestId}:${token}`
}

/** Whether every id this card mints fits Discord's 100-character `custom_id`. The widest is the
 *  last option's, so that one answers for all of them. Pure. */
export function discordElicitIdFits(requestId: string, options: number): boolean {
  return discordElicitId(requestId, elicitOptionToken(Math.max(0, options - 1))).length <= DISCORD_CUSTOM_ID_CAP
}

/** Decode a tapped elicitation component: the request, and what was tapped — null for Dismiss,
 *  which settles the card as a decline. Null for ids this scheme did not mint (`ac_sel:…`, a
 *  status-bar verb, a stray one alike). Pure. */
export function parseDiscordElicit(id: string): { requestId: string; token: string | null } | null {
  const m = /^ac_el:([0-9a-fA-F-]{1,64}):([A-Za-z0-9_]{1,16})$/.exec(id)
  if (!m) return null
  const token = m[2] as string
  return { requestId: m[1] as string, token: token === DISCORD_ELICIT_DISMISS ? null : token }
}

/** The card's own text: the question, on the same speech-balloon line every surface opens with.
 *  Discord renders message content as markdown, so the agent's words are fenced rather than
 *  defused — a fence shows them verbatim and makes no link, no mention and no header. Pure. */
export function discordElicitText(message: string): string {
  const body = clampTo(message, DISCORD_ELICIT_MESSAGE_CAP)
  return `💬 ${body}`
}

/** One tappable button per option, plus Dismiss, five to a row — the one-tap card. Each carries
 *  its option's POSITION, never its value: a `custom_id` holds 100 characters and an enum of paths
 *  or ids would not fit its own values (#1844's rule, which every surface now shares). Pure. */
export function discordElicitButtons(requestId: string, options: readonly { label: string }[]): DiscordComponents {
  const buttons: DiscordButton[] = options.map((o, i) => ({
    type: 2,
    style: 2,
    label: clampTo(o.label, DISCORD_BUTTON_LABEL_CAP),
    custom_id: discordElicitId(requestId, elicitOptionToken(i))
  }))
  buttons.push(discordDismissButton(requestId))
  const rows: DiscordComponents = []
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) })
  return rows
}

function discordDismissButton(requestId: string): DiscordButton {
  return { type: 2, style: 2, label: 'Dismiss', custom_id: discordElicitId(requestId, DISCORD_ELICIT_DISMISS) }
}

/** The card that opens a DIALOG: one button that asks for the form, and Dismiss. There is no
 *  Confirm here — the modal has its own submit, and the answer never passes through the message.
 *  Pure. */
export function discordElicitOpenButtons(requestId: string): DiscordComponents {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Answer', custom_id: discordElicitId(requestId, DISCORD_ELICIT_OPEN) },
        discordDismissButton(requestId)
      ]
    }
  ]
}

/** A Discord modal, in the wire shape `showModal` takes. Opaque to core. */
export interface DiscordModal {
  custom_id: string
  title: string
  components: unknown[]
}

/**
 * The dialog one reduction becomes: a `Label` per field wrapping the control that collects it — a
 * text input for a typed field, a select menu for an option field, single or multiple by its own
 * `min_values`/`max_values`.
 *
 * Every option carries its POSITION, and every field is keyed by the same `elicitFormBlockId` a
 * Slack Confirm submits under, so what comes back out of this dialog is validated by core's ONE
 * re-derivation (#1815) with nothing Discord-shaped left in it.
 *
 * Null when the reduction has no dialog: more fields than a modal holds, or an option list past
 * what a select holds. Declined whole — a modal missing a question would collect an answer to a
 * form the reader never saw. Pure.
 */
export function buildDiscordElicitModal(
  requestId: string,
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[]
): DiscordModal | null {
  if (!form.length || form.length > DISCORD_MODAL_MAX_FIELDS) return null
  const required = new Set(elicitRequiredProps(params))
  const components: unknown[] = []
  for (const [index, target] of form.entries()) {
    const id = elicitFormBlockId(index)
    const hint = elicitFormFieldHint(target)
    const label = {
      type: 18,
      label: clampTo(elicitFormFieldLabel(params, target), DISCORD_LABEL_CAP),
      ...(hint ? { description: clampTo(hint, DISCORD_LABEL_DESCRIPTION_CAP) } : {}),
      component: {} as unknown
    }
    const need = required.has(target.propName)
    if (target.kind === 'text' || target.kind === 'number') {
      label.component = {
        type: 4,
        custom_id: id,
        // Single-line unless the schema asks for room: `maxLength` is the only signal we have.
        style: (target.maxLength ?? 0) > 200 ? 2 : 1,
        required: need,
        max_length: Math.min(target.maxLength ?? DISCORD_TEXT_INPUT_CAP, DISCORD_TEXT_INPUT_CAP),
        ...(target.defaultValue !== undefined ? { value: String(target.defaultValue) } : {})
      }
    } else {
      if (!target.options.length || target.options.length > DISCORD_SELECT_MAX_OPTIONS) return null
      const multi = target.kind === 'multi-enum'
      // The field's own bounds, inside what a select can promise. A required single-select must
      // take exactly one; an optional field may take none, which is how it stays omittable.
      const min = multi ? (need ? Math.max(target.minItems ?? 1, 1) : (target.minItems ?? 0)) : need ? 1 : 0
      const max = multi ? Math.min(target.maxItems ?? target.options.length, target.options.length) : 1
      label.component = {
        type: 3,
        custom_id: id,
        min_values: Math.min(min, max),
        max_values: max,
        options: target.options.map((o, n) => ({
          label: clampTo(o.label, DISCORD_OPTION_LABEL_CAP),
          value: elicitOptionToken(n),
          ...(target.defaultValue === o.value ? { default: true } : {})
        }))
      }
    }
    components.push(label)
  }
  return {
    custom_id: discordElicitId(requestId, DISCORD_ELICIT_MODAL),
    title: clampTo(elicitModalTitle(params), DISCORD_MODAL_TITLE_CAP),
    components
  }
}

/** What the dialog is called. The question itself where it fits — a modal title is 45 characters,
 *  which most questions are not, and a truncated question read as a heading says less than a plain
 *  one. The question is on the card above either way. Pure. */
function elicitModalTitle(params: CreateElicitationRequest): string {
  const message = (params as { message?: string }).message?.trim() ?? ''
  return message && message.length <= DISCORD_MODAL_TITLE_CAP ? message : 'The agent needs your input'
}

/** Discord's per-turn elicitation draft: the message and the components under it. */
interface DiscordElicitDraft {
  text: string
  components: DiscordComponents
}

/** Whether this reduction is answered by ONE TAP, or needs the dialog. The same line every surface
 *  draws, and the only place Discord decides it. Pure. */
export function discordUsesModal(form: readonly ElicitTarget[]): boolean {
  const only = form.length === 1 ? form[0]! : null
  return !(only && (only.kind === 'enum' || only.kind === 'boolean') && only.options.length > 0)
}

export const discordElicitCards: ElicitCardFacet = {
  platform: 'discord',
  reduction: DISCORD_ELICIT_SURFACE,

  build(_host: ElicitCardHost, _turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    // No consent control: a Discord link button opens the page but delivers no interaction, so the
    // daemon would never learn the reader consented — and consent is all that seam decides (#1810).
    if (ask.url || !ask.form?.length) return null
    const modal = discordUsesModal(ask.form)
    const widest = modal ? Math.max(...ask.form.map((t) => t.options.length), 1) : ask.form[0]!.options.length
    if (!discordElicitIdFits(ask.requestId, widest)) return null
    if (modal) {
      // Built here and thrown away, so a reduction the dialog cannot hold is declined BEFORE the
      // request is recorded as open, rather than posting a card whose button opens nothing.
      if (!buildDiscordElicitModal(ask.requestId, ask.params, ask.form)) return null
      return {
        text: discordElicitText(ask.message),
        components: discordElicitOpenButtons(ask.requestId)
      } satisfies DiscordElicitDraft
    }
    return {
      text: discordElicitText(ask.message),
      components: discordElicitButtons(ask.requestId, ask.form[0]!.options)
    } satisfies DiscordElicitDraft
  },

  async send(
    host: ElicitCardHost,
    turn: ElicitCardTurn,
    _ask: ElicitCardAsk,
    draft: ElicitCardDraft
  ): Promise<string | undefined> {
    const d = draft as DiscordElicitDraft
    return await host.postCardSerialized(turn, (conn) =>
      (conn as DiscordConnection).postChrome(turn.plan.channel, d.text, {
        keyboard: d.components,
        ...(turn.plan.thread !== undefined ? { threadTs: turn.plan.thread } : {})
      })
    )
  },

  /** The dialog this card's Answer button opens, rebuilt from the card's OWN params so it offers
   *  the very fields the ask reduced to (#1815). Null for a card answered by one tap. */
  editor(_handle: ElicitCardHandle, card: ElicitCardTapTarget): unknown | null {
    if (!discordUsesModal(card.form)) return null
    return buildDiscordElicitModal(card.requestId, card.params, card.form)
  },

  /** A one-tap card's option, and nothing else: every other Discord card is answered in its dialog
   *  and reaches core through `submitElicitForm` without passing through here. */
  tap(_handle: ElicitCardHandle, card: ElicitCardTapTarget, token: string): ElicitCardTap | null {
    if (discordUsesModal(card.form) || token !== DISCORD_ELICIT_OPEN) return null
    // Opening the dialog is not an answer, so the card stays exactly as open as it was.
    return { kind: 'pending' }
  },

  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    if (handle.ts === undefined) return
    const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
    const decision = `${DISCORD_ELICIT_MARK[card.mark]} ${clampTo(card.text, DISCORD_ELICIT_DECISION_CAP)}`
    // Belt to the reserve's braces, as Telegram's has: the reserve only holds while both halves
    // are bounded, and an edit refused for length lands AFTER ACP accepted and the pending record
    // went — nothing is left to retry against, so the card would keep offering a dead button.
    const text = clampTo(`${discordElicitText(message)}\n${decision}`, DISCORD_MESSAGE_LIMIT)
    // No components: the answered card stays readable, with nothing left to press.
    void (handle.conn as DiscordConnection)
      .updateMessage(handle.channel, handle.ts, text, { keyboard: [] })
      .catch(() => {})
  }
}
