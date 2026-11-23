import { HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED, parseOrgRefusal } from '@agentconnect.md/protocol'
import { turnFailureCode, type TurnFailureCode } from '../acp/acp-host.js'

// The chat notice for a failed turn, with the out-of-credits next steps when an org refusal names that reason (org-refusal-tag.md §5).

export interface TurnFailureNoticeContext {
  /** Only a daemon whose model credentials the key server issues reads tags (§5); elsewhere a tag is plain text. */
  readsOrgRefusals: boolean
  agentName: string
  /** Console links, built only when a notice needs them. */
  links: () => { billing: string; agentPlacement: string }
}

/** Whether this turn's failure text is an org refusal for running out of credits that this daemon reads. */
export function outOfCredits(reason: string, readsOrgRefusals: boolean): boolean {
  return readsOrgRefusals && parseOrgRefusal(reason)?.known === 'out_of_credits'
}

export function turnFailureNotice(reason: string, ctx: TurnFailureNoticeContext): string {
  if (!outOfCredits(reason, ctx.readsOrgRefusals)) return `⚠️ Agent failed to respond: ${reason}`
  const { billing, agentPlacement } = ctx.links()
  return [
    `⚠️ Your organization is out of credits, so ${ctx.agentName} couldn't respond.`,
    `• Add credits: ${billing}`,
    `• Or move ${ctx.agentName} to your own machine in its settings: ${agentPlacement}`
  ].join('\n')
}

/** The hook outcome for a failed turn: an out-of-credits refusal is a quota stop by its code, whatever its sentence says. */
export function turnFailureCodeWithRefusal(err: unknown, reason: string, readsOrgRefusals: boolean): TurnFailureCode {
  return outOfCredits(reason, readsOrgRefusals) ? HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED : turnFailureCode(err)
}
