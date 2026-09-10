/**
 * **The elicitation-card facet of Layer 2** (integration-plugin-architecture.md §7.3) — how one
 * chat surface COLLECTS the answer to an ACP `elicitation/create`.
 *
 * It is a turn output, not a registry of its own: a card is posted into the turn's conversation,
 * on the turn's connection, serialized on the turn's apply chain, and it belongs beside the
 * renderers and strategy functions that already live on {@link TurnOutputSurface}. Lookup is
 * therefore `exact()`, and that is load-bearing for the same reason `onSuppress` is — webchat,
 * hook and dream turns RENDER through the core (Slack-shaped) surface but must never inherit its
 * elicitation cards. Webchat's own card is core-owned (§12) and is answered before this facet is
 * ever consulted.
 *
 * WHY IT EXISTS AS A MEMBER AT ALL. `onAcpElicit` used to gate on
 * `!(conn instanceof SlackConnection)` — a platform name in core, which the plugin architecture
 * forbids outright. Telegram is the second implementer, so the member is shaped by two real
 * surfaces rather than guessed from one: Slack posts `blocks` and rewrites with `chat.update`,
 * Telegram posts an inline keyboard and rewrites with `editMessageText`. What they share is
 * exactly the four things below — a reduction they can render, a draft, a send, and a rewrite.
 *
 * BUILD IS SEPARATE FROM SEND, and the split is not cosmetic: an ask this surface has no control
 * for must be declined BEFORE the request is recorded as open (core posts the decline notice and
 * writes an `unrenderable` transcript row), whereas a card the platform simply refused to take is
 * an ask that WAS opened and then cancelled. One method returning `undefined` for both could not
 * tell those apart.
 */
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { ElicitSurface, ElicitTarget } from '../slack/render.js'

/** One elicitation card as core hands it to a surface: the ask, the words above it, and the
 *  reduction the card renders one control per. `form` and `url` are mutually exclusive — a
 *  URL-mode ask has no field, only a destination to consent to. */
export interface ElicitCardAsk {
  /** The unguessable id every control on this card carries back. */
  readonly requestId: string
  /** The ACP request, already secret-masked by core. Card builders re-derive from it (#1815). */
  readonly params: CreateElicitationRequest
  /** The card's own heading text. */
  readonly message: string
  /** The notification fallback shown where a card cannot render. */
  readonly fallback: string
  /** The fields this card renders one control per — THIS surface's own reduction. */
  readonly form?: readonly ElicitTarget[]
  /** URL mode's consent target (ACP `ElicitationUrlMode`). Present ⇒ the card is a consent card. */
  readonly url?: { readonly elicitationId: string; readonly url: string }
}

/** A card this surface built but has not sent — the surface's own wire shape (Slack's `blocks`,
 *  Telegram's text plus inline keyboard). Opaque to core, which only hands it back to `send`. */
export type ElicitCardDraft = unknown

/** A posted card's coordinates, which both chat surfaces spell the same way: the connection that
 *  posted it, the conversation it landed in, and the message id a rewrite addresses. Slack's `ts`
 *  and Telegram's `message_id` are one fact in two dialects, so core holds the handle without
 *  knowing which platform minted it. `ts` is absent until the send returns — a settlement that
 *  beats it leaves its label for the posting path instead. */
export interface ElicitCardHandle {
  readonly conn: unknown
  readonly channel: string
  ts?: string
  /** The card's OWN opaque state slot, written by the surface that assembles an answer over
   *  several taps (§7.3, the same shape `turnState` takes). Core never reads it; it exists so a
   *  surface with no message state of its own — Telegram's keyboard, where a tap carries only 64
   *  bytes — has somewhere to keep what has been picked so far, with core's own record lifetime.
   *  Absent on a surface whose every tap is a whole answer. */
  cardState?: unknown
}

/** How a settled card is MARKED, named by what happened rather than by any surface's glyph — a
 *  Slack shortcode and a Telegram emoji are the same four verdicts spelled two ways. */
