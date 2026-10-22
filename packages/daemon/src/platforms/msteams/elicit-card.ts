// Teams' elicitation-card facet (teams-integration.md §4.4): an Adaptive Card whose `Action.Execute` clicks the relay forwards, inputs merged into their data.
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import {
  elicitFormBlockId,
  elicitFormBlockIndex,
  MSTEAMS_CARD_NOTE_MAX,
  MSTEAMS_PLATFORM,
  type WireMsTeamsCardAction
} from '@agentconnect.md/protocol'
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
import {
  clampTo,
  elicitCardShape,
  elicitFormFieldHint,
  elicitFormFieldLabel,
  elicitOptionToken,
  type ElicitKind,
  type ElicitSurface,
  type ElicitTarget
} from '../../slack/render.js'
import { replaceMsTeamsCard, sendMsTeamsCard, type MsTeamsCardDraft } from './approval-card.js'
import {
  adaptiveCard,
  buttonRows,
  dataString,
  executeButton,
  MSTEAMS_ELICIT_VERB,
  MSTEAMS_LABEL_CAP,
  plainText,
  type AdaptiveElement
} from './card.js'
import type { MsTeamsTurnState } from './turn-output.js'

// Our own caps, as Google Chat's: Teams publishes no per-card option count, so a longer list is declined whole, never trimmed.
const MSTEAMS_ELICIT_MAX_OPTIONS = 24
const MSTEAMS_ELICIT_MESSAGE_CAP = 3_000
const MSTEAMS_ELICIT_DECISION_CAP = 300

const MSTEAMS_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

// The tokens a Dismiss and a form's Confirm carry; neither names an option.
const MSTEAMS_ELICIT_DISMISS = 'x'
const MSTEAMS_ELICIT_CONFIRM = 'ok'

// A multi-select answers with its picks comma-joined, so its input id says to split it back.
const MULTI_SUFFIX = '_multi'

// Every kind has a control: a text or number input for typed answers, a dropdown for one of a list, checkboxes for several.
export const MSTEAMS_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum', 'text', 'number']),
  optionLimits: {
    enum: { maxOptions: MSTEAMS_ELICIT_MAX_OPTIONS },
    'multi-enum': { maxOptions: MSTEAMS_ELICIT_MAX_OPTIONS }
  }
}

function question(message: string): AdaptiveElement[] {
  return plainText(`💬 ${clampTo(message, MSTEAMS_ELICIT_MESSAGE_CAP)}`)
}

function button(requestId: string, text: string, token: string, withInputs = false): AdaptiveElement {
  return executeButton(text, MSTEAMS_ELICIT_VERB, { request: requestId, token }, { withInputs })
}

/** The one-tap card: a button per option carrying its POSITION (#1844), then Dismiss. Pure. */
export function buildMsTeamsElicitButtons(
  requestId: string,
  message: string,
  options: readonly { label: string }[]
): Record<string, unknown> {
  return adaptiveCard([
    ...question(message),
    ...buttonRows([
      ...options.map((o, i) => button(requestId, o.label, elicitOptionToken(i))),
      button(requestId, 'Dismiss', MSTEAMS_ELICIT_DISMISS)
    ])
  ])
}

// The options a field's default pre-selects, as their tokens; a boolean's default is a real boolean, spelled as its option value.
function seededTokens(target: ElicitTarget): string[] {
  const raw = target.defaultValue
  const values = Array.isArray(raw) ? new Set(raw) : raw === undefined ? new Set<string>() : new Set([String(raw)])
  return target.options.flatMap((o, n) => (values.has(o.value) ? [elicitOptionToken(n)] : []))
}

