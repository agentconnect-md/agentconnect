/**
 * Feishu's **elicitation-card facet** (§7.3) — the fourth implementer of {@link ElicitCardFacet},
 * and the last chat surface #1794 was waiting on.
 *
 * WHAT FEISHU HAS is a CardKit 2.0 `form` container: named controls — a text `input`, a
 * `select_static`, a `multi_select_static` — around one submit button, whose callback carries
 * every control's value at once in `action.form_value`. That is the same shape Slack's message
 * card has and the same shape Discord's dialog has, in the message rather than over a modal, so
 * the reduction maps onto it without a second level or a round trip.
 *
 * ONE EXCEPTION, and it is the one every surface makes: a lone single-select or boolean is a row
 * of buttons, because one tap already answers it and a form would ask the reader to submit a
 * decision they have already made.
 *
 * WHAT IS NOT VERIFIED HERE, and is stated rather than implied: unlike Discord — whose modal
 * components this repo could check against the installed `discord-api-types` — the Lark SDK ships
 * no card schema at all, since a CardKit card is opaque JSON. The `form` container is documented
 * behaviour, not behaviour this repo can prove, so the bounds below are OUR conservative choices
 * and are named as such. A card the platform refuses is a card that never posts, which core
 * already treats as an ask nobody could answer.
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
import type { FeishuConnection } from '../../feishu/connection.js'
import { FEISHU_MESSAGE_LIMIT } from '../../feishu/render.js'
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

/** Our own cap on how many options one card offers. Feishu publishes no number this code can
 *  check, so this is Slack's button cap re-used deliberately rather than a platform limit dressed
 *  up as one: a list past it is declined whole, never trimmed to fit. */
const FEISHU_ELICIT_MAX_OPTIONS = 24

/** Our own cap on one label, for the same reason — the 75 characters a reduced option label
 *  already clamps to. */
const FEISHU_LABEL_CAP = 75

/** How much of the answer a settled card echoes back. What the READER sees is clamped; what the
 *  AGENT receives is not (#1844), because the accepted content is built from the raw answer. */
const FEISHU_ELICIT_DECISION_CAP = 300

/** How much of the question one card carries: whatever is left once the settlement line is
 *  reserved, so the rewrite still fits after the ask did. */
const FEISHU_ELICIT_MESSAGE_CAP = FEISHU_MESSAGE_LIMIT - FEISHU_ELICIT_DECISION_CAP - 8

/** How Feishu spells each settlement mark. Literal emoji: a CardKit markdown element has no
 *  shortcode vocabulary, so Slack's `:white_check_mark:` would reach the reader as source text. */
const FEISHU_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

/** What this card's callbacks name themselves, so a tap on a session-control card is never read
 *  as an answer and vice versa. */
export const FEISHU_ELICIT_ACTION = 'agentconnect_elicit'

/** The token a Dismiss button carries. Not a position, because Dismiss answers no option. */
const FEISHU_ELICIT_DISMISS = 'x'

/** The token the Confirm button of a form carries. It names no option: it submits the lot. */
const FEISHU_ELICIT_CONFIRM = 'ok'

/** The `element_id` a form container and its submit button are known by. */
const FEISHU_ELICIT_FORM_ID = 'agentconnect_elicit_form'

/**
 * What a Feishu elicitation card can render AND collect: every kind, because a CardKit form has a
 * control for every kind — a text input for what must be typed, a select for one of a list, a
 * multi-select for several.
 */
export const FEISHU_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum', 'text', 'number']),
  optionLimits: {
    enum: { maxOptions: FEISHU_ELICIT_MAX_OPTIONS },
    'multi-enum': { maxOptions: FEISHU_ELICIT_MAX_OPTIONS }
  }
}

/** The payload one of this card's controls carries back, as CardKit hands it to us: an object,
 *  not a string, so the request and the token ride as their own fields rather than being parsed
 *  out of one. Pure. */
export function feishuElicitValue(requestId: string, token: string): Record<string, string> {
  return { action: FEISHU_ELICIT_ACTION, request: requestId, token }
}

/** The request and the token one card callback names — null for a payload this scheme did not
 *  mint, which is how a session-control tap stays a session-control tap. Dismiss reads as no
 *  answer, exactly as it does on every other surface. Pure. */
export function parseFeishuElicit(value: unknown): { requestId: string; token: string | null } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.action !== FEISHU_ELICIT_ACTION) return null
  const requestId = typeof v.request === 'string' ? v.request : ''
  const token = typeof v.token === 'string' ? v.token : ''
  if (!requestId || !token) return null
  return { requestId, token: token === FEISHU_ELICIT_DISMISS ? null : token }
}

