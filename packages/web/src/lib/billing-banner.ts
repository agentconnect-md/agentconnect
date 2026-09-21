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

/** The banner's copy as message keys under `Billing.banners`, not English text — the
 *  caller resolves them through `t`, so this decision stays testable without one. */
export type BalanceBanner = {
  tone: 'brand' | 'red' | 'amber' | 'blue'
  icon: string
  titleKey: string
  titleValues?: Record<string, unknown>
  textKey: string
  textValues?: Record<string, unknown>
  ctaKey?: string
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
      titleKey: 'neverFundedTitle',
      textKey: 'neverFundedText',
      ctaKey: 'addCredits'
    }
  }
  // Spent out, or history unknown.
  if (suspended) {
    return {
      tone: 'red',
      icon: 'circle-slash',
      titleKey: 'spentOutTitle',
      textKey: 'spentOutText',
      ctaKey: 'addCredits'
    }
  }
  // Hoisted to a plain number so nothing below needs narrowing, and `> 0` covers absent, null,
  // zero and the nonsense negative in one comparison.
  const threshold = acct.lowBalanceMicro ?? 0
  // Ahead of the unconfirmed case: a known actionable fact outranks the absence of news, and
  // `unknown` is reported DURING a suspension decision — exactly when a balance is near its
  // threshold, which is when this line is worth the most.
  if (threshold > 0 && acct.balanceMicro < threshold) {
    return {
      tone: 'amber',
      icon: 'triangle-alert',
      titleKey: 'lowBalanceTitle',
      titleValues: { balance: fmtMicroUsd(acct.balanceMicro) },
      textKey: 'lowBalanceText',
      textValues: { threshold: fmtMicroUsd(threshold) },
      ctaKey: 'addCredits'
    }
  }
  // The design's blue slot is "we treat it as unconfirmed until we are told otherwise", which is
  // exactly this — only what is unconfirmed here is the GATEWAY's answer, not a payment, so the
  // copy says that. It clears on its own within one of the service's renewal sweeps.
  if (acct.state === 'unknown') {
    return {
      tone: 'blue',
      icon: 'clock',
      titleKey: 'unconfirmedTitle',
      textKey: 'unconfirmedText'
    }
  }
  // Active, no usage yet, and a service too old to report `state` all land here.
  return null
}