/** The form card: one input per field keyed by {@link elicitFormBlockId}, one Confirm, and Dismiss; null when a list is too long. Pure. */
export function buildMsTeamsElicitForm(
  requestId: string,
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[]
): Record<string, unknown> | null {
  if (!form.length) return null
  const body: AdaptiveElement[] = [...question((params as { message?: string }).message?.trim() ?? '')]
  for (const [index, target] of form.entries()) {
    const id = elicitFormBlockId(index)
    const label = clampTo(elicitFormFieldLabel(params, target), MSTEAMS_LABEL_CAP)
    const hint = elicitFormFieldHint(target)
    if (target.kind === 'text') {
      body.push({
        type: 'Input.Text',
        id,
        label,
        ...(hint ? { placeholder: hint } : {}),
        ...(target.defaultValue !== undefined ? { value: String(target.defaultValue) } : {})
      })
      continue
    }
    if (target.kind === 'number') {
      body.push({
        type: 'Input.Number',
        id,
        label,
        ...(hint ? { placeholder: hint } : {}),
        ...(typeof target.defaultValue === 'number' ? { value: target.defaultValue } : {})
      })
      continue
    }
    if (!target.options.length || target.options.length > MSTEAMS_ELICIT_MAX_OPTIONS) return null
    // A choice set has no hint slot of its own, so the hint rides as a line above it.
    if (hint) body.push(...plainText(hint))
    const multi = target.kind === 'multi-enum'
    const seeded = seededTokens(target)
    body.push({
      type: 'Input.ChoiceSet',
      id: multi ? `${id}${MULTI_SUFFIX}` : id,
      label,
      style: multi ? 'expanded' : 'compact',
      isMultiSelect: multi,
      choices: target.options.map((o, n) => ({
        title: clampTo(o.label, MSTEAMS_LABEL_CAP),
        value: elicitOptionToken(n)
      })),
      ...(seeded.length ? { value: multi ? seeded.join(',') : seeded[0] } : {})
    })
  }
  body.push(
    ...buttonRows([
      button(requestId, 'Confirm', MSTEAMS_ELICIT_CONFIRM, true),
      button(requestId, 'Dismiss', MSTEAMS_ELICIT_DISMISS)
    ])
  )
  return adaptiveCard(body)
}

/** The settled card: the question with the decision under it, and nothing left to press. Pure. */
export function buildMsTeamsElicitSettled(message: string, decision: string): Record<string, unknown> {
  return adaptiveCard([...question(message), ...plainText(decision)])
}

/** What one forwarded click asks core to do: a one-tap answer or Dismiss, or a form's Confirm with its inputs. */
export type MsTeamsElicitClick =
  | { kind: 'choice'; requestId: string; token: string | null }
  | { kind: 'submit'; requestId: string; values: Record<string, string | string[]> }

/** The card's inputs as Teams merged them into the Confirm's data, keyed by field block id; a blank input is left out. Pure. */
function formValues(data: Record<string, unknown>): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {}
  for (const [key, raw] of Object.entries(data)) {
    const multi = key.endsWith(MULTI_SUFFIX)
    const blockId = multi ? key.slice(0, -MULTI_SUFFIX.length) : key
    if (elicitFormBlockIndex(blockId) === null) continue
    const value =
      typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined
    if (value === undefined || value === '') continue
    values[blockId] = multi ? value.split(',').filter(Boolean) : value
  }
  return values
}

export function parseMsTeamsElicitClick(action: WireMsTeamsCardAction): MsTeamsElicitClick | null {
  if (action.verb !== MSTEAMS_ELICIT_VERB) return null
  const requestId = dataString(action.data, 'request')
  const token = dataString(action.data, 'token')
  if (!requestId || !token) return null
  if (token === MSTEAMS_ELICIT_CONFIRM) return { kind: 'submit', requestId, values: formValues(action.data) }
  return { kind: 'choice', requestId, token: token === MSTEAMS_ELICIT_DISMISS ? null : token }
}

export const msTeamsElicitCards: ElicitCardFacet = {
  platform: MSTEAMS_PLATFORM,
  reduction: MSTEAMS_ELICIT_SURFACE,
  // No tellPrivately: core hands a refusal back, and the relay shows it to the clicker alone as the click's note.
  privateTextLimit: MSTEAMS_CARD_NOTE_MAX,

  build(host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    // No consent control: a link button opens the page but reports nothing back, and consent is all that seam decides.
    if (ask.url || !ask.form?.length) return null
    // A card with nowhere to go could never be answered: no control for this ask.
    if (!(host.turnState(turn) as MsTeamsTurnState | undefined)?.target) return null
    // Core's own line between a one-tap card and a form, so the record and the card never disagree.
    const card =
      elicitCardShape(ask.form) === 'inputs'
        ? buildMsTeamsElicitForm(ask.requestId, ask.params, ask.form)
        : buildMsTeamsElicitButtons(ask.requestId, ask.message, ask.form[0]!.options)
    return card
      ? ({ card, summary: clampTo(ask.fallback, MSTEAMS_ELICIT_DECISION_CAP) } satisfies MsTeamsCardDraft)
      : null
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, _ask: ElicitCardAsk, draft: ElicitCardDraft) {
    return await sendMsTeamsCard(host, turn, draft as MsTeamsCardDraft)
  },

  settle(handle: ElicitCardHandle, settlement: ElicitCardSettlement): void {
    const message = (settlement.params as { message?: string }).message?.trim() || 'The agent needs your input'
    const decision = `${MSTEAMS_ELICIT_MARK[settlement.mark]} ${clampTo(settlement.text, MSTEAMS_ELICIT_DECISION_CAP)}`
    replaceMsTeamsCard(handle, buildMsTeamsElicitSettled(message, decision))
  }
}
