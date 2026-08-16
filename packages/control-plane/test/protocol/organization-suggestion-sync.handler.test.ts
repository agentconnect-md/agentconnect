// The organization-suggestion replay a pool member sends after READY (#968). The frame is
// org-scoped by nature, and the authority for each source agent is the LIVE seam — placement plus
// the duty leases this member holds — never `agent.daemonId`, which a pool agent leaves null.
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  isFrame,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  ORGANIZATION_SUGGESTION_REVIEW_FEATURE
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { poolSetId } from '../fakes/member-set.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const OTHER = 'd2222222-2222-4222-8222-222222222222'
const AUTH_ID = '99999999-9999-4999-8999-999999999999'
const REG_ID = '88888888-8888-4888-8888-888888888888'

/** A pool agent: placed, but naming no machine. Only the ledger can say who serves it. */
async function seedPoolAgent(): Promise<string> {
  const id = randomUUID()
  await prisma.agent.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      name: `dreamer-${id.slice(0, 8)}`,
      runtime: 'claude',
      placementKind: 'set',
      setId: await poolSetId(prisma)
    }
  })
  return id
}

async function seedLease(holder: string, agentId: string, expiresAt: Date): Promise<void> {
  const groupId = randomUUID()
  await prisma.dutyGroup.create({ data: { id: groupId, orgId: DEFAULT_ORG_ID, holder, term: 1n, expiresAt } })
  await prisma.dutyGroupMember.create({ data: { kind: 'agent', refId: agentId, groupId, orgId: DEFAULT_ORG_ID } })
}

/** An install-wide (frame-mode) member advertising the organization-knowledge surface. */
async function readyMember(h: ReturnType<typeof buildWsHarness>) {
  const { stub } = h.connect()
  const saToken = await h.mintPoolMember(DAEMON)
  stub.inject('auth', { serviceAccountToken: saToken, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject(
    'register',
    {
      host: 'member-1',
      capabilities: {
        platforms: [],
        runtimes: ['claude'],
        acp: true,
        features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
      },
      maxAgents: 8,
      localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
    },
    { id: REG_ID }
  )
  await stub.expectFrame('register/ok')
  return stub
}

function suggestion(sourceAgentId: string) {
  return {
    sourceAgentId,
    dreamId: `dream-${sourceAgentId.slice(0, 8)}`,
    candidateId: randomUUID(),
    kind: 'knowledge',
    operation: 'create',
    title: 'Staged on the member that dreamt it',
    digest: `sha256:${'a'.repeat(64)}`,
    contentBytes: 24,
    state: 'proposed',
    sessionIds: ['session-1'],
    createdAt: '2026-08-01T00:00:00.000Z'
  }
}

describe('knowledge/suggestions/sync from an install-wide member', () => {
  it('records suggestions for a pool agent whose duty this member holds', async () => {
    const h = buildWsHarness(prisma)
    const agentId = await seedPoolAgent()
    await seedLease(DAEMON, agentId, new Date(h.clock.now() + 120_000))
    const stub = await readyMember(h)

    const id = stub.inject(
      'knowledge/suggestions/sync',
      { suggestions: [suggestion(agentId)] },
      { orgId: DEFAULT_ORG_ID }
    )
    const ok = await stub.expectFrame('knowledge/suggestions/sync/ok')

    expect(ok.corr).toBe(id)
    expect(stub.sent.find((f) => isFrame('error')(f))).toBeUndefined()
    // The whole point: the reply is not an empty success. The row is really there.
    expect(await prisma.organizationSuggestion.findMany({ where: { sourceAgentId: agentId } })).toMatchObject([
      { orgId: DEFAULT_ORG_ID, sourceDaemonId: DAEMON, state: 'pending' }
    ])
  })

  it('records nothing for an agent no live duty of this member covers', async () => {
    const h = buildWsHarness(prisma)
    const held = await seedPoolAgent()
    const foreign = await seedPoolAgent()
    const lapsed = await seedPoolAgent()
    await seedLease(DAEMON, held, new Date(h.clock.now() + 120_000))
    // Held by a different member, and held by this one but expired: neither is authority.
    await prisma.daemon.create({ data: { id: OTHER, orgId: null, maxAgents: 8, status: 'ready' } })
    await seedLease(OTHER, foreign, new Date(h.clock.now() + 120_000))
    await seedLease(DAEMON, lapsed, new Date(h.clock.now() - 60_000))
    const stub = await readyMember(h)

    stub.inject(
      'knowledge/suggestions/sync',
      { suggestions: [suggestion(held), suggestion(foreign), suggestion(lapsed)] },
      { orgId: DEFAULT_ORG_ID }
    )
    await stub.expectFrame('knowledge/suggestions/sync/ok')

    const rows = await prisma.organizationSuggestion.findMany({ where: { sourceDaemonId: DAEMON } })
    expect(rows.map((row) => row.sourceAgentId)).toEqual([held])
  })

  it('still records for a machine-placed agent this member is the placement of', async () => {
    const h = buildWsHarness(prisma)
    const stub = await readyMember(h)
    const agentId = randomUUID()
    await prisma.agent.create({
      data: { id: agentId, orgId: DEFAULT_ORG_ID, name: 'pinned-dreamer', runtime: 'claude', daemonId: DAEMON }
    })

    stub.inject('knowledge/suggestions/sync', { suggestions: [suggestion(agentId)] }, { orgId: DEFAULT_ORG_ID })
    await stub.expectFrame('knowledge/suggestions/sync/ok')

    expect(await prisma.organizationSuggestion.count({ where: { sourceAgentId: agentId } })).toBe(1)
  })
})
