// Google Chat's approval-card facet (§7.3): a cardsV2 message whose buttons reach the events URL, rewritten in place; a refusal is a private message.
import { createHash, randomUUID } from 'node:crypto'
import {
  GOOGLE_CHAT_ACTION_PARAMETER,
  GOOGLE_CHAT_ELICIT_FUNCTION,
  type WireGoogleChatCardAction
} from '@agentconnect.md/protocol'
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
import { clampTo, permToolLabel, type SubsessionNoticeOutcome } from '../../slack/render.js'
import type { GoogleChatMessageRef } from './connection.js'
import type { GoogleChatTurnState } from './turn-output.js'

/** Our own cap, as the elicitation card's: Google publishes no per-card button count, so a longer list goes to the console. */
export const GOOGLE_CHAT_APPROVAL_MAX_OPTIONS = 25

const GOOGLE_CHAT_LABEL_CAP = 75
const GOOGLE_CHAT_DECISION_CAP = 300
const CARD_ID = 'agentconnect-approval'

/** What the connection offers a card: a create by client id (privately, to one viewer, too), a cards-only rewrite, and the events URL every button names. */
export interface GoogleChatApprovalPort {
  eventsUrl?: string
  createMessage(input: {
    space: string
    thread?: string
    clientId: string
    text?: string
    cardsV2?: readonly unknown[]
    fallbackText?: string
    privateViewer?: string
  }): Promise<GoogleChatMessageRef>
  patchCards(name: string, cardsV2: readonly unknown[]): Promise<void>
}

interface GoogleChatApprovalDraft {
  cardsV2: unknown[]
  clientId: string
  fallbackText?: string
}

/** A card's client id: one per request, so a retried create returns the card already posted. */
function clientIdFor(seed: string): string {
  return `client-${createHash('sha256').update(seed).digest('hex').slice(0, 48)}`
}

// Card text paragraphs read a small HTML subset, so runtime and agent words are escaped and never become markup.
function cardText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

const paragraph = (html: string): Record<string, unknown> => ({ textParagraph: { text: html } })

function card(widgets: Record<string, unknown>[]): unknown[] {
  return [{ cardId: CARD_ID, card: { sections: [{ widgets }] } }]
}

/** The console link: the URL is ours, so only it may render as a link. */
const link = (url: string): string => `<a href="${cardText(url)}">Open the task</a>`

function intro(asker: SubsessionAsker): Record<string, unknown> {
  const who = subsessionAskerText(asker.agentName, asker.title, clampTo)
  return paragraph(
    `${cardText(`${who} is asking for permission. ${subsessionWaitText(asker.waitHours)}`)}<br>${link(asker.sessionUrl)}`
  )
}

/** One option button: the click rides the action every relay already forwards, naming the request and the option's position. */
function optionButton(eventsUrl: string, requestId: string, label: string, option: number): Record<string, unknown> {
  return {
    text: clampTo(label, GOOGLE_CHAT_LABEL_CAP),
    onClick: {
      action: {
        function: eventsUrl,
        parameters: [
          { key: GOOGLE_CHAT_ACTION_PARAMETER, value: GOOGLE_CHAT_ELICIT_FUNCTION },
          { key: 'approval', value: requestId },
          { key: 'option', value: String(option) }
        ]
      }
    }
  }
}

/** A forwarded click on a permission card: its request and option position; null for any other click. Pure. */
export function parseGoogleChatApprovalClick(
  action: WireGoogleChatCardAction
): { requestId: string; option: number } | null {
  if (action.function !== GOOGLE_CHAT_ELICIT_FUNCTION) return null
  const requestId = action.parameters.approval
  const option = action.parameters.option
  if (!requestId || !option || !/^\d{1,2}$/.test(option)) return null
  return { requestId, option: Number(option) }
}

/** Only a `spaces/…/threads/…` of this Space is a thread a create can reply into; a DM's create takes none. */
function threadIn(space: string, thread: string | undefined): string | undefined {
  return thread?.startsWith(`${space}/threads/`) ? thread : undefined
}

/** Tell one user, privately, beside a card: a message only they and the app can see, in its thread when it has one. */
export async function tellGoogleChatPrivately(
  conn: unknown,
  space: string,
  thread: string | undefined,
  userId: string,
  text: string
): Promise<void> {
  const port = conn as Partial<GoogleChatApprovalPort> | undefined
  if (!port?.createMessage) return
  const base = { space, clientId: clientIdFor(`private\u001f${randomUUID()}`), text, privateViewer: userId }
  const into = threadIn(space, thread)
  try {
    await port.createMessage({ ...base, ...(into ? { thread: into } : {}) })
  } catch {
    // A thread the create could not reply into still leaves the person a private line in the Space.
    if (into)
      await port.createMessage({ ...base, clientId: clientIdFor(`private\u001f${randomUUID()}`) }).catch(() => {})
  }
}

