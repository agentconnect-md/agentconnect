// Feishu/Lark's capability-card facet (capability-requests.md §4.4.2): an `open_url` button and a Decline callback, the card updated in place.
import type { WireFeishuCardActionTarget } from '@agentconnect.md/protocol'
import type { FeishuConnection } from '../../feishu/connection.js'
import { FEISHU_MESSAGE_LIMIT, feishuCardTarget } from '../../feishu/render.js'
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
import { FEISHU_LABEL_CAP, feishuButtonRow, feishuCard, feishuPlainText } from './elicit-card.js'

/** What a capability card's Decline names itself, apart from a permission, elicitation or session-control card. */
export const FEISHU_CAPABILITY_ACTION = 'agentconnect_capability'

/** The agent's reason as the card shows it (§4.1). */
const REASON_MAX = 280

interface FeishuCapabilityDraft {
  card: Record<string, unknown>
}

type CapabilityCardConnection = Pick<
  FeishuConnection,
  'postElicitCard' | 'updateElicitCard' | 'getChannelInfo' | 'listMemberIds' | 'getUserProfile'
>

const conn = (c: unknown): CapabilityCardConnection => c as CapabilityCardConnection

/** The Decline button's callback payload: the card, its generation, and the integration the relay routes it to. Pure. */
export function feishuCapabilityDeclineValue(
  generation: number,
  cardId: string,
  target?: WireFeishuCardActionTarget
): Record<string, unknown> {
  return {
    action: FEISHU_CAPABILITY_ACTION,
    card: cardId,
    generation: String(generation),
    ...(target ? { target } : {})
  }
}

/** A clicked Decline: its card and generation; null for a payload this scheme did not mint. Pure. */
export function parseFeishuCapabilityDecline(value: unknown): { generation: number; cardId: string } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.action !== FEISHU_CAPABILITY_ACTION || typeof v.card !== 'string' || !/^[0-9a-f-]{36}$/.test(v.card))
    return null
  if (typeof v.generation !== 'string' || !/^[1-9]\d{0,9}$/.test(v.generation)) return null
  return { generation: Number(v.generation), cardId: v.card }
}

/** The request's page as a markdown element: the URL is ours, so only it may render as a link. */
const link = (url: string, label: string): Record<string, unknown> => ({
  tag: 'markdown',
  content: `[${label}](${url})`
})

/** A pending card: what was asked, the reason, who asked, then Open and Decline. */
export function buildFeishuCapabilityCard(model: CapabilityCardModel): FeishuCapabilityDraft {
  const target = feishuCardTarget(model.via.agentId, model.via.integrationId)
  const text = [
    `🔑 ${clampTo(model.agentName, 80)} is asking for: ${clampTo(model.summary, 500)}`,
    `Reason: ${clampTo(model.reason, REASON_MAX)}`,
    ...(model.context?.trim() ? [clampTo(model.context, 200)] : [])
  ].join('\n')
  const open = {
    tag: 'button',
    text: { tag: 'plain_text', content: clampTo('Open in AgentConnect', FEISHU_LABEL_CAP) },
    type: 'primary',
    behaviors: [{ type: 'open_url', default_url: model.link }]
  }
  const decline = {
    tag: 'button',
    text: { tag: 'plain_text', content: 'Decline' },
    type: 'danger',
    behaviors: [{ type: 'callback', value: feishuCapabilityDeclineValue(model.generation, model.cardId, target) }]
  }
  return { card: feishuCard([feishuPlainText(clampTo(text, FEISHU_MESSAGE_LIMIT)), feishuButtonRow([open, decline])]) }
}

/** A settled card: what happened and the request's page, with no buttons left. */
export function buildFeishuCapabilitySettled(
  model: CapabilityCardModel,
  outcome: CapabilityCardOutcome
): FeishuCapabilityDraft {
  return {
    card: feishuCard([
      feishuPlainText(capabilitySettledText(model.summary, outcome)),
      link(model.link, 'View the request')
    ])
  }
}

export const feishuCapabilityCards: CapabilityCardFacet = {
  platform: 'feishu',
  declineControl: 'button',
  // A Feishu/Lark card is posted to a chat id, and this app does not open one with a person.
  directMessages: false,

  build: (model) => buildFeishuCapabilityCard(model),

  settled: (model, outcome) => buildFeishuCapabilitySettled(model, outcome),

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: CapabilityCardDraft): Promise<string | undefined> {
    const d = draft as FeishuCapabilityDraft
    // Anchored as the turn's other posts are: an `om_` thread is replied into, a chat is posted to.
    return await host.postCardSerialized(turn, (c) =>
      conn(c).postElicitCard(turn.plan.channel, turn.plan.thread, d.card)
    )
  },

  async post(c: unknown, place: CapabilityCardPlace, draft: CapabilityCardDraft): Promise<string | undefined> {
    return await conn(c).postElicitCard(place.channel, place.thread, (draft as FeishuCapabilityDraft).card)
  },

  async rewrite(
    handle: CapabilityCardHandle,
    draft: CapabilityCardDraft
  ): Promise<'edited' | 'followed-up' | 'failed'> {
    const card = (draft as FeishuCapabilityDraft).card
    if (
      await conn(handle.conn)
        .updateElicitCard(handle.ts, card)
        .catch(() => false)
    )
      return 'edited'
    // A card Feishu/Lark will not update (recalled, too old) is answered beside it instead.
    const posted = await conn(handle.conn)
      .postElicitCard(handle.channel, handle.thread, card)
      .catch(() => undefined)
    return posted ? 'followed-up' : 'failed'
  },

  // The callback's toast is the only line one person sees, so a line with no click is dropped.
  async tellPrivately(handle: Omit<CapabilityCardHandle, 'ts'>, userId: string, text: string): Promise<void> {
    capabilityClick(handle.conn, userId)?.reply(text)
  },

  async openDirectMessage(): Promise<string> {
    throw new Error('Feishu/Lark capability cards are not sent to a direct message')
  },

  // Only a person can operate a card, so the clicker is one; nobody else is taken for a person.
  isPerson: async (c, userId) => capabilityClick(c, userId) !== undefined,

  async directMessageWith(c: unknown, channel: string): Promise<string | null> {
    const info = await conn(c).getChannelInfo(channel)
    if (!info.isIm) return null
    // A p2p chat lists its one person (the bot is not a member), by the union_id a click carries too.
    const members = await conn(c).listMemberIds(channel)
    if (members.length !== 1) throw new Error('Feishu/Lark named no single person for this chat')
    return members[0]!
  },

  async nameOf(c: unknown, userId: string): Promise<string | undefined> {
    const click = capabilityClick(c, userId)
    if (click?.name) return click.name
    return (
      await conn(c)
        .getUserProfile(userId)
        .catch(() => undefined)
    )?.name
  }
}
