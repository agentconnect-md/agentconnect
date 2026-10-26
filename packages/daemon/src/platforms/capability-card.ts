// The capability-card facet of Layer 2 (capability-requests.md §4.4.1): how a chat surface shows an agent's request for what it lacks, with a link and a way to decline.
import type { ElicitCardHost, ElicitCardTurn } from './elicit-card.js'

/** One request's card as core hands it to a surface; every field but the ids is plain text each surface defuses itself. */
export interface CapabilityCardModel {
  readonly requestId: string
  readonly generation: number
  /** This card's own unguessable id, which its Decline control carries back. */
  readonly cardId: string
  /** What was asked, as the Control Plane words it. */
  readonly summary: string
  /** The agent's one sentence, shown as plain text. */
  readonly reason: string
  readonly link: string
  readonly agentName: string
  /** One plain line under the reason: who asked, or who forwarded it. */
  readonly context?: string
  /** The agent, bot and session a relay-forwarded click is routed back by. */
  readonly via: { readonly agentId: string; readonly integrationId: string; readonly sessionKey: string }
}

/** How a card reads once its request is no longer open. */
export type CapabilityCardOutcome =
  | { readonly status: 'completed'; readonly by?: string; readonly outcome: string }
  | { readonly status: 'declined'; readonly by?: string }
  | { readonly status: 'expired' }
  | { readonly status: 'withdrawn' }

/** A conversation of the platform the card is posted into: a direct message or the session's own conversation. */
export interface CapabilityCardPlace {
  readonly channel: string
  readonly thread?: string
}

/** A posted card's coordinates, as the daemon's store keeps them across a restart. */
export interface CapabilityCardHandle {
  readonly conn: unknown
  readonly channel: string
  readonly thread?: string
  readonly ts: string
}

/** A card the surface built but has not sent, in its own wire shape. Opaque to core. */
export type CapabilityCardDraft = unknown

/** One chat surface's capability-card facet; absent ⇒ no card, and the agent puts the link in its own reply. */
export interface CapabilityCardFacet {
  readonly platform: string
  /** How a Decline reaches the daemon: a button on the card, a numbered reply, or not at all. */
  readonly declineControl: 'button' | 'reply' | 'none'
  /** False where the app cannot open a direct message with a person, so core never routes a card there. */
  readonly directMessages?: boolean
  /** A `reply` surface: whether a reply to the card says Decline. */
  claimReply?(text: string): boolean
  build(model: CapabilityCardModel): CapabilityCardDraft
  /** The card once settled, its controls gone. */
  settled(model: CapabilityCardModel, outcome: CapabilityCardOutcome): CapabilityCardDraft
  /** Post into the turn's own conversation on its apply chain; the message id, or undefined when refused. */
  send(host: ElicitCardHost, turn: ElicitCardTurn, draft: CapabilityCardDraft): Promise<string | undefined>
  /** Post into another conversation (a direct message) on a connection core resolved for it. */
  post(
    conn: unknown,
    place: CapabilityCardPlace,
    draft: CapabilityCardDraft,
    identity: { readonly agentName: string; readonly iconUrl?: string }
  ): Promise<string | undefined>
  /** Edit the card in place, else post a follow-up beside it. */
  rewrite(handle: CapabilityCardHandle, draft: CapabilityCardDraft): Promise<'edited' | 'followed-up' | 'failed'>
  /** Tell only `userId`, beside the card, why their click was not taken. */
  tellPrivately(handle: Omit<CapabilityCardHandle, 'ts'>, userId: string, text: string): Promise<void>
  /** The direct message with a person, opened if needed. */
  openDirectMessage(conn: unknown, userId: string): Promise<string>
  /** Whether a member is a person rather than a bot; fails closed. */
  isPerson(conn: unknown, userId: string): Promise<boolean>
  /** The person a one-to-one direct message is with; null for any other conversation; throws when it cannot tell. */
  directMessageWith(conn: unknown, channel: string): Promise<string | null>
  /** A member's display name, for a click that carried none. */
  nameOf(conn: unknown, userId: string): Promise<string | undefined>
}

/** The most a settled card's text says, as for every settled card. */
export const CAPABILITY_SETTLED_TEXT_MAX = 300

const clamp = (text: string, max: number): string => {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** How a settled card reads, in plain text with literal marks; each surface defuses its own markup. */
export function capabilitySettledText(summary: string, outcome: CapabilityCardOutcome): string {
  const by = (who: string | undefined): string => (who?.trim() ? ` by ${who.trim()}` : '')
  switch (outcome.status) {
    case 'completed':
      return clamp(`✅ Completed${by(outcome.by)} — ${outcome.outcome || summary}`, CAPABILITY_SETTLED_TEXT_MAX)
    case 'declined':
      return clamp(`🚫 Declined${by(outcome.by)} — ${summary}`, CAPABILITY_SETTLED_TEXT_MAX)
    case 'expired':
      return clamp(`⏳ Expired — nobody acted on it in 7 days: ${summary}`, CAPABILITY_SETTLED_TEXT_MAX)
    case 'withdrawn':
      return clamp(`⏳ No longer needed — ${summary}`, CAPABILITY_SETTLED_TEXT_MAX)
  }
}

/** The option a card's Decline control carries: the generation it belongs to and the card it was on. */
export function capabilityDeclineOption(generation: number, cardId: string): string {
  return `cr-decline:${generation}:${cardId}`
}

/** The generation and card a Decline option names, or null when the option is not one. */
export function parseCapabilityDeclineOption(optionId: string): { generation: number; cardId: string } | null {
  const match = /^cr-decline:([1-9]\d{0,9}):([0-9a-f-]{36})$/.exec(optionId)
  return match ? { generation: Number(match[1]), cardId: match[2]! } : null
}

/** A Decline control's compact form for a platform whose callback carries only a short string: the generation and the card. */
export function capabilityDeclineData(generation: number, cardId: string): string {
  return `ac_cr:${generation}:${cardId}`
}

/** The generation and card a compact Decline names, or null when the data is not one. */
export function parseCapabilityDeclineData(data: string): { generation: number; cardId: string } | null {
  const match = /^ac_cr:([1-9]\d{0,9}):([0-9a-f-]{36})$/.exec(data)
  return match ? { generation: Number(match[1]), cardId: match[2]! } : null
}
