import { describe, expect, it } from 'vitest'
import { BILLING_SUSPENDED_SOURCE_KEY, billingSuspensionNotifications } from '@/lib/billing-notifications'
import type { BillingAccount } from '@/lib/billing-api'

const orgPath = (path: string) => `/acme${path}`

function account(state: BillingAccount['state'], balanceMicro = 0): BillingAccount {
  return { orgId: 'org-1', balanceMicro, state }
}

describe('billingSuspensionNotifications', () => {
  it('notifies when a funded org is suspended', () => {
    const items = billingSuspensionNotifications(account('suspended'), true, orgPath)
    expect(items).toHaveLength(1)
    expect(items![0]).toMatchObject({
      category: 'billing',
      severity: 'error',
      sourceKey: BILLING_SUSPENDED_SOURCE_KEY,
      action: { label: 'Add credits', href: '/acme/billing', external: false }
    })
  })

  it('resolves once the account is active again', () => {
    expect(billingSuspensionNotifications(account('active', 5_000_000), null, orgPath)).toEqual([])
  })

  it('stays silent for a never-funded org (onboarding, not an outage)', () => {
    expect(billingSuspensionNotifications(account('suspended'), false, orgPath)).toEqual([])
  })

  it('does not sync while undecidable: no account, unknown state, or unanswered ledger', () => {
    expect(billingSuspensionNotifications(undefined, true, orgPath)).toBeNull()
    expect(billingSuspensionNotifications(account('unknown'), true, orgPath)).toBeNull()
    expect(billingSuspensionNotifications(account('suspended'), null, orgPath)).toBeNull()
  })
})