export type ElicitCardMark = 'answered' | 'dismissed' | 'waiting' | 'blocked'

/** One card's settlement: the mark, what the mark is said about, and the ask it re-renders from.
 *  `text` is already in the card's own words (the chosen labels, `Dismissed`, `Cancelled`) — a
 *  surface only decides how to spell the mark beside it. */
export interface ElicitCardSettlement {
  readonly params: CreateElicitationRequest
  /** The card was a URL-mode consent card, whose settled shape keeps the destination on view. */
  readonly consent: boolean
  readonly mark: ElicitCardMark
  readonly text: string
  /** The notification fallback beside the card. Absent ⇒ the rendered decision doubles as one,
   *  which is what a consent card's settlement has always sent. */
  readonly fallback?: string
}

/** The turn, as an elicitation-card facet sees it: where the card goes and the identity it goes
 *  out under. Deliberately narrow — a facet may not reach core turn machinery. `Pending`
 *  satisfies it structurally, the same boundary Telegram's applier takes its turn through. */
export interface ElicitCardTurn {
  conn?: unknown
  plan: {
    platform: string
    channel: string
    thread?: string
    statusThread: string
    agentName: string
    iconUrl?: string
  }
}

/** The two core capabilities a facet needs to send a card, and nothing else. */
export interface ElicitCardHost {
  /** Post on the turn's apply chain as a chronological boundary, so pre-card chrome stays above
   *  the card and the following stream below it. Returns the platform's message id. */
  postCardSerialized(
    turn: ElicitCardTurn,
    post: (conn: unknown) => Promise<string | undefined>
  ): Promise<string | undefined>
  /** The opaque routing target a relay-forwarded interaction carries back to THIS daemon. A
   *  surface whose ingress is daemon-owned needs none and ignores it. */
  sessionTarget(turn: ElicitCardTurn): string | undefined
  /** This turn's OPAQUE platform state slot (§7.3) — the very object the platform's `apply`
   *  reads. A card is one of the turn's posts, so it must anchor exactly as the turn's other
   *  posts do; handing the same slot over is what keeps one platform to ONE anchoring
   *  mechanism, rather than a card re-deriving an anchor of its own. Core never reads it. */
  turnState(turn: ElicitCardTurn): unknown
}

/**
 * What one tap on an ASSEMBLED card meant, once the surface folded it into the card's state.
 *
 * A surface whose card submits on the tap itself never returns this — its taps are whole answers
 * and take {@link ElicitCardFacet.tap}'s absence. A surface that assembles one (Telegram toggling
 * a checkbox on a keyboard) reports which of three things just happened, and core does the rest:
 * `pending` is a state change the surface has already redrawn, `submit` is a Confirm carrying the
 * card's assembled fields — keyed exactly as a Slack Confirm's are, so both go through the SAME
 * re-derivation (#1815) — and null is a tap this card does not offer.
 */
export type ElicitCardTap = { kind: 'pending' } | { kind: 'submit'; fields: Record<string, string | string[]> }

/** The live card a tap is folded into: the id its buttons carry back, the ask they were built
 *  from, and the field list core RE-DERIVED from that ask (#1815) — so a redraw offers the very
 *  options the card was posted with. */
export interface ElicitCardTapTarget {
  readonly requestId: string
  readonly params: CreateElicitationRequest
  readonly form: readonly ElicitTarget[]
}

/** One typed answer as core offers it to a card: the conversation it was written in, the message
 *  it was written as a reply to, and its words. A surface matches it against whatever it asked the
 *  reader to reply TO — which is how one answer reaches exactly one card. */
