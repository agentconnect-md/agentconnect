// What a Cloud turn that failed for lack of credit offers in place of its failure text (docs/designs/org-refusal-tag.md).
import { parseOrgRefusal } from '@agentconnect.md/protocol/org-refusal'
import type { DaemonRow } from '@/lib/data'

/** Who is looking at the failure and what the org can do about it, read once per turn. */
export interface OutOfCreditsContext {
  /** The turn's agent runs on managed Cloud, the only placement that spends credit. */
  onCloud: boolean
  /** The viewer owns the org, so adding credits is theirs to do. */
  owner: boolean
  /** The viewer can edit the agent, so its placement is theirs to change. */
  canEdit: boolean
  /** The org has an approved machine of its own the agent could move to. */
  ownMachine: boolean
}

export interface OutOfCreditsOffer {
  /** An owner gets Billing; anyone else copies its link for an owner. */
  addCredits: 'link' | 'ask-owner'
  moveToOwnMachine: boolean
}

/** A failure carrying the out-of-credits tag: an error part as is, said text only as a `⚠` failure line, so prose quoting the tag stays prose. */
export function isOutOfCreditsFailure(text: string, errorPart: boolean): boolean {
  if (!errorPart && !text.trimStart().startsWith('⚠')) return false
  return parseOrgRefusal(text)?.known === 'out_of_credits'
}

/** The card's offer for one failure, or null to render the text as it is. */
export function outOfCreditsOffer(
  step: { text: string; errorPart: boolean },
  ctx: OutOfCreditsContext
): OutOfCreditsOffer | null {
  if (!ctx.onCloud || !isOutOfCreditsFailure(step.text, step.errorPart)) return null
  return { addCredits: ctx.owner ? 'link' : 'ask-owner', moveToOwnMachine: ctx.canEdit && ctx.ownMachine }
}

/** Whether the org connected an approved machine of its own; online or not, the Edit dialog says what moving takes. */
export function hasOwnMachine(daemons: readonly Pick<DaemonRow, 'pool' | 'approval'>[]): boolean {
  return daemons.some((daemon) => !daemon.pool && (!daemon.approval || daemon.approval.status === 'approved'))
}