/** The card's own heading: the question, on the same speech-balloon line every surface opens
 *  with. A CardKit `markdown` element renders the agent's words as markup, so they are clamped
 *  here and never given a link syntax of our own to inherit. Pure. */
export function feishuElicitText(message: string): string {
  return `💬 ${clampTo(message, FEISHU_ELICIT_MESSAGE_CAP)}`
}

/** A row of buttons, as CardKit 2.0 spells one: buttons live directly in `elements`, and a
 *  `column_set` is what puts several on one line — the same layout this repo's own reply card
 *  already uses. JSON 2.0 has no `tag: 'action'` wrapper at all. Pure. */
function feishuButtonRow(buttons: Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: buttons.map((button) => ({ tag: 'column', width: 'auto', elements: [button] }))
  }
}

function feishuDismissButton(requestId: string): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: 'Dismiss' },
    type: 'default',
    behaviors: [{ type: 'callback', value: feishuElicitValue(requestId, FEISHU_ELICIT_DISMISS) }]
  }
}

/** The ONE-TAP card: one button per option plus Dismiss, each carrying its option's POSITION and
 *  never its own value — the rule every surface shares (#1844), so an enum of paths or ids can be
 *  offered at all. Pure. */
export function buildFeishuElicitButtons(
  requestId: string,
  message: string,
  options: readonly { label: string }[]
): Record<string, unknown> {
  return feishuCard([
    { tag: 'markdown', content: feishuElicitText(message) },
    feishuButtonRow([
      ...options.map((o, i) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: clampTo(o.label, FEISHU_LABEL_CAP) },
        type: 'default',
        behaviors: [{ type: 'callback', value: feishuElicitValue(requestId, elicitOptionToken(i)) }]
      })),
      feishuDismissButton(requestId)
    ])
  ])
}

/**
 * The FORM card: one named control per field inside a CardKit `form`, the single Confirm that
 * submits the lot, and a Dismiss OUTSIDE the container — a form button is submit or reset, and a
 * submit validates the required fields, which is exactly the state a refusal has to work in.
 *
 * Every control is named by the same {@link elicitFormBlockId} a Slack Confirm submits under, and
 * every option carries its POSITION — so what comes back out of this form is validated by core's
 * one re-derivation (#1815) with nothing Feishu-shaped left in it.
 *
 * Null when a field has no control here: an option list past what this card offers. Declined
 * whole, never trimmed, for the same reason every other surface declines one. Pure.
 */
export function buildFeishuElicitForm(
  requestId: string,
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[]
): Record<string, unknown> | null {
  if (!form.length) return null
  const required = new Set(elicitRequiredProps(params))
  const elements: Record<string, unknown>[] = []
  for (const [index, target] of form.entries()) {
    const name = elicitFormBlockId(index)
    const label = clampTo(elicitFormFieldLabel(params, target), FEISHU_LABEL_CAP)
    const hint = elicitFormFieldHint(target)
    const need = required.has(target.propName)
    if (target.kind === 'text' || target.kind === 'number') {
      elements.push({
        tag: 'input',
        name,
        required: need,
        label: { tag: 'plain_text', content: label },
        ...(hint ? { placeholder: { tag: 'plain_text', content: clampTo(hint, FEISHU_LABEL_CAP) } } : {}),
        ...(target.defaultValue !== undefined ? { default_value: String(target.defaultValue) } : {})
      })
      continue
    }
    if (!target.options.length || target.options.length > FEISHU_ELICIT_MAX_OPTIONS) return null
    elements.push({
      tag: target.kind === 'multi-enum' ? 'multi_select_static' : 'select_static',
      name,
      required: need,
      label: { tag: 'plain_text', content: label },
      ...(hint ? { placeholder: { tag: 'plain_text', content: clampTo(hint, FEISHU_LABEL_CAP) } } : {}),
      options: target.options.map((o, n) => ({
        text: { tag: 'plain_text', content: clampTo(o.label, FEISHU_LABEL_CAP) },
        value: elicitOptionToken(n)
      }))
    })
  }
  return feishuCard([
    { tag: 'markdown', content: feishuElicitText((params as { message?: string }).message?.trim() ?? '') },
    {
      tag: 'form',
      name: FEISHU_ELICIT_FORM_ID,
      elements: [
        ...elements,
        // The one control that reads every named field above and sends them together. A button
        // INSIDE a form needs both a `name` and a `form_action_type`, and submit is the only one
        // of the two that carries values — reset merely clears them.
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Confirm' },
          type: 'primary',
          form_action_type: 'submit',
          name: `${FEISHU_ELICIT_FORM_ID}_submit`,
          behaviors: [{ type: 'callback', value: feishuElicitValue(requestId, FEISHU_ELICIT_CONFIRM) }]
        }
      ]
    },
    // Dismiss stands OUTSIDE the form, and has to: a form button is submit or reset, and submit
    // validates the required fields. The reader's one explicit refusal must work precisely when
    // those fields are empty, which is the case a submit would refuse.
    feishuButtonRow([feishuDismissButton(requestId)])
  ])
}

