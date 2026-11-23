import { HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED, parseOrgRefusal } from '@agentconnect.md/protocol'
import { turnFailureCode, type TurnFailureCode } from '../acp/acp-host.js'

// The chat notice for a failed turn, with the out-of-credits next steps when an org refusal names that reason (org-refusal-tag.md §5).

export interface TurnFailureNoticeContext {
  /** Only a daemon whose model credentials the key server issues reads tags (§5); elsewhere a tag is plain text. */
  readsOrgRefusals: boolean
  agentName: string
  /** The console page that offers this refusal's fixes, built only when a notice needs it. */
  fixLink: (code: CreditRefusalCode) => string
}

export type CreditRefusalCode = 'out_of_credits' | 'never_funded'

/** The lack-of-credit refusal this turn's failure text names, when this daemon reads refusals. */
export function creditRefusal(reason: string, readsOrgRefusals: boolean): CreditRefusalCode | null {
  const code = readsOrgRefusals ? parseOrgRefusal(reason)?.known : null
  return code === 'out_of_credits' || code === 'never_funded' ? code : null
}

/** Whether this turn's failure is a lack-of-credit refusal this daemon reads. */
export function outOfCredits(reason: string, readsOrgRefusals: boolean): boolean {
  return creditRefusal(reason, readsOrgRefusals) !== null
}

export function turnFailureNotice(reason: string, ctx: TurnFailureNoticeContext): string {
  const code = creditRefusal(reason, ctx.readsOrgRefusals)
  if (!code) return `⚠️ Agent failed to respond: ${reason}`
  // The console page works out what this reader may do, such as whether the org has a machine to move to.
  return [
    code === 'never_funded'
      ? `⚠️ Your organization hasn't added any credits yet, so ${ctx.agentName} couldn't respond.`
      : `⚠️ Your organization is out of credits, so ${ctx.agentName} couldn't respond.`,
    `Add credits, or move ${ctx.agentName} to your own machine: ${ctx.fixLink(code)}`
  ].join('\n')
}

/** The hook outcome for a failed turn: a lack-of-credit refusal is a quota stop by its code, whatever its sentence says. */
export function turnFailureCodeWithRefusal(err: unknown, reason: string, readsOrgRefusals: boolean): TurnFailureCode {
  return outOfCredits(reason, readsOrgRefusals) ? HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED : turnFailureCode(err)
}
