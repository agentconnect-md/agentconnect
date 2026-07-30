import { describe, expect, it } from 'vitest'
import type { Shareable, ViewCtx } from '../../authorization/policy.js'
import { OrgId } from '../../domain/ids.js'
import { canStreamAgent } from './stream.js'

const ORG_A = OrgId('11111111-1111-4111-8111-111111111111')
const ORG_B = OrgId('22222222-2222-4222-8222-222222222222')

function agent(orgId: typeof ORG_A, sharing: Partial<Shareable> = {}): Shareable & { orgId: typeof ORG_A } {
  return {
    orgId,
    visibility: 'org',
    createdByUserId: null,
    ownerUserId: null,
    sharedWith: [],
    ...sharing
  }
}

describe('canStreamAgent', () => {
  const owner: ViewCtx = { userId: 'owner-a', role: 'owner' }
  const collaborator: ViewCtx = { userId: 'collaborator-a', role: 'collaborator' }

  it('rejects an agent outside the path org even for an owner', () => {
    expect(canStreamAgent(agent(ORG_B), ORG_A, owner)).toBe(false)
  })

  it('applies resource visibility inside the path org', () => {
    expect(canStreamAgent(agent(ORG_A), ORG_A, collaborator)).toBe(true)
    expect(canStreamAgent(agent(ORG_A, { visibility: 'restricted' }), ORG_A, collaborator)).toBe(false)
    expect(
      canStreamAgent(agent(ORG_A, { visibility: 'restricted', sharedWith: [collaborator.userId] }), ORG_A, collaborator)
    ).toBe(true)
  })
})