/** The settled card: the question with the decision under it, and no control left to press. */
export function buildFeishuElicitSettled(message: string, decision: string): Record<string, unknown> {
  return feishuCard([
    { tag: 'markdown', content: clampTo(`${feishuElicitText(message)}\n${decision}`, FEISHU_MESSAGE_LIMIT) }
  ])
}

/** The CardKit 2.0 envelope every card here shares. */
function feishuCard(elements: Record<string, unknown>[]): Record<string, unknown> {
  return { schema: '2.0', config: { update_multi: true }, body: { elements } }
}

/** Whether this reduction is answered by ONE TAP, or needs the form. The same line every surface
 *  draws, and the only place Feishu decides it. Pure. */
export function feishuUsesForm(form: readonly ElicitTarget[]): boolean {
  const only = form.length === 1 ? form[0]! : null
  return !(only && (only.kind === 'enum' || only.kind === 'boolean') && only.options.length > 0)
}

/** Feishu's per-turn elicitation draft: the whole card, ready to post. */
interface FeishuElicitDraft {
  card: Record<string, unknown>
}

export const feishuElicitCards: ElicitCardFacet = {
  platform: 'feishu',
  reduction: FEISHU_ELICIT_SURFACE,

  build(_host: ElicitCardHost, _turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    // No consent control: a CardKit link button opens the page but reports nothing back, so the
    // daemon would never learn the reader consented — and consent is all that seam decides.
    if (ask.url || !ask.form?.length) return null
    if (!feishuUsesForm(ask.form)) {
      const target = ask.form[0]!
      if (target.options.length > FEISHU_ELICIT_MAX_OPTIONS) return null
      return { card: buildFeishuElicitButtons(ask.requestId, ask.message, target.options) } satisfies FeishuElicitDraft
    }
    const card = buildFeishuElicitForm(ask.requestId, ask.params, ask.form)
    return card ? ({ card } satisfies FeishuElicitDraft) : null
  },

  async send(
    host: ElicitCardHost,
    turn: ElicitCardTurn,
    _ask: ElicitCardAsk,
    draft: ElicitCardDraft
  ): Promise<string | undefined> {
    const d = draft as FeishuElicitDraft
    // The card anchors exactly as every other post of this turn does — on `plan.thread`, which is
    // what `applyFeishuAction` hands every send. A Feishu id prefix is what separates "reply into
    // this thread" (`om_…`) from "post to this chat" (`oc_…`), so one field is the whole anchor.
    return await host.postCardSerialized(turn, (conn) =>
      (conn as FeishuConnection).postElicitCard(turn.plan.channel, turn.plan.thread, d.card)
    )
  },

  /** A one-tap card's option, and nothing else: a form card is answered by its Confirm, which
   *  arrives with every field at once and reaches core through `submitElicitForm`. */
  tap(_handle: ElicitCardHandle, card: ElicitCardTapTarget, token: string): ElicitCardTap | null {
    // A Confirm with no fields at all still submits: an all-optional form may answer empty, and
    // core is what decides whether that is an answer.
    if (feishuUsesForm(card.form) && token === FEISHU_ELICIT_CONFIRM) return { kind: 'submit', fields: {} }
    return null
  },

  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    if (handle.ts === undefined) return
    const message = (card.params as { message?: string }).message?.trim() || 'The agent needs your input'
    const decision = `${FEISHU_ELICIT_MARK[card.mark]} ${clampTo(card.text, FEISHU_ELICIT_DECISION_CAP)}`
    void (handle.conn as FeishuConnection)
      .updateElicitCard(handle.ts, buildFeishuElicitSettled(message, decision))
      .catch(() => {})
  }
}
