// The ORDER of the balance banner, which is the whole content of that decision and had no test: `unknown` sitting ahead of low balance silently
// swallowed the one actionable line, and did it exactly when it mattered, since `unknown` is
// reported DURING a suspension decision so the balance is near its threshold by definition.
import { describe, expect, it } from 'vitest'
import { balanceBanner } from '@/lib/billing-banner'
import type { BillingAccount } from '@/lib/billing-api'

const acct = (over: Partial<BillingAccount> = {}): BillingAccount => ({
  orgId: 'org-1',
  balanceMicro: 50_000_000,
  state: 'active',
  lowBalanceMicro: 10_000_000,
  ...over
})
const funded = { hasHistory: true }

describe('balanceBanner', () => {
  it('shows nothing when funded, confirmed and above the threshold', () => {
    expect(balanceBanner(acct(), funded)).toBeNull()
  })

  it('tells a never-funded org how the model works, rather than that it is blocked', () => {
    // Same gateway state as spent-out; only the ledger tells them apart.
    const banner = balanceBanner(acct({ balanceMicro: 0, state: 'suspended' }), { hasHistory: false })
    expect(banner).toMatchObject({ tone: 'brand', icon: 'sparkles', cta: 'Add credits' })
    expect(banner?.title).toContain('start serving')
  })

  it('says traffic is paused once an org that HAS paid runs out', () => {
    const banner = balanceBanner(acct({ balanceMicro: 0, state: 'suspended' }), funded)
    expect(banner).toMatchObject({ tone: 'red', icon: 'circle-slash', cta: 'Add credits' })
  })

  it('keeps the low-balance banner even while the gateway answer is unconfirmed', () => {
    const banner = balanceBanner(acct({ balanceMicro: 4_180_000, state: 'unknown' }), funded)
    expect(banner).toMatchObject({ tone: 'amber', icon: 'triangle-alert' })
    expect(banner?.title).toBe('Low balance — $4.18 remaining')
    expect(banner?.text).toContain('$10.00')
  })

  it('falls back to the unconfirmed notice only when nothing more useful applies', () => {
    const banner = balanceBanner(acct({ state: 'unknown' }), funded)
    expect(banner).toMatchObject({ tone: 'blue', icon: 'clock' })
    // No CTA: there is nothing for the user to do about it.
    expect(banner?.cta).toBeUndefined()
  })

  it('lets suspended outrank low balance — worse news, and the same call to action', () => {
    expect(balanceBanner(acct({ balanceMicro: 1, state: 'suspended' }), funded)?.tone).toBe('red')
  })

  it('shows nothing for a service too old to report `state`', () => {
    expect(balanceBanner({ orgId: 'org-1', balanceMicro: 50_000_000 }, funded)).toBeNull()
  })

  it('treats an absent, null, zero or negative threshold as no warning', () => {
    expect(balanceBanner({ orgId: 'org-1', balanceMicro: 1, state: 'active' }, funded)).toBeNull()
    expect(balanceBanner(acct({ balanceMicro: 1, lowBalanceMicro: null }), funded)).toBeNull()
    expect(balanceBanner(acct({ balanceMicro: 1, lowBalanceMicro: 0 }), funded)).toBeNull()
    // An overspent balance under a negative threshold is the only way to reach the comparison
    // with a nonsense value, and truthiness alone would render "Running low — below -$5.00".
    // `state` has to be non-suspended to get past the branch above, which the unconfirmed
    // window supplies.
    expect(
      balanceBanner(acct({ balanceMicro: -10_000_000, lowBalanceMicro: -5_000_000, state: 'unknown' }), funded)
    ).toMatchObject({ tone: 'blue' })
  })

  it('derives no STATE banner from a null `state`, exactly as from an absent one', () => {
    // `null` is the natural serialization if the service ever models "no gateway configured"
    // explicitly. A funded balance isolates it from the low-balance rule below.
    const nulled = acct({ state: null as unknown as undefined })
    expect(balanceBanner(nulled, funded)).toBeNull()
    // …and the balance rules still apply, because they owe nothing to the gateway.
    expect(balanceBanner({ ...nulled, balanceMicro: 1 }, funded)?.tone).toBe('amber')
  })
})
