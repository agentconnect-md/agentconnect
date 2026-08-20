// Which banner the billing page shows, if any. A pure decision over the account shape, kept out
// of the view so its test imports one function instead of a 'use client' module's whole tree.
//
// The wire does not name these states — they are derived here from the balance, the configured
// threshold and the gateway's own call. Copy and tone follow the Billing design canvas.
import { fmtMicroUsd, type BillingAccount } from '@/lib/billing-api'

/** Whether the ledger holds anything, from the transactions page as SWR hands it over.
 *  Undefined data means BOTH "in flight" and "failed", so it can only answer `null` — and
 *  this exists as a function so that answer is pinned by a test rather than living inline
 *  in a component the suite never renders. */
export function ledgerHistory(page: { items: unknown[] } | undefined): boolean | null {
  return page ? page.items.length > 0 : null
}

export type BalanceBanner = {
  tone: 'brand' | 'red' | 'amber' | 'blue'
  icon: string
  title: string
  text: string
  cta?: string
}

export function balanceBanner(
  acct: BillingAccount,
  opts: {
    /** Whether the ledger holds anything — `null` while it has not answered, or could not.
     *  A boolean cannot say that, and "has not answered" is the caller's state for the first
     *  moments of every load and permanently whenever the request fails. */
    hasHistory: boolean | null
  }
): BalanceBanner | null {
  const suspended = acct.state === 'suspended'
  // Never funded reads differently from spent out, and only the ledger can tell them apart —
  // so this needs an EXPLICIT false. Unknown history falls through to the paused copy below,
  // which is true about the gateway either way; guessing the other direction tells a customer
  // who has been paying for months that they have never paid.
  if (suspended && opts.hasHistory === false) {
    return {
      tone: 'brand',
      icon: 'sparkles',
      title: 'Add credits to start serving traffic',
      text: 'AgentConnect is prepaid: you buy credits, and usage is deducted at the provider’s actual cost. Until the balance is above zero, agents in this org won’t take sessions.',
      cta: 'Add credits'
    }
  }
  // Spent out, or history unknown.
  if (suspended) {
    return {
      tone: 'red',
      icon: 'circle-slash',
      title: 'Agent traffic is paused — balance is empty',
      text: 'LLM requests from this org are being rejected at the gateway. Adding credits resumes service within a minute.',
      cta: 'Add credits'
    }
  }
  // Ahead of the unconfirmed case: a known actionable fact outranks the absence of news, and
  // `unknown` is reported DURING a suspension decision — exactly when a balance is near its
  // threshold, which is when this line is worth the most.
  // `> 0` and not truthiness: a negative threshold is truthy and would render "below -$5.00".
  // The leading conjunct is NOT redundant with it — under `strict` this field is
  // `number | null | undefined`, and the `&&` is what narrows it before the comparison.
  if (acct.lowBalanceMicro && acct.lowBalanceMicro > 0 && acct.balanceMicro < acct.lowBalanceMicro) {
    return {
      tone: 'amber',
      icon: 'triangle-alert',
      title: `Low balance — ${fmtMicroUsd(acct.balanceMicro)} remaining`,
      text: `This balance is below the ${fmtMicroUsd(acct.lowBalanceMicro)} alert threshold. Agents keep serving until it reaches zero.`,
      cta: 'Add credits'
    }
  }
  // The design's blue slot is "we treat it as unconfirmed until we are told otherwise", which is
  // exactly this — only what is unconfirmed here is the GATEWAY's answer, not a payment, so the
  // copy says that. It clears on its own within one of the service's renewal sweeps.
  if (acct.state === 'unknown') {
    return {
      tone: 'blue',
      icon: 'clock',
      title: 'Confirming access status',
      text: 'A change to this org’s access is still unconfirmed at the gateway, so we are not claiming either way yet. This resolves on its own.'
    }
  }
  // Active, no usage yet, and a service too old to report `state` all land here.
  return null
}
