/** A customer row's tenant ids: one customer and a set of domains (google-chat-integration.md §10.3). */
import { describe, expect, it } from 'vitest'
import {
  googleChatPrimaryTenant,
  googleChatTenantAdditions,
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

  it('appends a newly proven domain, keeps a known customer id, and adds nothing already known', () => {
    const current = { projectId: 'example-project', customerId: 'C0000000000', domainIds: '0000000000' }
    expect(googleChatTenantAdditions(current, { domainIds: ['0000000001'] })).toEqual({
      domainIds: '0000000000,0000000001'
    })
    expect(googleChatTenantAdditions(current, { customerId: 'C0000000001', domainIds: ['0000000000'] })).toEqual({})
    expect(googleChatTenantAdditions({ domainIds: '0000000000' }, { customerId: 'C0000000000' })).toEqual({
      customerId: 'C0000000000'
    })
  })
})
