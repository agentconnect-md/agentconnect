// Google Chat's elicitation-card facet (§7.3): a cardsV2 message whose button clicks the relay forwards as CARD_CLICKED.
import { createHash } from 'node:crypto'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import {
  elicitFormBlockId,
  GOOGLE_CHAT_ELICIT_FUNCTION,
  type WireGoogleChatCardAction
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
import type { GoogleChatMessageRef } from './connection.js'
import type { GoogleChatTurnState } from './turn-output.js'

// Our own caps: Google publishes no per-card option count, so a longer list is declined whole, never trimmed.
const GOOGLE_CHAT_ELICIT_MAX_OPTIONS = 24
const GOOGLE_CHAT_LABEL_CAP = 75
const GOOGLE_CHAT_ELICIT_MESSAGE_CAP = 3_000
const GOOGLE_CHAT_ELICIT_DECISION_CAP = 300

const GOOGLE_CHAT_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

// The tokens a Dismiss and a form's Confirm carry; neither names an option.
const GOOGLE_CHAT_ELICIT_DISMISS = 'x'
const GOOGLE_CHAT_ELICIT_CONFIRM = 'ok'

const CARD_ID = 'agentconnect-elicit'

// Every kind has a control: a text input for typed answers, a dropdown for one of a list, checkboxes for several.
export const GOOGLE_CHAT_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum', 'text', 'number']),
  optionLimits: {
    enum: { maxOptions: GOOGLE_CHAT_ELICIT_MAX_OPTIONS },
    'multi-enum': { maxOptions: GOOGLE_CHAT_ELICIT_MAX_OPTIONS }
  }
}

/** What the connection offers a card: a create by client id and a cards-only rewrite. */
interface GoogleChatCardPort {
  createMessage(input: {
    space: string
    thread?: string
    clientId: string
    cardsV2: readonly unknown[]
    fallbackText?: string
  }): Promise<GoogleChatMessageRef>
  patchCards(name: string, cardsV2: readonly unknown[]): Promise<void>
}

interface GoogleChatElicitDraft {
  cardsV2: unknown[]
  fallbackText: string
}

/** The card's client id: one per request, so a retried create returns the card already posted. */
export function googleChatElicitClientId(requestId: string): string {
  return `client-${createHash('sha256').update(`elicit\u001f${requestId}`).digest('hex').slice(0, 48)}`
}

// Card text paragraphs read a small HTML subset, so the agent's words are escaped and never become markup.
function cardText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

function question(message: string): string {
  return cardText(`💬 ${clampTo(message, GOOGLE_CHAT_ELICIT_MESSAGE_CAP)}`)
}

function button(requestId: string, text: string, token: string): Record<string, unknown> {
  return {
    text: clampTo(text, GOOGLE_CHAT_LABEL_CAP),
    onClick: {
      action: {
        function: GOOGLE_CHAT_ELICIT_FUNCTION,
        parameters: [
          { key: 'request', value: requestId },
          { key: 'token', value: token }
        ]
      }
    }
  }
}

function card(widgets: Record<string, unknown>[]): unknown[] {
  return [{ cardId: CARD_ID, card: { sections: [{ widgets }] } }]
}

/** The one-tap card: a button per option carrying its POSITION (#1844), then Dismiss. Pure. */
export function buildGoogleChatElicitButtons(
  requestId: string,
  message: string,
  options: readonly { label: string }[]
): unknown[] {
  return card([
    { textParagraph: { text: question(message) } },
    {
      buttonList: {
        buttons: [
          ...options.map((o, i) => button(requestId, o.label, elicitOptionToken(i))),
          button(requestId, 'Dismiss', GOOGLE_CHAT_ELICIT_DISMISS)
        ]
      }
    }
  ])
}

// The options a field's default pre-selects; a boolean's default is a real boolean, spelled as its option value.
function seeded(target: ElicitTarget): Set<string> {
  const raw = target.defaultValue
  if (Array.isArray(raw)) return new Set(raw)
  return raw === undefined ? new Set() : new Set([String(raw)])
}

