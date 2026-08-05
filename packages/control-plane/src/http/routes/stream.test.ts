import { describe, expect, it } from 'vitest'
import type { SessionViewable, ViewCtx } from '../../authorization/policy.js'
import { OrgId } from '../../domain/ids.js'
import { canStreamSession } from './stream.js'

const ORG_A = OrgId('11111111-1111-4111-8111-111111111111')
const ORG_B = OrgId('22222222-2222-4222-8222-222222222222')

function session(
  orgId: typeof ORG_A,
  overrides: Partial<SessionViewable> = {}
): SessionViewable & { orgId: typeof ORG_A } {
  return {
    orgId,
    visibility: 'org',
    ownerIdentity: null,
    ...overrides
  }
}

describe('canStreamSession', () => {
  const owner: ViewCtx = { userId: 'owner-a', role: 'owner' }
  const collaborator: ViewCtx = { userId: 'collaborator-a', role: 'collaborator' }

  it('rejects a session outside the path org even for an owner', () => {
    expect(canStreamSession(session(ORG_B), ORG_A, owner, new Set())).toBe(false)
  })

  it('applies only the Session audience inside the path org', () => {
    expect(canStreamSession(session(ORG_A), ORG_A, collaborator, new Set())).toBe(true)
    expect(
      canStreamSession(
        session(ORG_A, { visibility: 'private', ownerIdentity: 'user:session-owner' }),
        ORG_A,
        collaborator,
        new Set()
      )
    ).toBe(false)
    expect(
      canStreamSession(
        session(ORG_A, { visibility: 'private', ownerIdentity: 'user:session-owner' }),
        ORG_A,
        collaborator,
        new Set(['user:session-owner'])
      )
    ).toBe(true)
  })
})
