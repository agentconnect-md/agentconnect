// Discord's capability-card facet (capability-requests.md §4.4.2): a link button and Decline under the card, edited in place.
import type { DiscordConnection } from '../../discord/connection.js'
import { DISCORD_MESSAGE_LIMIT, type DiscordButton, type DiscordComponents } from '../../discord/render.js'
import { defuseNoticeText } from '../../permissions/elicit-notice.js'
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
import { DISCORD_BUTTON_LABEL_CAP } from './elicit-card.js'

/** The agent's reason as the card shows it (§4.1). */
const REASON_MAX = 280
/** Discord's limit on a link button's `url`. */
const BUTTON_URL_MAX = 512

interface DiscordCapabilityDraft {
  text: string
  components: DiscordComponents
}

type CapabilityCardConnection = Pick<
  DiscordConnection,
  'postChrome' | 'updateMessage' | 'getUserProfile' | 'getChannelInfo' | 'openDirectMessage'
>

const conn = (c: unknown): CapabilityCardConnection => c as CapabilityCardConnection

/** Agent- and person-authored words, with Discord's markdown and link syntax defused. */
const md = (text: string, cap: number): string => defuseNoticeText(clampTo(text, cap), 'markdown')

/** A pending card: what was asked, the reason, who asked, then Open and Decline. */
export function buildDiscordCapabilityCard(model: CapabilityCardModel): DiscordCapabilityDraft {
  const lines = [
    `🔑 **${md(model.agentName, 80)} is asking for:** ${md(model.summary, 500)}`,
    `Reason: ${md(model.reason, REASON_MAX)}`,
    ...(model.context?.trim() ? [md(model.context, 200)] : [])
  ]
  const buttons: DiscordButton[] = [
    {
      type: 2,
      style: 5,
      label: clampTo('Open in AgentConnect', DISCORD_BUTTON_LABEL_CAP),
      url: model.link.slice(0, BUTTON_URL_MAX)
    },
    { type: 2, style: 4, label: 'Decline', custom_id: capabilityDeclineData(model.generation, model.cardId) }
  ]
  return { text: clampTo(lines.join('\n'), DISCORD_MESSAGE_LIMIT), components: [{ type: 1, components: buttons }] }
}

/** A settled card: what happened and the request's page; an empty component list drops the buttons. */
export function buildDiscordCapabilitySettled(
  model: CapabilityCardModel,
  outcome: CapabilityCardOutcome
): DiscordCapabilityDraft {
  const text = `${md(capabilitySettledText(model.summary, outcome), 400)}\n[View the request](${model.link.slice(0, BUTTON_URL_MAX)})`
  return { text: clampTo(text, DISCORD_MESSAGE_LIMIT), components: [] }
}

export const discordCapabilityCards: CapabilityCardFacet = {
  platform: 'discord',
  declineControl: 'button',

  build: (model) => buildDiscordCapabilityCard(model),

  settled: (model, outcome) => buildDiscordCapabilitySettled(model, outcome),

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: CapabilityCardDraft): Promise<string | undefined> {
    const d = draft as DiscordCapabilityDraft
    // A Discord thread is a channel of its own, so the card lands, and is edited, there.
    const channel = turn.plan.thread || turn.plan.channel
    return await host.postCardSerialized(turn, (c) => conn(c).postChrome(channel, d.text, { keyboard: d.components }))
  },

  async post(c: unknown, place: CapabilityCardPlace, draft: CapabilityCardDraft): Promise<string | undefined> {
    const d = draft as DiscordCapabilityDraft
    return await conn(c).postChrome(place.thread || place.channel, d.text, { keyboard: d.components })
  },

  async rewrite(
    handle: CapabilityCardHandle,
    draft: CapabilityCardDraft
  ): Promise<'edited' | 'followed-up' | 'failed'> {
    const d = draft as DiscordCapabilityDraft
    const channel = handle.thread || handle.channel
    const edited = await conn(handle.conn)
      .updateMessage(channel, handle.ts, d.text, { keyboard: d.components })
      .catch(() => false)
    if (edited) return 'edited'
    // A card Discord will not edit (deleted) is answered beside it instead.
    const posted = await conn(handle.conn)
      .postChrome(channel, d.text, { keyboard: d.components })
      .catch(() => undefined)
    return posted ? 'followed-up' : 'failed'
  },

  // Only the click's own interaction can answer one person privately, so a line with no click is dropped.
  async tellPrivately(handle: Omit<CapabilityCardHandle, 'ts'>, userId: string, text: string): Promise<void> {
    capabilityClick(handle.conn, userId)?.reply(text)
  },

  openDirectMessage: (c, userId) => conn(c).openDirectMessage(userId),

  async isPerson(c: unknown, userId: string): Promise<boolean> {
    const click = capabilityClick(c, userId)
    if (click?.isBot !== undefined) return !click.isBot
    return (
      (
        await conn(c)
          .getUserProfile(userId)
          .catch(() => undefined)
      )?.isBot === false
    )
  },

  async directMessageWith(c: unknown, channel: string): Promise<string | null> {
    const info = await conn(c).getChannelInfo(channel)
    if (!info.isIm) return null
    if (!info.user) throw new Error('Discord named no person for this direct message')
    return info.user
  },

  async nameOf(c: unknown, userId: string): Promise<string | undefined> {
    const click = capabilityClick(c, userId)
    if (click?.name) return click.name
    const profile = await conn(c)
      .getUserProfile(userId)
      .catch(() => undefined)
    return profile?.realName ?? profile?.name
  }
}
