/** Real-Postgres coverage for an install-wide member syncing suggestions for several orgs (#968). */
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgOrganizationKnowledgeRepo } from '../../src/persistence/repositories/organization-knowledge.repo.js'
import { OrgId } from '../../src/domain/ids.js'

const DEF_ORG = OrgId(DEFAULT_ORG_ID)
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'

function suggestion(sourceAgentId: string, title: string) {
  return {
    sourceAgentId,
    dreamId: `dream-${sourceAgentId.slice(0, 8)}`,
    candidateId: randomUUID(),
    kind: 'knowledge' as const,
    operation: 'create' as const,
    title,
    digest: `sha256:${'a'.repeat(64)}`,
    contentBytes: 32,
    state: 'proposed' as const,
    sessionIds: ['session-1'],
    createdAt: '2026-08-01T00:00:00.000Z'
  }
}

describe('PgOrganizationKnowledgeRepo.syncSuggestions across organizations', () => {
  it('keeps one member’s per-org frames independent instead of replacing by daemon', async () => {
    const repo = new PgOrganizationKnowledgeRepo(prisma)
    const other = await prisma.org.create({ data: { slug: `suggestion-scope-${randomUUID().slice(0, 8)}` } })
    const otherOrg = OrgId(other.id)
    await seedDaemon(prisma, DAEMON)
    const agentA = await seedAgent(prisma, randomUUID(), { daemonId: DAEMON })
    const agentB = randomUUID()
    await prisma.agent.create({ data: { id: agentB, orgId: other.id, name: 'dreamer-b', runtime: 'claude' } })

    const first = suggestion(agentA, 'From org A')
    const second = suggestion(agentB, 'From org B')
    // The same member, one frame per org — the second must not sweep the first away.
    await repo.syncSuggestions(DEF_ORG, DAEMON, [first])
    await repo.syncSuggestions(otherOrg, DAEMON, [second])

    expect((await repo.listSuggestions(DEF_ORG)).map((row) => row.title)).toEqual(['From org A'])
    expect((await repo.listSuggestions(otherOrg)).map((row) => row.title)).toEqual(['From org B'])
    expect(await prisma.organizationSuggestion.count({ where: { sourceDaemonId: DAEMON } })).toBe(2)
  })

  it('re-syncs an org without disturbing the other org it shares a member with', async () => {
    const repo = new PgOrganizationKnowledgeRepo(prisma)
    const other = await prisma.org.create({ data: { slug: `suggestion-scope-${randomUUID().slice(0, 8)}` } })
    const otherOrg = OrgId(other.id)
    await seedDaemon(prisma, DAEMON)
    const agentA = await seedAgent(prisma, randomUUID(), { daemonId: DAEMON })
    const agentB = randomUUID()
    await prisma.agent.create({ data: { id: agentB, orgId: other.id, name: 'dreamer-b', runtime: 'claude' } })
    await repo.syncSuggestions(DEF_ORG, DAEMON, [suggestion(agentA, 'From org A')])
    await repo.syncSuggestions(otherOrg, DAEMON, [suggestion(agentB, 'From org B')])

    // An empty replay for one org is a no-op there and invisible to the other.
    await repo.syncSuggestions(otherOrg, DAEMON, [])

    expect((await repo.listSuggestions(DEF_ORG)).map((row) => row.title)).toEqual(['From org A'])
    expect((await repo.listSuggestions(otherOrg)).map((row) => row.title)).toEqual(['From org B'])
  })
})