export interface ElicitCardReply {
  /** The conversation, QUALIFIED BY THE BOT THAT RECEIVED IT — `transcriptChannelKey`, the same
   *  identity the transcript and the ingress dedup use. Not the bare channel: two Telegram bots
   *  DM'd by one person share that person's chat id AND its message numbers, so a bare channel
   *  would let a reply to bot B's message id settle bot A's card. */
  readonly conversation: string
  /** The message this reply answers, in the surface's own dialect. Absent ⇒ not a reply at all. */
  readonly replyTo?: string
  readonly text: string
}

/** One chat surface's elicitation-card facet. Registered on that platform's
 *  {@link TurnOutputSurface}; absent ⇒ the surface cannot collect an answer and core declines the
 *  ask with the in-channel notice. */
export interface ElicitCardFacet {
  /** Diagnostic label; never parsed. */
  readonly platform: string
  /** What this surface can render AND collect — the SAME declaration the reduction reads, because
   *  they are the same question. A kind whose control this surface lacks must not reach the card
   *  builder, and a control the reduction admits must be one the surface can actually offer; two
   *  declarations could only ever disagree, and the disagreement would be a card that is either
   *  posted dead or declined for nothing. Option limits ride along for the same reason. */
  readonly reduction: ElicitSurface
  /** Build the card, or null when this surface has no control for the ask — core then declines it
   *  with the notice and never records it as open. Called BEFORE the request is admitted. */
  build(host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null
  /** Send a built draft; the platform's message id, or undefined when it refused the send. */
  send(
    host: ElicitCardHost,
    turn: ElicitCardTurn,
    ask: ElicitCardAsk,
    draft: ElicitCardDraft
  ): Promise<string | undefined>
  /** Rewrite a posted card as settled — Slack's `chat.update`, Telegram's `editMessageText` with
   *  the keyboard dropped. Best effort by construction: no ACP outcome depends on it. */
  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void
  /** Fold one tap into a card that ASSEMBLES its answer, redrawing the card as the fold requires.
   *  Absent ⇒ every tap on this surface is already a whole answer and core resolves it directly.
   *  `form` is re-derived by core from the card's own params, so it is the very field list the
   *  card rendered. Null ⇒ the tap named nothing this card offers, and core refuses it aloud. */
  tap?(handle: ElicitCardHandle, card: ElicitCardTapTarget, token: string): ElicitCardTap | null
  /** Where a card of this surface is POSTED, when that is not the turn's own channel. Absent ⇒ it
   *  is — which is true of Slack (a thread is a `ts` within its channel) and of Telegram (a topic
   *  is a field on a send). A Discord thread is a CHANNEL of its own, so a card posted in one is
   *  edited there and nowhere else; core records what this returns as the card's coordinates, so
   *  the settlement addresses the very message the ask posted. */
  cardChannel?(turn: ElicitCardTurn): string
  /** The payload of a SECONDARY surface this card's own control opens — Discord's modal, which is
   *  the only place that platform accepts a typed answer. Absent ⇒ the card is answered where it
   *  was posted, which is what Slack's and Telegram's are; null ⇒ this particular card is too
   *  (Discord's one-tap row). Opaque to core, which only hands it to the connection that asked.
   *
   *  It is rebuilt from the card's own params on every open rather than held from the post, so the
   *  dialog offers the very fields the ask reduced to (#1815) — and so a card outliving the
   *  process that posted it opens the same form. */
  editor?(handle: ElicitCardHandle, card: ElicitCardTapTarget): unknown | null
  /** Whether this typed message answers THIS card, and with what. Absent ⇒ the surface collects no
   *  typed answer and every message in its chats is a prompt, which is what a Slack card's is.
   *  Null ⇒ not this card's answer, and core keeps looking. The fields are keyed as a Confirm's
   *  are, so a typed answer is validated by the same re-derivation every other answer is. */
  claimReply?(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null
  /** The namespace a tapping actor's id is scoped to on this surface, recorded beside an approval
   *  resolver so it is globally unique. Absent where the surface's user ids already are — a
   *  Telegram user id names one account across every chat, a Slack one only within its workspace. */
  answerScope?(handle: ElicitCardHandle): string | undefined
}
