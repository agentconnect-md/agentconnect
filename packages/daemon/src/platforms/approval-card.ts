// The approval-card facet of Layer 2 (integration-plugin-architecture.md §7.3): how a chat surface offers a permission request as a card people in the conversation answer.
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import type { SubsessionNoticeOutcome } from '../slack/render.js'
import type { ElicitCardHost, ElicitCardTurn } from './elicit-card.js'

/** Who a background sub-session's card or notice says is asking, on every rewrite too (assistant-mode.md §5.6). */
export interface SubsessionAsker {
  readonly agentName: string
  readonly title: string | null
  readonly sessionUrl: string
  readonly waitHours: number
}

/** A settled sub-session notice's subject; a notice swept after a restart may have lost its session. */
export interface SubsessionNoticeView {
  readonly agentName: string
  readonly title: string | null
  readonly sessionUrl?: string
}

/** One permission request as core hands it to a surface. */
export interface ApprovalCardAsk {
  /** The unguessable id every button on the card carries back. */
  readonly requestId: string
  /** The ACP request, already secret-masked by core; the card offers its options in this order. */
  readonly params: RequestPermissionRequest
  /** The opaque target a relay-forwarded click carries back to this daemon; ignored where ingress is the daemon's own. */
  readonly sessionTarget?: string
  /** The agent and integration the card is posted through, for a surface whose relay routes a click by the target it names. */
  readonly via?: { readonly agentId: string; readonly integrationId: string }
  /** Set when a background sub-session asks: the card names and links it above the request. */
  readonly subsession?: SubsessionAsker
}

/** How a card reads once it takes no answer. */
export interface ApprovalCardSettlement {
  readonly params: RequestPermissionRequest
  readonly subsession?: SubsessionAsker
  /** What happened, with who answered where someone did: "Allow — Ada", "Cancelled". */
  readonly text: string
  /** Undefined when nothing was decided: cancelled, expired, or approving in chat turned off. */
  readonly allowed?: boolean
  /** The notification text beside the rewrite, where the platform shows one. */
  readonly fallback: string
}

/** A card whose request settled while no process could rewrite it (a restart), as its stored row recorded it. */
export interface ApprovalCardOrphan {
  readonly command: string
  readonly status: string
  readonly resolvedByName?: string | null
}

/** A conversation of the platform outside the turn, as a sub-session's card is posted to it. */
export interface ApprovalCardPlace {
  readonly channel: string
  /** The conversation's platform thread, as the session records it; absent at its top level. */
  readonly thread?: string
}

/** A posted card's coordinates: the connection that posted it, where it landed, and its message id once the post returns. */
export interface ApprovalCardHandle {
  readonly conn: unknown
  readonly channel: string
  /** The platform thread it was posted into, where a thread is not a channel of its own (Slack's). */
  readonly thread?: string
  ts?: string
}

/** A card or notice the surface built but has not sent, in its own wire shape. Opaque to core. */
export type ApprovalCardDraft = unknown

/** One chat surface's approval-card facet; absent ⇒ approvals there go to the console and the conversation gets a notice. */
export interface ApprovalCardFacet {
  /** Diagnostic label, and the namespace of a recorded answerer's id. */
  readonly platform: string
  /** The most options one card offers whole: at most the cap every surface and the console share (#1969). */
  readonly maxOptions: number
  /** The live card for the connection it will be posted on, or null when it cannot offer every option there. */
  build(ask: ApprovalCardAsk, conn?: unknown): ApprovalCardDraft | null
  /** The card once it takes no answer, its buttons gone. */
  settled(card: ApprovalCardSettlement): ApprovalCardDraft
  /** A sub-session's notice where nobody there may answer: it is waiting, and an Agent editor answers in the console. */
  notice(asker: SubsessionAsker): ApprovalCardDraft
  /** That notice once its request settled. */
  noticeSettled(view: SubsessionNoticeView, outcome: SubsessionNoticeOutcome): ApprovalCardDraft
  /** A card or notice a restart left behind, from its stored row. */
  orphaned(row: ApprovalCardOrphan): ApprovalCardDraft
  /** Where a card of this turn lands, when that is not the turn's channel (a Discord thread is a channel of its own). */
  cardChannel?(place: ApprovalCardPlace): string
  /** Post a card in the turn's own conversation, serialized on its apply chain; the message id, or undefined when refused. */
  send(host: ElicitCardHost, turn: ElicitCardTurn, draft: ApprovalCardDraft): Promise<string | undefined>
  /** Post into another conversation of this platform on a connection core resolved for it, under the turn's agent. */
  post(
    conn: unknown,
    place: ApprovalCardPlace,
    draft: ApprovalCardDraft,
    turn: ElicitCardTurn
  ): Promise<string | undefined>
  /** Rewrite a posted card or notice in place; best effort, no outcome depends on it. */
  rewrite(handle: ApprovalCardHandle, draft: ApprovalCardDraft): void
  /** Tell only `userId`, beside the card, why their click was not taken. Absent ⇒ core hands the words back to the click's own ingress, which answers the interaction privately. */
  tellPrivately?(handle: ApprovalCardHandle, userId: string, text: string): void
  /** The most characters a refusal said only to the clicker can carry here, by either path; absent ⇒ no limit core must fit. */
  readonly privateTextLimit?: number
  /** The namespace a clicker's id is scoped to; absent where the platform's user ids are already global. */
  answerScope?(handle: ApprovalCardHandle): string | undefined
  /** A clicker's display name, for a click that carried none. */
  nameOf?(handle: ApprovalCardHandle, userId: string): Promise<string | undefined>
}

/** "Agent’s task “title”", or just "Agent’s task" without a title; plain text, each surface defuses its own markup. */
export function subsessionAskerText(
  agentName: string,
  title: string | null,
  clamp: (s: string, n: number) => string
): string {
  const agent = `${clamp(agentName, 60)}’s task`
  return title?.trim() ? `${agent} “${clamp(title.trim(), 80)}”` : agent
}

/** How long a task's request waits, as its card and notice say it. */
export function subsessionWaitText(hours: number): string {
  return `If nobody answers within ${hours} hour${hours === 1 ? '' : 's'}, it is denied and the task stops.`
}

/** How a settled sub-session notice reads, in plain text with literal marks. */
export function subsessionSettledText(
  asker: string,
  outcome: SubsessionNoticeOutcome,
  name: (s: string) => string
): string {
  const by = (word: string, who: string | null): string => (who?.trim() ? ` ${word} ${name(who.trim())}` : '')
  switch (outcome.kind) {
    case 'allowed':
      return `✅ ${asker} got permission${by('from', outcome.by)}.`
    case 'denied':
      return `🚫 ${asker} was denied permission${by('by', outcome.by)}.`
    case 'expired':
      return `🚫 ${asker} got no answer within ${outcome.hours} hour${outcome.hours === 1 ? '' : 's'}, so it was denied and stopped.`
    case 'cancelled':
      return `⏳ ${asker} no longer needs permission.`
  }
}

/** A settled card's literal mark: allowed, denied, or nothing decided. */
export function approvalMark(allowed: boolean | undefined): string {
  return allowed === undefined ? '⏳' : allowed ? '✅' : '🚫'
}

/** An orphaned row's mark, by its stored status. */
export function orphanMark(status: string): string {
  return status === 'allowed' ? '✅' : status === 'denied' ? '🚫' : '⏳'
}
