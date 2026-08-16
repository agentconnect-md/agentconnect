// The four organization READS a dreaming agent issues (#999). Authority is the LIVE seam —
// placement plus the duty leases this member holds — never `agent.daemonId`, which a pool agent
// leaves null, so an install-wide member was refused every read for the agents it actually runs.
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  isFrame,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  ORGANIZATION_SUGGESTION_REVIEW_FEATURE
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import type { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { poolSetId } from '../fakes/member-set.js'

const DAEMON = 'd3333333-3333-4333-8333-333333333333'
const OTHER = 'd4444444-4444-4444-8444-444444444444'
const AUTH_ID = '99999999-9999-4999-8999-999999999999'
const REG_ID = '88888888-8888-4888-8888-888888888888'

/** A pool agent: placed, but naming no machine. Only the ledger can say who serves it. */
async function seedPoolAgent(managedSkills: string[]): Promise<string> {
  const id = randomUUID()
  await prisma.agent.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      name: `dreamer-${id.slice(0, 8)}`,
      runtime: 'claude',
      placementKind: 'set',
      setId: await poolSetId(prisma),
      managedSkills
    }
  })
  return id
}

async function seedLease(holder: string, agentId: string, expiresAt: Date): Promise<void> {
  const groupId = randomUUID()
  await prisma.dutyGroup.create({ data: { id: groupId, orgId: DEFAULT_ORG_ID, holder, term: 1n, expiresAt } })
  await prisma.dutyGroupMember.create({ data: { kind: 'agent', refId: agentId, groupId, orgId: DEFAULT_ORG_ID } })
}

async function seedKnowledge(): Promise<string> {
  const id = randomUUID()
  await prisma.organizationKnowledge.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      title: 'Pool runbook',
      revisions: {
        create: {
          revision: 1,
          content: 'drain the member before the upgrade',
          tags: ['runbook'],
          digest: `sha256:${'c'.repeat(64)}`,
          source: 'manual'
        }
      }
    }
  })
  return id
}

async function seedManagedSkill(): Promise<string> {
  const id = randomUUID()
  await prisma.managedSkill.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      name: `release-${id.slice(0, 8)}`,
      description: 'Release with rollback',
      revisions: {
        create: {
          revision: 1,
          archive: Buffer.from([1, 2, 3, 4]),
          digest: `sha256:${'d'.repeat(64)}`,
          compressedBytes: 4,
          expandedBytes: 4,
          fileCount: 1,
          manifest: {},
          source: 'manual'
        }
      }
    }
  })
  return id
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

/** The reply correlated to one request — `expectFrame` cannot tell four refusals apart. */
async function settle(stub: InMemoryDaemonStub, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const reply = stub.sent.find((f) => f.corr === id)
    if (reply) return reply
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`no reply correlated to ${id}`)
}

/** Every read a dreaming agent makes, with the reply each must produce. */
function reads(requesterAgentId: string, managedSkillId: string) {
  return [
    {
      type: 'knowledge/search' as const,
      ok: 'knowledge/search/ok',
      payload: { requesterAgentId, query: 'runbook', limit: 5, maxBytes: 4096 }
    },
    {
      type: 'knowledge/list' as const,
      ok: 'knowledge/list/ok',
      payload: { requesterAgentId, limit: 5, maxBytes: 4096 }
    },
    { type: 'skills/org' as const, ok: 'skills/org/ok', payload: { requesterAgentId, limit: 5 } },
    {
      type: 'managed-skill/read' as const,
      ok: 'managed-skill/chunk',
      payload: { requesterAgentId, managedSkillId, revision: 1, offset: 0, limit: 1024 }
    }
  ]
}

describe('organization reads from an install-wide member', () => {
  it('serves every read for a pool agent whose duty this member holds', async () => {
    const h = buildWsHarness(prisma)
    await seedKnowledge()
    const skillId = await seedManagedSkill()
    const agentId = await seedPoolAgent([skillId])
    await seedLease(DAEMON, agentId, new Date(h.clock.now() + 120_000))
    const stub = await readyMember(h)

    for (const read of reads(agentId, skillId)) {
      const reply = await settle(stub, stub.inject(read.type, read.payload, { orgId: DEFAULT_ORG_ID }))
      expect({ read: read.type, reply: reply.type }).toEqual({ read: read.type, reply: read.ok })
    }

    expect(stub.sent.find((f) => isFrame('error')(f))).toBeUndefined()
    // Not an empty success: the org's own rows came back through the requester's tenancy.
    const search = stub.lastSent('knowledge/search/ok')!.payload as { items: { title: string }[] }
    expect(search.items.map((item) => item.title)).toEqual(['Pool runbook'])
    const skills = stub.lastSent('skills/org/ok')!.payload as { items: { id: string }[] }
    expect(skills.items.map((item) => item.id)).toEqual([skillId])
  })

  it('refuses every read for a pool agent whose duty another member holds', async () => {
    const h = buildWsHarness(prisma)
    await seedKnowledge()
    const skillId = await seedManagedSkill()
    const agentId = await seedPoolAgent([skillId])
    await prisma.daemon.create({ data: { id: OTHER, orgId: null, maxAgents: 8, status: 'ready' } })
    await seedLease(OTHER, agentId, new Date(h.clock.now() + 120_000))
    const stub = await readyMember(h)

    for (const read of reads(agentId, skillId)) {
      const reply = await settle(stub, stub.inject(read.type, read.payload, { orgId: DEFAULT_ORG_ID }))
      if (!isFrame('error')(reply)) throw new Error(`expected an error frame for ${read.type}`)
      expect({ read: read.type, code: reply.payload.code }).toEqual({ read: read.type, code: 'SCOPE_DENIED' })
    }
  })

  it('still serves every read for a machine-placed agent this member is the placement of', async () => {
    const h = buildWsHarness(prisma)
    await seedKnowledge()
    const skillId = await seedManagedSkill()
    const stub = await readyMember(h)
    const agentId = randomUUID()
    await prisma.agent.create({
      data: {
        id: agentId,
        orgId: DEFAULT_ORG_ID,
        name: 'pinned-dreamer',
        runtime: 'claude',
        daemonId: DAEMON,
        managedSkills: [skillId]
      }
    })

    for (const read of reads(agentId, skillId)) {
      const reply = await settle(stub, stub.inject(read.type, read.payload, { orgId: DEFAULT_ORG_ID }))
      expect({ read: read.type, reply: reply.type }).toEqual({ read: read.type, reply: read.ok })
    }
  })
})