/** The form card: one named widget per field under {@link elicitFormBlockId}, one Confirm, and Dismiss; null when a list is too long. Pure. */
export function buildGoogleChatElicitForm(
  requestId: string,
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[]
): unknown[] | null {
  if (!form.length) return null
  const widgets: Record<string, unknown>[] = [
    { textParagraph: { text: question((params as { message?: string }).message?.trim() ?? '') } }
  ]
  for (const [index, target] of form.entries()) {
    const name = elicitFormBlockId(index)
    const label = clampTo(elicitFormFieldLabel(params, target), GOOGLE_CHAT_LABEL_CAP)
    const hint = elicitFormFieldHint(target)
    if (target.kind === 'text' || target.kind === 'number') {
      widgets.push({
        textInput: {
          name,
          label,
          type: 'SINGLE_LINE',
          ...(hint ? { hintText: hint } : {}),
          ...(target.defaultValue !== undefined ? { value: String(target.defaultValue) } : {})
        }
      })
      continue
    }
    if (!target.options.length || target.options.length > GOOGLE_CHAT_ELICIT_MAX_OPTIONS) return null
    // A selection input has no hint slot, so the hint rides as a line above it.
    if (hint) widgets.push({ textParagraph: { text: cardText(hint) } })
    const selected = seeded(target)
    widgets.push({
      selectionInput: {
        name,
        label,
        type: target.kind === 'multi-enum' ? 'CHECKBOX' : 'DROPDOWN',
        items: target.options.map((o, n) => ({
          text: clampTo(o.label, GOOGLE_CHAT_LABEL_CAP),
          value: elicitOptionToken(n),
          selected: selected.has(o.value)
        }))
      }
    })
  }
  widgets.push({
    buttonList: {
      buttons: [
        button(requestId, 'Confirm', GOOGLE_CHAT_ELICIT_CONFIRM),
        button(requestId, 'Dismiss', GOOGLE_CHAT_ELICIT_DISMISS)
      ]
    }
  })
  return card(widgets)
}

/** The settled card: the question with the decision under it, and nothing left to press. Pure. */
export function buildGoogleChatElicitSettled(message: string, decision: string): unknown[] {
  return card([{ textParagraph: { text: `${question(message)}<br>${cardText(decision)}` } }])
}

/** What one forwarded click asks core to do: a one-tap answer or Dismiss, or a form's Confirm with its widgets. Pure. */
export type GoogleChatElicitClick =
  | { kind: 'choice'; requestId: string; token: string | null }
  | { kind: 'submit'; requestId: string; values: Record<string, string[]> }

export function parseGoogleChatElicitClick(action: WireGoogleChatCardAction): GoogleChatElicitClick | null {
  if (action.function !== GOOGLE_CHAT_ELICIT_FUNCTION) return null
  const requestId = action.parameters.request
  const token = action.parameters.token
  if (!requestId || !token) return null
  if (token === GOOGLE_CHAT_ELICIT_CONFIRM) return { kind: 'submit', requestId, values: action.formInputs }
  return { kind: 'choice', requestId, token: token === GOOGLE_CHAT_ELICIT_DISMISS ? null : token }
}

export const googleChatElicitCards: ElicitCardFacet = {
  platform: 'googlechat',
  reduction: GOOGLE_CHAT_ELICIT_SURFACE,

  build(_host: ElicitCardHost, _turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    // No consent control: a link button opens the page but reports nothing back, and consent is all that seam decides.
    if (ask.url || !ask.form?.length) return null
    // Core's own line between a one-tap card and a form, so the record and the card never disagree.
    const cardsV2 =
      elicitCardShape(ask.form) === 'inputs'
        ? buildGoogleChatElicitForm(ask.requestId, ask.params, ask.form)
        : buildGoogleChatElicitButtons(ask.requestId, ask.message, ask.form[0]!.options)
    return cardsV2 ? ({ cardsV2, fallbackText: ask.fallback } satisfies GoogleChatElicitDraft) : null
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk, draft: ElicitCardDraft) {
    const d = draft as GoogleChatElicitDraft
    // The card anchors as the turn's own posts do: the turn's Space, in its thread when it has one.
    const state = host.turnState(turn) as GoogleChatTurnState
    const conn = state.conn as Partial<GoogleChatCardPort> | undefined
    if (!conn?.createMessage || !conn.patchCards) return undefined
    const post = conn.createMessage.bind(conn)
    return await host.postCardSerialized(turn, async () => {
      const created = await post({
        space: state.space,
        ...(state.thread ? { thread: state.thread } : {}),
        clientId: googleChatElicitClientId(ask.requestId),
        cardsV2: d.cardsV2,
        ...(d.fallbackText ? { fallbackText: clampTo(d.fallbackText, GOOGLE_CHAT_ELICIT_MESSAGE_CAP) } : {})
      })
      return created.name
    })
  },

  settle(handle: ElicitCardHandle, settlement: ElicitCardSettlement): void {
    if (handle.ts === undefined) return
    const conn = handle.conn as Partial<GoogleChatCardPort> | undefined
    const message = (settlement.params as { message?: string }).message?.trim() || 'The agent needs your input'
    const decision = `${GOOGLE_CHAT_ELICIT_MARK[settlement.mark]} ${clampTo(settlement.text, GOOGLE_CHAT_ELICIT_DECISION_CAP)}`
    void conn?.patchCards?.(handle.ts, buildGoogleChatElicitSettled(message, decision)).catch(() => {})
  }
}
