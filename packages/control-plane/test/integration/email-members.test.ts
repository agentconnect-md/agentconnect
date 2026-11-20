/** The member answer against real Postgres (email-integration.md §4 step 3): a verified sign-in email of the agent's organization that the agent's visibility admits. */
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgAgentRepo, PgIntegrationRepo } from '../../src/persistence/index.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { resolveEmailMembers } from '../../src/orchestrator/emailMembers.js'

const AT = new Date('2026-01-01T00:00:00Z')
const users = () => new PgUserRepo(prisma)
const deps = () => ({ agent: new PgAgentRepo(prisma), integration: new PgIntegrationRepo(prisma), users: users() })

/** A signed-in member of `orgId`, whose address a sign-in method verified unless `verified` is false. */
async function member(email: string, opts: { orgId?: string; verified?: boolean } = {}): Promise<string> {
  const { userId } = await users().provisionOidcUser({ oidcSubject: `sub-${randomUUID()}`, email, emailVerified: true })
  await users().addMember(opts.orgId ?? DEFAULT_ORG_ID, userId, 'collaborator')
  if (opts.verified !== false)
    await users().recordEmailEvidence(userId, { verified: [email], tenant: [], asserted: [] }, AT)
  return userId
}

/** An agent with an Email integration, or with none. */
async function agentWithEmail(
  opts: { visibility?: 'org' | 'restricted'; sharedWith?: string[]; email?: boolean } = {}
): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, {
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
    ...(opts.sharedWith ? { sharedWith: opts.sharedWith } : {})
  })
  if (opts.email === false) return agentId
  const botId = randomUUID()
  const address = `helper-${botId.slice(0, 8)}@mail.example.test`
  await prisma.bot.create({
    data: {
      id: botId,
      orgId: DEFAULT_ORG_ID,
      platform: 'email',
      name: address,
      transport: 'http',
      externalAppId: address,
      externalTenantId: '-'
    }
  })
  await prisma.integration.create({
    data: { id: randomUUID(), orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'email', name: address }
  })
  return agentId
}

const ask = (agentId: string, ...addresses: string[]) =>
  resolveEmailMembers({ agentId, addresses }, deps(), DEFAULT_ORG_ID)

describe('the member answer for an agent’s mail', () => {
  it('admits a member whose sign-in email is verified, and names their console user', async () => {
    const alice = await member('alice@corp.example.test')
    const agentId = await agentWithEmail()

    expect(await ask(agentId, 'alice@corp.example.test')).toEqual({
      members: [{ address: 'alice@corp.example.test', consoleUserId: alice }]
    })
  })

  it('refuses a member the restricted agent’s list leaves out, and admits one on it', async () => {
    const alice = await member('alice@corp.example.test')
    await member('bob@corp.example.test')
    const agentId = await agentWithEmail({ visibility: 'restricted', sharedWith: [alice] })

    expect(await ask(agentId, 'bob@corp.example.test', 'alice@corp.example.test')).toEqual({
      members: [{ address: 'alice@corp.example.test', consoleUserId: alice }]
    })
  })

  it('refuses another organization’s member, an unverified sign-in email, and an unknown address alike', async () => {
    const other = (await prisma.org.create({ data: { slug: `org-${randomUUID()}` } })).id
    await member('carol@elsewhere.example.test', { orgId: other })
    await member('dave@corp.example.test', { verified: false })
    const agentId = await agentWithEmail()

    expect(
      await ask(agentId, 'carol@elsewhere.example.test', 'dave@corp.example.test', 'nobody@corp.example.test')
    ).toEqual({ members: [] })
  })

  it('answers nobody for an agent that has no address, or that another organization asks about', async () => {
    await member('alice@corp.example.test')
    const bare = await agentWithEmail({ email: false })
    expect(await ask(bare, 'alice@corp.example.test')).toEqual({ members: [] })

    const agentId = await agentWithEmail()
    expect(
      await resolveEmailMembers({ agentId, addresses: ['alice@corp.example.test'] }, deps(), `org-${randomUUID()}`)
    ).toEqual({ members: [] })
  })
})
