/**
 * The collaboration snapshot for a POOL agent — `channels[]` against the real query.
 *
 * `channelPlacements` carries `Agent.daemonId`, which a `set` placement leaves null, and the
 * snapshot builder used to read routability off that column. So a pool agent vanished from its own
 * channels while the resolver-backed `agents[]` listed it: `admits()` said yes, `coordsDecision`
 * said the caller is not in the channel, and every peer wake it made from an IM channel came back
 * `not_allowed` whatever its call policy said. Both halves now read one resolved answer.
 *
 * Unit coverage pins the builder (`orchestrator/collabSnapshot.test.ts`); this pins the seam that
 * actually broke — the real placement query plus the duty ledger behind it.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon } from '../fixtures/seed.js'
import { joinPool, poolSetId } from '../fakes/member-set.js'
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

/** An install-wide pool member: an org-less daemon row enrolled in the org-less set. */
async function poolMember(daemonId: string): Promise<void> {
  await seedDaemon(prisma, daemonId)
  await prisma.daemon.update({ where: { id: daemonId }, data: { orgId: null } })
  await joinPool(prisma, daemonId)
}

/** A live duty lease. CONFIRMED (reported in the member's digest) is what makes it routable; an
 *  unconfirmed grant is a lease, not a route — the PENDING state below. */
async function grantDuty(holder: string, agentId: string, confirmed = true): Promise<void> {
  const groupId = randomUUID()
  await prisma.dutyGroup.create({
    data: {
      id: groupId,
      orgId: DEFAULT_ORG_ID,
      holder,
      term: 1n,
      ...(confirmed ? { confirmedTerm: 1n, confirmedHolder: holder } : {}),
      expiresAt: new Date(Date.now() + 600_000)
    }
  })
  await prisma.dutyGroupMember.create({ data: { kind: 'agent', refId: agentId, groupId, orgId: DEFAULT_ORG_ID } })
}

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
    await poolMember(HOLDER)
    const agentId = await pooledSlackAgent()
    await grantDuty(HOLDER, agentId)

    const snap = await snapshot()
    const channel = snap.channels.find((c) => c.channelId === CHANNEL)
    // The membership the daemon's `coordsDecision` reads: absent here, the agent's own wakes
    // from this channel are refused as a non-member's.
    expect(channel?.agents.map((a) => a.agentId)).toEqual([agentId])
    expect(channel?.agents[0]).toMatchObject({ daemonId: HOLDER })
    // And the two halves agree about who serves it.
    expect(snap.agents.find((a) => a.agentId === agentId)).toMatchObject({ daemonId: HOLDER })
  })

  it('keeps a PENDING pool agent out of channels[] while the flat directory carries it', async () => {
    await poolMember(HOLDER)
    const agentId = await pooledSlackAgent()
    // Granted but not yet confirmed: the member has to receive its bundle before it serves, so
    // naming it in a channel would address a wake at a daemon that refuses it.
    await grantDuty(HOLDER, agentId, false)

    const snap = await snapshot()
    expect(snap.channels.find((c) => c.channelId === CHANNEL)).toBeUndefined()
    // channels[] carries no daemon-less entry, so the retryable `not_ready` comes from here.
    const pending = snap.agents.find((a) => a.agentId === agentId)
    expect(pending).toBeDefined()
    expect(pending).not.toHaveProperty('daemonId')
  })
})
