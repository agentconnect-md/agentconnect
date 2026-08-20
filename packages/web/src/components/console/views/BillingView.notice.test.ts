// The order of the balance notice, which is the whole content of that decision and had no
// test: `unknown` sitting ahead of low balance silently swallowed the one actionable line,
// and did it exactly when it mattered — `unknown` is reported DURING a suspension decision,
// so by definition the balance is near its threshold.
import { describe, expect, it } from 'vitest'
import { balanceNotice } from './BillingView'
import type { BillingAccount } from '@/lib/billing-api'

const acct = (over: Partial<BillingAccount> = {}): BillingAccount => ({
  orgId: 'org-1',
  balanceMicro: 50_000_000,
  state: 'active',
  lowBalanceMicro: 10_000_000,
  ...over
})

describe('balanceNotice', () => {
  it('says nothing when funded and confirmed', () => {
    expect(balanceNotice(acct())).toBeNull()
  })

  it('shows the low-balance line even while the gateway answer is unconfirmed', () => {
    const notice = balanceNotice(acct({ balanceMicro: 2_000_000, state: 'unknown' }))
    expect(notice).toEqual({ text: 'Running low — below $10.00', tone: 'warn' })
  })

  it('falls back to confirming only when there is nothing more useful to say', () => {
    expect(balanceNotice(acct({ state: 'unknown' }))).toEqual({ text: 'Confirming access status…', tone: 'muted' })
  })

  it('lets suspended outrank both — worse news, and its copy already says what to do', () => {
    const notice = balanceNotice(acct({ balanceMicro: 0, state: 'suspended' }))
    expect(notice?.tone).toBe('error')
    expect(notice?.text).toContain('add credit')
  })

  it('says nothing at all for a service that predates `state`', () => {
    expect(balanceNotice({ orgId: 'org-1', balanceMicro: 50_000_000 })).toBeNull()
  })

  it('treats an absent or zero threshold as no warning', () => {
    expect(balanceNotice({ orgId: 'org-1', balanceMicro: 1, state: 'active' })).toBeNull()
    expect(balanceNotice(acct({ balanceMicro: 1, lowBalanceMicro: 0 }))).toBeNull()
  })
})
