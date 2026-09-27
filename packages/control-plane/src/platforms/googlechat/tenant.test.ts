/** A customer row's tenant ids: one customer and a set of domains (google-chat-integration.md §10.3). */
import { describe, expect, it } from 'vitest'
import {
  googleChatDomainAdditions,
  googleChatPrimaryTenant,
  googleChatTenantEntries,
  googleChatTenantKeys,
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
