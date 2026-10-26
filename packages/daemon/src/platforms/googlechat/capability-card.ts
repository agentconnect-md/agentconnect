// Google Chat's capability-card facet (capability-requests.md §4.4.2): an `openLink` button and a Decline action, patched in place.
import { createHash } from 'node:crypto'
import {
  GOOGLE_CHAT_ACTION_PARAMETER,
  GOOGLE_CHAT_ELICIT_FUNCTION,
  type WireGoogleChatCardAction
} from '@agentconnect.md/protocol'
import { clampTo } from '../../slack/render.js'
import { capabilityClick } from '../capability-click.js'
import {
  capabilitySettledText,
  type CapabilityCardDraft,
  type CapabilityCardFacet,
  type CapabilityCardHandle,
  type CapabilityCardModel,
  type CapabilityCardOutcome,
  type CapabilityCardPlace
} from '../capability-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import { tellGoogleChatPrivately, type GoogleChatApprovalPort } from './approval-card.js'
import type { GoogleChatConnection } from './connection.js'
import type { GoogleChatTurnState } from './turn-output.js'

/** The agent's reason as the card shows it (§4.1). */
const REASON_MAX = 280
const LABEL_CAP = 75
const CARD_ID = 'agentconnect-capability'

/** What the facet needs of a connection beyond the approval card's port: the DM a person is in, and which one is theirs. */
type CapabilityCardPort = GoogleChatApprovalPort &
  Pick<GoogleChatConnection, 'getChannelInfo' | 'directMessagePerson' | 'findDirectMessage'>

/** The card waits for the events URL its Decline names, which only the connection that posts it knows. */
interface GoogleChatCapabilityDraft {
  cardsV2: (eventsUrl: string | undefined) => unknown[] | null
  clientId: string
  fallbackText: string
}

const port = (c: unknown): Partial<CapabilityCardPort> | undefined => c as Partial<CapabilityCardPort> | undefined

/** A card's client id: one per card, so a retried create returns the card already posted. */
function clientIdFor(seed: string): string {
  return `client-${createHash('sha256').update(seed).digest('hex').slice(0, 48)}`
}

// Card text paragraphs read a small HTML subset, so agent and person words are escaped and never become markup.
function cardText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

const paragraph = (html: string): Record<string, unknown> => ({ textParagraph: { text: html } })

function card(widgets: Record<string, unknown>[]): unknown[] {
  return [{ cardId: CARD_ID, card: { sections: [{ widgets }] } }]
}

/** A forwarded Decline click: its card and generation; null for any other click. Pure. */
export function parseGoogleChatCapabilityClick(
  action: WireGoogleChatCardAction
): { generation: number; cardId: string } | null {
  if (action.function !== GOOGLE_CHAT_ELICIT_FUNCTION) return null
  const cardId = action.parameters.capability
  const generation = action.parameters.generation
  if (!cardId || !/^[0-9a-f-]{36}$/.test(cardId) || !generation || !/^[1-9]\d{0,9}$/.test(generation)) return null
  return { generation: Number(generation), cardId }
}

/** A pending card's widgets: what was asked, the reason, who asked, then Open and a Decline that rides the forwarded action. */
export function googleChatCapabilityWidgets(model: CapabilityCardModel, eventsUrl: string): Record<string, unknown>[] {
  const lines = [
    `🔑 ${clampTo(model.agentName, 80)} is asking for: ${clampTo(model.summary, 500)}`,
    `Reason: ${clampTo(model.reason, REASON_MAX)}`,
    ...(model.context?.trim() ? [clampTo(model.context, 200)] : [])
  ]
  const open = { text: clampTo('Open in AgentConnect', LABEL_CAP), onClick: { openLink: { url: model.link } } }
  const decline = {
    text: 'Decline',
    onClick: {
      action: {
        function: eventsUrl,
        parameters: [
          { key: GOOGLE_CHAT_ACTION_PARAMETER, value: GOOGLE_CHAT_ELICIT_FUNCTION },
          { key: 'capability', value: model.cardId },
          { key: 'generation', value: String(model.generation) }
        ]
      }
    }
  }
  return [paragraph(cardText(lines.join('\n'))), { buttonList: { buttons: [open, decline] } }]
}

/** A settled card's widgets: what happened and the request's page, with no buttons left. */
export function googleChatCapabilitySettledWidgets(
  model: CapabilityCardModel,
  outcome: CapabilityCardOutcome
): Record<string, unknown>[] {
  return [
    paragraph(
      `${cardText(capabilitySettledText(model.summary, outcome))}<br><a href="${cardText(model.link)}">View the request</a>`
    )
  ]
}