export const googleChatApprovalCards: ApprovalCardFacet = {
  platform: 'googlechat',
  maxOptions: GOOGLE_CHAT_APPROVAL_MAX_OPTIONS,

  build(ask: ApprovalCardAsk, conn: unknown): ApprovalCardDraft | null {
    const options = ask.params.options
    if (!options.length || options.length > GOOGLE_CHAT_APPROVAL_MAX_OPTIONS) return null
    // Every button names the events URL, so without it no answer could ever arrive.
    const eventsUrl = (conn as Partial<GoogleChatApprovalPort> | undefined)?.eventsUrl
    if (!eventsUrl) return null
    const widgets = [
      ...(ask.subsession ? [intro(ask.subsession)] : []),
      paragraph(cardText(`🔒 Permission requested — ${permToolLabel(ask.params)}`)),
      { buttonList: { buttons: options.map((o, i) => optionButton(eventsUrl, ask.requestId, o.name, i)) } }
    ]
    return {
      cardsV2: card(widgets),
      clientId: clientIdFor(`approval\u001f${ask.requestId}`),
      fallbackText: clampTo(`Permission requested: ${permToolLabel(ask.params)}`, 300)
    } satisfies GoogleChatApprovalDraft
  },

  settled(settled: ApprovalCardSettlement): ApprovalCardDraft {
    const decision = `${approvalMark(settled.allowed)} ${clampTo(settled.text, GOOGLE_CHAT_DECISION_CAP)}`
    const widgets = [
      ...(settled.subsession ? [intro(settled.subsession)] : []),
      paragraph(cardText(`🔒 Permission — ${permToolLabel(settled.params)}\n${decision}`))
    ]
    return { cardsV2: card(widgets), clientId: '' } satisfies GoogleChatApprovalDraft
  },

  notice(asker: SubsessionAsker): ApprovalCardDraft {
    const who = subsessionAskerText(asker.agentName, asker.title, clampTo)
    const text = `🔒 ${who} is waiting for permission. Ask an Agent editor to allow it from the Agent or Session page. ${subsessionWaitText(asker.waitHours)}`
    return {
      cardsV2: card([paragraph(`${cardText(text)}<br>${link(asker.sessionUrl)}`)]),
      clientId: clientIdFor(`notice\u001f${randomUUID()}`),
      fallbackText: `${clampTo(asker.agentName, 60)} is waiting for permission`
    } satisfies GoogleChatApprovalDraft
  },

  noticeSettled(view: SubsessionNoticeView, outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const line = subsessionSettledText(subsessionAskerText(view.agentName, view.title, clampTo), outcome, (s) =>
      clampTo(s, 60)
    )
    const html = view.sessionUrl ? `${cardText(line)}<br>${link(view.sessionUrl)}` : cardText(line)
    return { cardsV2: card([paragraph(html)]), clientId: '' } satisfies GoogleChatApprovalDraft
  },

  turnNotice(): ApprovalCardDraft {
    return {
      cardsV2: card([paragraph(cardText(TURN_NOTICE_TEXT))]),
      clientId: clientIdFor(`notice\u001f${randomUUID()}`),
      fallbackText: 'Permission requested'
    } satisfies GoogleChatApprovalDraft
  },

  turnNoticeSettled(outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const line = turnNoticeSettledText(outcome, (s) => clampTo(s, 60))
    return { cardsV2: card([paragraph(cardText(line))]), clientId: '' } satisfies GoogleChatApprovalDraft
  },

  orphaned(row: ApprovalCardOrphan): ApprovalCardDraft {
    const by = row.resolvedByName ? ` by ${clampTo(row.resolvedByName, 60)}` : ''
    const text = `🔒 Permission — ${clampTo(row.command, 150)}\n${orphanMark(row.status)} ${row.status}${by}`
    return { cardsV2: card([paragraph(cardText(text))]), clientId: '' } satisfies GoogleChatApprovalDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as GoogleChatApprovalDraft
    // The card anchors as the turn's own posts do: the turn's Space, in its thread when it has one.
    const state = host.turnState(turn) as GoogleChatTurnState
    const conn = state.conn as Partial<GoogleChatApprovalPort> | undefined
    if (!conn?.createMessage) return undefined
    const create = conn.createMessage.bind(conn)
    return await host.postCardSerialized(turn, async () => {
      const created = await create({
        space: state.space,
        ...(state.thread ? { thread: state.thread } : {}),
        clientId: d.clientId,
        cardsV2: d.cardsV2,
        ...(d.fallbackText ? { fallbackText: d.fallbackText } : {})
      })
      return created.name
    })
  },

  async post(conn: unknown, place: ApprovalCardPlace, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as GoogleChatApprovalDraft
    const port = conn as Partial<GoogleChatApprovalPort> | undefined
    if (!port?.createMessage) return undefined
    const into = threadIn(place.channel, place.thread)
    const created = await port.createMessage({
      space: place.channel,
      ...(into ? { thread: into } : {}),
      clientId: d.clientId,
      cardsV2: d.cardsV2,
      ...(d.fallbackText ? { fallbackText: d.fallbackText } : {})
    })
    return created.name
  },

  rewrite(handle: ApprovalCardHandle, draft: ApprovalCardDraft): void {
    if (handle.ts === undefined) return
    const port = handle.conn as Partial<GoogleChatApprovalPort> | undefined
    void port?.patchCards?.(handle.ts, (draft as GoogleChatApprovalDraft).cardsV2).catch(() => {})
  },

  tellPrivately(handle: ApprovalCardHandle, userId: string, text: string): void {
    void tellGoogleChatPrivately(handle.conn, handle.channel, handle.thread, userId, text).catch(() => {})
  }
}
