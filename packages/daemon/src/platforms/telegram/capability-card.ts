// Telegram's capability-card facet (capability-requests.md §4.4.2): a url button and a Decline callback, rewritten with `editMessageText`.
import type { InlineButton, TelegramConnection } from '../../telegram/connection.js'
import { TELEGRAM_MESSAGE_LIMIT } from '../../telegram/render.js'
import { clampTo } from '../../slack/render.js'
import { capabilityClick } from '../capability-click.js'
import {
  capabilityDeclineData,
  capabilitySettledText,
  type CapabilityCardDraft,
  type CapabilityCardFacet,
  type CapabilityCardHandle,
  type CapabilityCardModel,
  type CapabilityCardOutcome,
  type CapabilityCardPlace
} from '../capability-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import { TELEGRAM_BUTTON_LABEL_CAP } from './elicit-card.js'
import type { TelegramTurnState } from './turn-output.js'

/** The agent's reason as the card shows it (§4.1). */
const REASON_MAX = 280

/** A card in plain text (posted with no `parse_mode`, so nothing in it is markup) and its keyboard; an empty one drops the buttons. */
interface TelegramCapabilityDraft {
  text: string
  buttons: InlineButton[][]
}

type CapabilityCardConnection = Pick<TelegramConnection, 'postCard' | 'editCard' | 'getChannelInfo'>

const conn = (c: unknown): CapabilityCardConnection => c as CapabilityCardConnection

/** Where a post lands: a numeric forum topic, or the reply chain a `tg:<root>` session lives in. */
function anchorOf(place: { thread?: string }): { threadTs?: string; replyTo?: number } {
  if (place.thread && /^\d+$/.test(place.thread)) return { threadTs: place.thread }
  const root = place.thread ? /^tg:(\d+)$/.exec(place.thread) : null
  return root ? { replyTo: Number(root[1]) } : {}
}

/** A pending card: what was asked, the reason, who asked, then Open and Decline. */
export function buildTelegramCapabilityCard(model: CapabilityCardModel): TelegramCapabilityDraft {
  const lines = [
    `🔑 ${clampTo(model.agentName, 80)} is asking for: ${clampTo(model.summary, 500)}`,
    `Reason: ${clampTo(model.reason, REASON_MAX)}`,
    ...(model.context?.trim() ? [clampTo(model.context, 200)] : [])
  ]
  const buttons: InlineButton[][] = [
    [
      { text: clampTo('Open in AgentConnect', TELEGRAM_BUTTON_LABEL_CAP), callbackData: '', url: model.link },
      { text: 'Decline', callbackData: capabilityDeclineData(model.generation, model.cardId) }
    ]
  ]
  return { text: clampTo(lines.join('\n'), TELEGRAM_MESSAGE_LIMIT), buttons }
}

/** A settled card: what happened and the request's page, with no buttons left. */
export function buildTelegramCapabilitySettled(
  model: CapabilityCardModel,
  outcome: CapabilityCardOutcome
): TelegramCapabilityDraft {
  const text = `${capabilitySettledText(model.summary, outcome)}\nView the request: ${model.link}`
  return { text: clampTo(text, TELEGRAM_MESSAGE_LIMIT), buttons: [] }
}

export const telegramCapabilityCards: CapabilityCardFacet = {
  platform: 'telegram',
  declineControl: 'button',

  build: (model) => buildTelegramCapabilityCard(model),

  settled: (model, outcome) => buildTelegramCapabilitySettled(model, outcome),

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: CapabilityCardDraft): Promise<string | undefined> {
    const d = draft as TelegramCapabilityDraft
    // Anchored as the turn's other posts are, so a `tg:<root>` session keeps the card in its reply chain.
    const { replyTo } = host.turnState(turn) as TelegramTurnState
    const anchor = { threadTs: turn.plan.thread, ...(replyTo !== undefined ? { replyTo } : {}) }
    return await host.postCardSerialized(turn, (c) => conn(c).postCard(turn.plan.channel, d.text, d.buttons, anchor))
  },

  async post(c: unknown, place: CapabilityCardPlace, draft: CapabilityCardDraft): Promise<string | undefined> {
    const d = draft as TelegramCapabilityDraft
    return await conn(c).postCard(place.channel, d.text, d.buttons, anchorOf(place))
  },

  async rewrite(
    handle: CapabilityCardHandle,
    draft: CapabilityCardDraft
  ): Promise<'edited' | 'followed-up' | 'failed'> {
    const d = draft as TelegramCapabilityDraft
    const id = Number(handle.ts)
    const edited =
      Number.isInteger(id) &&
      (await conn(handle.conn)
        .editCard(handle.channel, id, d.text, d.buttons)
        .catch(() => false))
    if (edited) return 'edited'
    // A card Telegram will not edit (deleted, too old) is answered beside it instead.
    const posted = await conn(handle.conn)
      .postCard(handle.channel, d.text, d.buttons, anchorOf(handle))
      .catch(() => undefined)
    return posted ? 'followed-up' : 'failed'
  },

  // A tap's own answer is the only line one person sees, so a line with no tap is dropped.
  async tellPrivately(handle: Omit<CapabilityCardHandle, 'ts'>, userId: string, text: string): Promise<void> {
    capabilityClick(handle.conn, userId)?.reply(text)
  },

  // A bot may message a person only in the private chat they opened with it, whose id is theirs.
  openDirectMessage: async (_c, userId) => userId,

  // Telegram names the tapper's kind on the tap itself; without one, nobody is taken for a person.
  isPerson: async (c, userId) => capabilityClick(c, userId)?.isBot === false,

  async directMessageWith(c: unknown, channel: string): Promise<string | null> {
    const info = await conn(c).getChannelInfo(channel)
    if (!info.isIm) return null
    if (!info.user) throw new Error('Telegram named no person for this private chat')
    return info.user
  },

  nameOf: async (c, userId) => capabilityClick(c, userId)?.name
}