async function create(
  conn: unknown,
  place: { space: string; thread?: string },
  draft: GoogleChatCapabilityDraft
): Promise<string | undefined> {
  const p = port(conn)
  const cardsV2 = draft.cardsV2(p?.eventsUrl)
  if (!p?.createMessage || !cardsV2) return undefined
  const into = place.thread?.startsWith(`${place.space}/threads/`) ? place.thread : undefined
  const created = await p.createMessage({
    space: place.space,
    ...(into ? { thread: into } : {}),
    clientId: draft.clientId,
    cardsV2,
    fallbackText: draft.fallbackText
  })
  return created.name
}

export const googleChatCapabilityCards: CapabilityCardFacet = {
  platform: 'googlechat',
  declineControl: 'button',

  build(model: CapabilityCardModel): CapabilityCardDraft {
    return {
      // Every Decline names the events URL, so without it no card is posted and the agent shares the link instead.
      cardsV2: (eventsUrl) => (eventsUrl ? card(googleChatCapabilityWidgets(model, eventsUrl)) : null),
      clientId: clientIdFor(`capability\u001f${model.cardId}`),
      fallbackText: clampTo(`${model.agentName} is asking for: ${model.summary}`, 300)
    } satisfies GoogleChatCapabilityDraft
  },

  settled(model: CapabilityCardModel, outcome: CapabilityCardOutcome): CapabilityCardDraft {
    return {
      cardsV2: () => card(googleChatCapabilitySettledWidgets(model, outcome)),
      clientId: clientIdFor(`capability-settled\u001f${model.cardId}\u001f${outcome.status}`),
      fallbackText: capabilitySettledText(model.summary, outcome)
    } satisfies GoogleChatCapabilityDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: CapabilityCardDraft): Promise<string | undefined> {
    // The card anchors as the turn's own posts do: the turn's Space, in its thread when it has one.
    const state = host.turnState(turn) as GoogleChatTurnState
    const d = draft as GoogleChatCapabilityDraft
    return await host.postCardSerialized(turn, () =>
      create(state.conn, { space: state.space, ...(state.thread ? { thread: state.thread } : {}) }, d)
    )
  },

  async post(conn: unknown, place: CapabilityCardPlace, draft: CapabilityCardDraft): Promise<string | undefined> {
    return await create(
      conn,
      { space: place.channel, ...(place.thread ? { thread: place.thread } : {}) },
      draft as GoogleChatCapabilityDraft
    )
  },

  async rewrite(
    handle: CapabilityCardHandle,
    draft: CapabilityCardDraft
  ): Promise<'edited' | 'followed-up' | 'failed'> {
    const d = draft as GoogleChatCapabilityDraft
    const p = port(handle.conn)
    const cardsV2 = d.cardsV2(p?.eventsUrl)
    if (!cardsV2) return 'failed'
    // Patched under the app's write budget, like every other write of the connection.
    const edited = p?.patchCards
      ? await p.patchCards(handle.ts, cardsV2).then(
          () => true,
          () => false
        )
      : false
    if (edited) return 'edited'
    const posted = await create(
      handle.conn,
      { space: handle.channel, ...(handle.thread ? { thread: handle.thread } : {}) },
      d
    ).catch(() => undefined)
    return posted ? 'followed-up' : 'failed'
  },

  async tellPrivately(handle: Omit<CapabilityCardHandle, 'ts'>, userId: string, text: string): Promise<void> {
    await tellGoogleChatPrivately(handle.conn, handle.channel, handle.thread, userId, text)
  },

  async openDirectMessage(conn: unknown, userId: string): Promise<string> {
    const find = port(conn)?.findDirectMessage
    if (!find) throw new Error('this Google Chat connection cannot find a direct message')
    return await find.call(conn, userId)
  },

  // Only a person can click a card, so the clicker is one; nobody else is taken for a person.
  isPerson: async (c, userId) => capabilityClick(c, userId) !== undefined,

  async directMessageWith(conn: unknown, channel: string): Promise<string | null> {
    const p = port(conn)
    if (!p?.getChannelInfo || !p.directMessagePerson) throw new Error('this Google Chat connection reads no Spaces')
    const info = await p.getChannelInfo.call(conn, channel)
    if (!info.isIm) return null
    const person = await p.directMessagePerson.call(conn, channel)
    if (!person) throw new Error('Google Chat named no single person for this direct message')
    return person
  },

  nameOf: async (c, userId) => capabilityClick(c, userId)?.name
}
