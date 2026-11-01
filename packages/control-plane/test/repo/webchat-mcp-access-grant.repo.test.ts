import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgWebchatMcpAccessGrantRepo } from '../../src/persistence/repositories/webchat-mcp-access-grant.repo.js'
import { PgWebchatMcpDelegationRepo } from '../../src/persistence/repositories/webchat-mcp-delegation.repo.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'

const CONVERSATION = 'c3333333-3333-4333-8333-333333333333'
const AGENT = 'a3333333-3333-4333-8333-333333333333'
const DAEMON = 'd3333333-3333-4333-8333-333333333333'
const DESCRIPTOR = 'f3333333-3333-5333-8333-333333333333'
const NOW = new Date('2026-07-30T00:00:00.000Z')
const MINUTE = 60_000

const at = (milliseconds: number): Date => new Date(NOW.getTime() + milliseconds)

async function activeGrant(tokenHash = 'hash-1', expiresAt = at(30 * MINUTE)) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await prisma.webchatConversation.create({
    data: { id: CONVERSATION, orgId: DEFAULT_ORG_ID, agentId: AGENT, userId: DEFAULT_OWNER_ID }
  })
  const authority = await new PgWebchatMcpDelegationRepo(prisma).establish({
    conversationId: CONVERSATION,
    userId: DEFAULT_OWNER_ID,
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(AGENT),
    expectedPlacement: { placementKind: 'daemon', daemonId: DAEMON, setId: null },
    now: NOW,
    expiresAt: at(12 * 60 * MINUTE)
  })
  if (!authority) throw new Error('expected an authority')
  const grants = new PgWebchatMcpAccessGrantRepo(prisma)
  const fence = {
    authorityId: authority.id,
    authorityGeneration: authority.generation,
    conversationId: CONVERSATION,
    descriptorInstanceId: DESCRIPTOR
  }
  const issued = await grants.issue({ ...fence, tokenHash, now: NOW, pendingExpiresAt: at(2 * MINUTE), expiresAt })
  if (!issued) throw new Error('expected a grant')
  const accept = { ...fence, grantId: issued.id, grantRevision: issued.grantRevision }
  expect(await grants.accept({ ...accept, now: NOW })).toMatchObject({ status: 'active' })
  return { grants, fence, accept }
}

describe('PgWebchatMcpAccessGrantRepo.renew (real Postgres)', () => {
  it('slides an active grant’s expiry without changing its token or revision', async () => {
    const { grants, accept } = await activeGrant()

    const renewed = await grants.renew({ ...accept, now: at(26 * MINUTE), expiresAt: at(56 * MINUTE) })

    expect(renewed).toMatchObject({
      id: accept.grantId,
      grantRevision: accept.grantRevision,
      tokenHash: 'hash-1',
      status: 'active',
      expiresAt: at(56 * MINUTE)
    })
  })

  it('never moves an expiry earlier', async () => {
    const { grants, accept } = await activeGrant()

    const renewed = await grants.renew({ ...accept, now: at(MINUTE), expiresAt: at(10 * MINUTE) })

    expect(renewed?.expiresAt).toEqual(at(30 * MINUTE))
  })

  it('never revives an expired grant', async () => {
    const { grants, accept } = await activeGrant()

    expect(await grants.renew({ ...accept, now: at(30 * MINUTE), expiresAt: at(60 * MINUTE) })).toBeNull()
    expect((await grants.getByTokenHash('hash-1'))?.expiresAt).toEqual(at(30 * MINUTE))
  })

  it('refuses a rotated-out grant and one its authority’s revocation reached', async () => {
    const { grants, fence, accept } = await activeGrant()
    const next = await grants.issue({
      ...fence,
      tokenHash: 'hash-2',
      now: at(MINUTE),
      pendingExpiresAt: at(3 * MINUTE),
      expiresAt: at(31 * MINUTE)
    })
    if (!next) throw new Error('expected a grant')
    const nextAccept = { ...fence, grantId: next.id, grantRevision: next.grantRevision }
    await grants.accept({ ...nextAccept, now: at(MINUTE) })

    expect(await grants.renew({ ...accept, now: at(2 * MINUTE), expiresAt: at(32 * MINUTE) })).toBeNull()

    await grants.revokeAuthority({ ...fence, now: at(2 * MINUTE), reason: 'session_closed' })
    expect(await grants.renew({ ...nextAccept, now: at(3 * MINUTE), expiresAt: at(33 * MINUTE) })).toBeNull()
  })
})
