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
}

export interface OutOfCreditsOffer {
  /** Spent out, or never had credit: the same fixes, told differently. */
  code: 'out_of_credits' | 'never_funded'
  /** An owner gets Billing; anyone else copies its link for an owner. */
  addCredits: 'link' | 'ask-owner'
  /** Offered to an editor; the card enables it only once the org shows a machine of its own. */
  moveToOwnMachine: boolean
}

/** A `?code=` from a chat app's link; anything unrecognised reads as spent out. */
export function creditRefusalCode(raw: string | null): OutOfCreditsOffer['code'] {
  return raw === 'never_funded' ? 'never_funded' : 'out_of_credits'
}

/** The lack-of-credit tag a failure carries: an error part as is, said text only as a `⚠` failure line, so prose quoting the tag stays prose. */
export function creditRefusalOf(text: string, errorPart: boolean): OutOfCreditsOffer['code'] | null {
  if (!errorPart && !text.trimStart().startsWith('⚠')) return null
  const code = parseOrgRefusal(text)?.known
  return code === 'out_of_credits' || code === 'never_funded' ? code : null
}

export function isOutOfCreditsFailure(text: string, errorPart: boolean): boolean {
  return creditRefusalOf(text, errorPart) !== null
}

/** The card's offer for one failure, or null to render the text as it is. */
export function outOfCreditsOffer(
  step: { text: string; errorPart: boolean },
  ctx: OutOfCreditsContext
): OutOfCreditsOffer | null {
  const code = ctx.onCloud ? creditRefusalOf(step.text, step.errorPart) : null
  if (!code) return null
  return { code, addCredits: ctx.owner ? 'link' : 'ask-owner', moveToOwnMachine: ctx.canEdit }
}

/** Whether the org connected an approved machine of its own; online or not, the Edit dialog says what moving takes. */
export function hasOwnMachine(daemons: readonly Pick<DaemonRow, 'pool' | 'approval'>[]): boolean {
  return daemons.some((daemon) => !daemon.pool && (!daemon.approval || daemon.approval.status === 'approved'))
}
