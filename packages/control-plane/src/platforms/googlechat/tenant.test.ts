/** A customer row's tenant ids: one customer and a set of domains (google-chat-integration.md §10.3). */
import { describe, expect, it } from 'vitest'
import {
  googleChatDomainAdditions,
  googleChatPrimaryTenant,
  googleChatTenantEntries,
  googleChatTenantKeys,
  googleChatTenantLearning,
  googleChatTenantOf
} from './tenant.js'

describe('the tenant ids of a customer row', () => {
  it('reads the comma-joined domain set and expands every domain into a key', () => {
    const tenant = googleChatTenantOf({
      projectId: 'example-project',
      customerId: 'C0000000000',
      domainIds: '0000000000,0000000001,0000000000,not a domain'
    })
    expect(tenant).toEqual({ customerId: 'C0000000000', domainIds: ['0000000000', '0000000001'] })
    expect(googleChatTenantKeys(tenant)).toEqual(['customers/C0000000000', 'domains/0000000000', 'domains/0000000001'])
    expect(googleChatPrimaryTenant(tenant)).toBe('customers/C0000000000')
    expect(googleChatPrimaryTenant({ domainIds: ['0000000001'] })).toBe('domains/0000000001')
    expect(googleChatTenantOf({ projectId: 'example-project' })).toEqual({})
  })

  it('writes the set back as strings', () => {
    expect(googleChatTenantEntries({ customerId: 'C0000000000', domainIds: ['0000000000', '0000000001'] })).toEqual({
      customerId: 'C0000000000',
      domainIds: '0000000000,0000000001'
    })
    expect(googleChatTenantEntries({})).toEqual({})
  })

  it('appends only the domains a row does not list yet', () => {
    const current = { projectId: 'example-project', customerId: 'C0000000000', domainIds: '0000000000' }
    expect(googleChatDomainAdditions(current, ['0000000001', '0000000000', '0000000001'])).toEqual({
      domainIds: '0000000000,0000000001'
    })
    expect(googleChatDomainAdditions(current, ['0000000000'])).toEqual({})
    expect(googleChatDomainAdditions({ customerId: 'C0000000000' }, ['0000000002'])).toEqual({
      domainIds: '0000000002'
    })
  })
})

describe('what a single-tenant row records from a key its traffic named', () => {
  const current = { projectId: 'example-project', customerId: 'C0000000000', domainIds: '0000000000' }

  it('records the first customer, knows it again, and refuses a second one', () => {
    expect(googleChatTenantLearning({ projectId: 'example-project' }, 'customers/C0000000000')).toEqual({
      kind: 'record',
      entries: { customerId: 'C0000000000' }
    })
    expect(googleChatTenantLearning(current, 'customers/C0000000000')).toEqual({ kind: 'known' })
    expect(googleChatTenantLearning(current, 'customers/C0000000002')).toMatchObject({ kind: 'refused' })
  })

  it('appends a new domain, knows a listed one, and refuses anything that is not a tenant key', () => {
    expect(googleChatTenantLearning(current, 'domains/0000000001')).toEqual({
      kind: 'record',
      entries: { domainIds: '0000000000,0000000001' }
    })
    expect(googleChatTenantLearning(current, 'domains/0000000000')).toEqual({ kind: 'known' })
    expect(googleChatTenantLearning(current, 'spaces/AAA')).toMatchObject({ kind: 'refused' })
    expect(googleChatTenantLearning(current, 'customers/not a customer')).toMatchObject({ kind: 'refused' })
  })
})
