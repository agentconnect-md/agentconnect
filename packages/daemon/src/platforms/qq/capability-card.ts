// QQ's capability-card facet (capability-requests.md §4.4.2): the link and "reply 1 to decline" as text, since bot buttons need separate platform approval.
import { parseQQUserId, QQUserId } from '@agentconnect.md/message'
import { clampTo } from '../../slack/render.js'
import {
  capabilitySettledText,
  type CapabilityCardDraft,
  type CapabilityCardFacet,
  type CapabilityCardHandle,
  type CapabilityCardModel,
  type CapabilityCardOutcome
} from '../capability-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import type { QQConnection } from './connection.js'
import { qqElicitInstruction } from './elicit-card.js'
import { QQTextMaxBytes } from './text.js'
import type { QQTurnState } from './turn-output.js'

/** The agent's reason as the card shows it (§4.1). */
const REASON_MAX = 280

type CapabilityCardConnection = Pick<QQConnection, 'followCard' | 'workspaceId'>

const conn = (c: unknown): Partial<CapabilityCardConnection> | undefined => c as Partial<CapabilityCardConnection>

// Clamp by UTF-8 bytes, the unit QQ's message limit counts.
function clampBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let out = ''
  for (const character of text) {
    if (Buffer.byteLength(out + character) > max - 3) break
    out += character
  }
  return `${out}…`
}

/** A pending card: what was asked, the reason, who asked, the link, and how to decline by replying. */
export function qqCapabilityText(model: CapabilityCardModel, channel: string): string {
  const instruction = qqElicitInstruction(channel).replace('with a number', 'with 1 to decline')
  const lines = [
    `🔑 ${clampTo(model.agentName, 80)} is asking for: ${clampTo(model.summary, 500)}`,
    `Reason: ${clampTo(model.reason, REASON_MAX)}`,
    ...(model.context?.trim() ? [clampTo(model.context, 200)] : []),
    `Open in AgentConnect: ${model.link}`,
    instruction
  ]
  return clampBytes(lines.join('\n'), QQTextMaxBytes)
}

export const qqCapabilityCards: CapabilityCardFacet = {
  platform: 'qq',
  declineControl: 'reply',
  // A QQ bot only answers a person's own message, so it cannot start a direct message.
  directMessages: false,

  // The card's text depends on the conversation it lands in, so the model rides the draft until then.
  build: (model) => model,

  settled: (model: CapabilityCardModel, outcome: CapabilityCardOutcome): CapabilityCardDraft =>
    clampBytes(`${capabilitySettledText(model.summary, outcome)}\nView the request: ${model.link}`, QQTextMaxBytes),

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: CapabilityCardDraft): Promise<string | undefined> {
    const state = host.turnState(turn) as QQTurnState
    const { conn: port, replyId, channel } = state
    if (!port?.sendCard || !replyId) return undefined
    const text = qqCapabilityText(draft as CapabilityCardModel, channel)
    return await host.postCardSerialized(turn, () => port.sendCard!(channel, replyId, text))
  },

  // A post outside a turn has no message of the person's to answer, so QQ cannot carry it.
  post: async () => undefined,

  // QQ cannot edit a sent message, so a settlement is a short follow-up on the card's own anchor.
  async rewrite(
    handle: CapabilityCardHandle,
    draft: CapabilityCardDraft
  ): Promise<'edited' | 'followed-up' | 'failed'> {
    const follow = conn(handle.conn)?.followCard
    if (!follow || typeof draft !== 'string') return 'failed'
    const sent = await follow.call(handle.conn, handle.channel, handle.ts, draft).catch(() => false)
    return sent ? 'followed-up' : 'failed'
  },

  claimReply: (text) => text.normalize('NFKC').trim() === '1',

  // QQ has no line only one person sees, so a refusal is not said at all.
  tellPrivately: async () => undefined,

  async openDirectMessage(): Promise<string> {
    throw new Error('a QQ bot cannot start a direct message')
  },

  // Every QQ sender this app receives is a person; an id of another app is not one of them.
  isPerson: async (c, userId) => parseQQUserId(userId)?.appId === conn(c)?.workspaceId?.(),

  async directMessageWith(c: unknown, channel: string): Promise<string | null> {
    if (!channel.startsWith('dm:')) return null
    const appId = conn(c)?.workspaceId?.()
    if (!appId) throw new Error('QQ named no app for this direct message')
    return QQUserId(appId, channel.slice('dm:'.length))
  },

  nameOf: async () => undefined
}
