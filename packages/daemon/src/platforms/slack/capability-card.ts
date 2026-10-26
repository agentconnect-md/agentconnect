// Slack's capability-card facet (capability-requests.md §4.4.2): a link button and Decline, rewritten with `chat.update`.
import { encodePermValue, encodeSharedSlackStatusTarget, PERMISSION_ACTION_PREFIX } from '@agentconnect.md/protocol'
import type { SlackConnection } from '../../slack/connection.js'
import { CAPABILITY_OPEN_ACTION } from '../../slack/render.js'
import {
  capabilityDeclineOption,
  capabilitySettledText,
  type CapabilityCardDraft,
  type CapabilityCardFacet,
  type CapabilityCardHandle,
  type CapabilityCardModel,
  type CapabilityCardOutcome,
  type CapabilityCardPlace
} from '../capability-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import { slackAgentIdentityOptions } from './turn-output.js'

/** The agent's reason as the card shows it (§4.1). */
const REASON_MAX = 280
/** Slack's limit on a button's `url`. */
const BUTTON_URL_MAX = 3000

/** A Slack card: its blocks and the notification text beside them. */
interface SlackCapabilityDraft {
  blocks: unknown[]
  fallback: string
}

type CapabilityCardConnection = Pick<
  SlackConnection,
  | 'postBlocks'
  | 'updateBlocks'
  | 'postEphemeral'
  | 'openDirectMessage'
  | 'getUserProfile'
  | 'getChannelInfo'
  | 'memberName'
>

const clamp = (text: string, max: number): string => {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The three characters Slack mrkdwn reads as markup rather than as themselves. */
const escapeMrkdwn = (raw: string): string => raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A pending card: what was asked, the reason as plain text, who asked, then Open and Decline. */
export function buildCapabilityCard(model: CapabilityCardModel): unknown[] {
  const routingTarget = encodeSharedSlackStatusTarget(model.via)
  const open = {
    type: 'button',
    action_id: CAPABILITY_OPEN_ACTION,
    text: { type: 'plain_text', text: 'Open in AgentConnect', emoji: true },
    style: 'primary',
    url: model.link.slice(0, BUTTON_URL_MAX)
  }
  const decline = {
    type: 'button',
    action_id: `${PERMISSION_ACTION_PREFIX}:0`,
    text: { type: 'plain_text', text: 'Decline', emoji: true },
    value: encodePermValue(model.requestId, capabilityDeclineOption(model.generation, model.cardId))
  }
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:key: *${escapeMrkdwn(clamp(model.agentName, 80))} is asking for:* ${escapeMrkdwn(clamp(model.summary, 500))}`,
        verbatim: true
      }
    },
    {
      type: 'context',
      elements: [{ type: 'plain_text', text: `Reason: ${clamp(model.reason, REASON_MAX)}`, emoji: false }]
    },
    ...(model.context?.trim()
      ? [{ type: 'context', elements: [{ type: 'plain_text', text: clamp(model.context, 200), emoji: false }] }]
      : []),
    { type: 'actions', block_id: routingTarget, elements: [open, decline] }
  ]
}

/** A settled card: what happened, the reason kept for the record, and the request's page. */
export function buildCapabilitySettledCard(model: CapabilityCardModel, outcome: CapabilityCardOutcome): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: escapeMrkdwn(capabilitySettledText(model.summary, outcome)), verbatim: true }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${model.link.slice(0, BUTTON_URL_MAX)}|View the request>`, verbatim: true }]
    }
  ]
}

const conn = (c: unknown): CapabilityCardConnection => c as CapabilityCardConnection

export const slackCapabilityCards: CapabilityCardFacet = {
  platform: 'slack',
  declineControl: 'button',

  build(model: CapabilityCardModel): CapabilityCardDraft {
    return {
      blocks: buildCapabilityCard(model),
      fallback: `${model.agentName} is asking for: ${clamp(model.summary, 200)}`
    } satisfies SlackCapabilityDraft
  },

  settled(model: CapabilityCardModel, outcome: CapabilityCardOutcome): CapabilityCardDraft {
    return {
      blocks: buildCapabilitySettledCard(model, outcome),
      fallback: capabilitySettledText(model.summary, outcome)
    } satisfies SlackCapabilityDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: CapabilityCardDraft): Promise<string | undefined> {
    const d = draft as SlackCapabilityDraft
    const options = { ...(slackAgentIdentityOptions(turn.plan) ?? {}), chrome: true }
    return await host.postCardSerialized(turn, (c) =>
      conn(c).postBlocks(turn.plan.channel, d.blocks, d.fallback, turn.plan.thread, options)
    )
  },

  async post(
    c: unknown,
    place: CapabilityCardPlace,
    draft: CapabilityCardDraft,
    identity: { readonly agentName: string; readonly iconUrl?: string }
  ): Promise<string | undefined> {
    const d = draft as SlackCapabilityDraft
    return await conn(c).postBlocks(place.channel, d.blocks, d.fallback, place.thread, {
      username: identity.agentName,
      ...(identity.iconUrl ? { icon_url: identity.iconUrl } : {}),
      chrome: true
    })
  },

  async rewrite(
    handle: CapabilityCardHandle,
    draft: CapabilityCardDraft
  ): Promise<'edited' | 'followed-up' | 'failed'> {
    const d = draft as SlackCapabilityDraft
    const edited = await conn(handle.conn)
      .updateBlocks(handle.channel, handle.ts, d.blocks, d.fallback, true)
      .catch(() => false)
    if (edited) return 'edited'
    // A card Slack will not edit (deleted, too old) is answered beside it instead.
    const posted = await conn(handle.conn)
      .postBlocks(handle.channel, d.blocks, d.fallback, handle.thread, { chrome: true })
      .catch(() => undefined)
    return posted ? 'followed-up' : 'failed'
  },

  async tellPrivately(handle: Omit<CapabilityCardHandle, 'ts'>, userId: string, text: string): Promise<void> {
    await conn(handle.conn).postEphemeral(handle.channel, userId, text, handle.thread)
  },

  openDirectMessage: (c, userId) => conn(c).openDirectMessage(userId),

  isPerson: async (c, userId) =>
    (
      await conn(c)
        .getUserProfile(userId)
        .catch(() => undefined)
    )?.isBot === false,

  async directMessageWith(c: unknown, channel: string): Promise<string | null> {
    const info = await conn(c).getChannelInfo(channel)
    if (!info.isIm) return null
    if (!info.user) throw new Error('Slack named no person for this direct message')
    return info.user
  },

  nameOf: (c, userId) => conn(c).memberName(userId)
}
