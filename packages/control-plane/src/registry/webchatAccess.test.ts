/** The re-check of an open webchat socket answers by the same two conditions that refuse a dial as revoked. */
import { describe, expect, it } from 'vitest'
import type { AgentId } from '../domain/ids.js'
import { createWebchatAccessVerifier, type WebchatVerificationDeps } from './webchatVerification.js'

const PRIMARY = '33333333-3333-4333-8333-333333333333'
const PEER = '66666666-6666-4666-8666-666666666666'
const WHO = {
  orgId: 'org-1',
  userId: 'user-1',
  agentId: PRIMARY,
  conversationId: '55555555-5555-4555-8555-555555555555'
}

type Agent = NonNullable<Awaited<ReturnType<WebchatVerificationDeps['agents']['getUnscoped']>>>
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  orgId: 'org-1',
  placementKind: 'daemon',
  setId: null,
  daemonId: null,
  visibility: 'org',
  sharedWith: [],
  ...over
})

function verifier(over: { role?: string | null; agents?: Record<string, Agent | null>; roster?: string[] } = {}) {
  const agents = over.agents ?? { [PRIMARY]: agent(PRIMARY) }
  return createWebchatAccessVerifier({
    orgs: { roleOf: async () => (over.role === undefined ? 'collaborator' : over.role) },
    agents: { getUnscoped: async (id) => agents[id] ?? null },
    conversations: {
      participants: async () =>
        (over.roster ?? [PRIMARY]).map((id, i) => ({ agentId: id as AgentId, role: i === 0 ? 'primary' : 'member' }))
    }
  })
}

const REVOKED = { ok: false, reason: 'access revoked' }

describe('createWebchatAccessVerifier', () => {
  it('lets a member who sees every agent in the conversation keep the socket', async () => {
    expect(await verifier()(WHO)).toEqual({ ok: true })
    const both = {
      [PRIMARY]: agent(PRIMARY),
      [PEER]: agent(PEER, { visibility: 'restricted', sharedWith: ['user-1'] })
    }
    expect(await verifier({ agents: both, roster: [PRIMARY, PEER] })(WHO)).toEqual({ ok: true })
  })

  it('refuses once the membership has ended', async () => {
    expect(await verifier({ role: null })(WHO)).toEqual(REVOKED)
  })

  it('refuses once the primary agent is gone, in another organization, or no longer shared with the member', async () => {
    expect(await verifier({ agents: { [PRIMARY]: null } })(WHO)).toEqual(REVOKED)
    expect(await verifier({ agents: { [PRIMARY]: agent(PRIMARY, { orgId: 'org-2' }) } })(WHO)).toEqual(REVOKED)
    const hidden = { [PRIMARY]: agent(PRIMARY, { visibility: 'restricted', sharedWith: [] }) }
    expect(await verifier({ agents: hidden })(WHO)).toEqual(REVOKED)
  })

  it('refuses once another agent in the conversation is hidden from the member, and tolerates a deleted one', async () => {
    const hidden = { [PRIMARY]: agent(PRIMARY), [PEER]: agent(PEER, { visibility: 'restricted', sharedWith: [] }) }
    expect(await verifier({ agents: hidden, roster: [PRIMARY, PEER] })(WHO)).toEqual(REVOKED)
    expect(
      await verifier({ agents: { [PRIMARY]: agent(PRIMARY), [PEER]: null }, roster: [PRIMARY, PEER] })(WHO)
    ).toEqual({
      ok: true
    })
  })
})
