/**
 * The collaboration snapshot for a POOL agent — `channels[]` against the real query.
 *
 * Why both halves must resolve placement through one answer, and what a pool agent's missing
 * channel row did to its wakes: agent-collaboration-implementation.md §"Collaboration-routing
 * snapshot". Unit coverage pins the builder (`orchestrator/collabSnapshot.test.ts`); this pins the
 * seam that actually broke — the real placement query plus the duty ledger behind it.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDutyGroup } from '../fixtures/seed.js'
import { poolSetId, seedPoolMember } from '../fakes/member-set.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgIntegrationRepo } from '../../src/persistence/repositories/integration.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { buildCollabSnapshot } from '../../src/orchestrator/collabSnapshot.js'
import { OrgId } from '../../src/domain/ids.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const HOLDER = 'c1c1c1c1-cccc-4ccc-8ccc-cccccccccc01'
const CHANNEL = 'C0POOLAGENT'

const placement = () => new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock: systemClock })

/** A pool-placed active agent reachable in one Slack channel — `daemonId` null by placement. */
async function pooledSlackAgent(): Promise<string> {
  const agentId = randomUUID()
  await prisma.agent.create({
    data: {
      id: agentId,
      orgId: DEFAULT_ORG_ID,
      name: `pooled-${agentId.slice(0, 8)}`,
      runtime: 'claude',
      status: 'active',
      placementKind: 'set',
      setId: await poolSetId(prisma)
    }
  })
  const botId = randomUUID()
  const integrationId = randomUUID()
  await prisma.bot.create({
    data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'pool-bot', botUserId: 'U0POOLBOT' }
  })
  await prisma.integration.create({
    data: {
      id: integrationId,
      orgId: DEFAULT_ORG_ID,
      agentId,
      botId,
      platform: 'slack',
      name: 'pool-bot',
      status: 'active'
    }
  })
  await prisma.integrationChannel.create({
    data: { integrationId, channelId: CHANNEL, name: 'ai-playground' }
  })
  return agentId
}

/** The snapshot exactly as both producers build it: the raw placements plus the resolved directory. */
async function snapshot(): Promise<ReturnType<typeof buildCollabSnapshot>> {
  const orgId = OrgId(DEFAULT_ORG_ID)
  const integrations = new PgIntegrationRepo(prisma)
  const agents = new PgAgentRepo(prisma)
  return buildCollabSnapshot(
    orgId,
    await integrations.channelPlacements(orgId),
    1,
    await placement().resolveDirectory(await agents.orgDirectory(orgId))
  )
}

describe('collaboration snapshot: pool placement', () => {
  it('lists a pool agent in its channel, named at the member that holds it', async () => {
    await seedPoolMember(prisma, HOLDER)
    const agentId = await pooledSlackAgent()
    await seedDutyGroup(prisma, randomUUID(), HOLDER, [agentId], { confirmed: true })

    const snap = await snapshot()
    const channel = snap.channels.find((c) => c.channelId === CHANNEL)
    // The membership the daemon's `coordsDecision` reads — absent here, its own wakes are refused.
    expect(channel?.agents.map((a) => a.agentId)).toEqual([agentId])
    expect(channel?.agents[0]).toMatchObject({ daemonId: HOLDER })
    // And the two halves agree about who serves it.
    expect(snap.agents.find((a) => a.agentId === agentId)).toMatchObject({ daemonId: HOLDER })
  })

  it('keeps a PENDING pool agent out of channels[] while the flat directory carries it', async () => {
    await seedPoolMember(prisma, HOLDER)
    const agentId = await pooledSlackAgent()
    // Granted, not yet confirmed: a lease is not a route until the member reports the hold.
    await seedDutyGroup(prisma, randomUUID(), HOLDER, [agentId])

    const snap = await snapshot()
    expect(snap.channels.find((c) => c.channelId === CHANNEL)).toBeUndefined()
    // channels[] carries no daemon-less entry, so the retryable `not_ready` comes from here.
    const pending = snap.agents.find((a) => a.agentId === agentId)
    expect(pending).toBeDefined()
    expect(pending).not.toHaveProperty('daemonId')
  })
})
