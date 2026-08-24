import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PullRequestFeedbackSignal } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, OrgId, SessionId } from '../../src/domain/ids.js'
import { PgSessionPullRequestFeedbackRepo } from '../../src/persistence/repositories/session-pull-request-feedback.repo.js'

const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const ORG_ID = OrgId(DEFAULT_ORG_ID)
const INSTALLATION_ID = 123n
const REPO_ID = 456n
const NOW = new Date('2026-08-24T00:00:00.000Z')

function signal(deliveryKey: string, pullNumber: number): PullRequestFeedbackSignal {
  return {
    deliveryKey,
    installationId: INSTALLATION_ID.toString(),
    repoId: REPO_ID.toString(),
    repoFullName: 'acme/infra',
    pullNumber
  }
}

function link(repo: PgSessionPullRequestFeedbackRepo, sessionId: string, pullNumber: number): Promise<boolean> {
  return repo.linkSession({
    sessionId: SessionId(sessionId),
    agentId: AgentId(AGENT_ID),
    orgId: ORG_ID,
    repoId: REPO_ID,
    repoFullName: 'acme/infra',
    installationId: INSTALLATION_ID,
    pullNumber,
    at: NOW
  })
}

describe('PgSessionPullRequestFeedbackRepo', () => {
  beforeEach(async () => {
    await seedDaemon(prisma, DAEMON_ID)
    await seedAgent(prisma, AGENT_ID, { daemonId: DAEMON_ID })
  })

  it('converges both wake-before-link and link-before-wake orders', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    const earlySessionId = randomUUID()
    const linkedSessionId = randomUUID()
    await seedSessionMeta(prisma, earlySessionId, AGENT_ID, { daemonId: DAEMON_ID })
    await seedSessionMeta(prisma, linkedSessionId, AGENT_ID, { daemonId: DAEMON_ID })

    await repo.enqueue(ORG_ID, signal('delivery-early', 77), NOW, NOW)
    expect(
      await prisma.sessionPullRequestWake.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 77 } }
      })
    ).toMatchObject({ sessionId: null })
    await expect(link(repo, earlySessionId, 77)).resolves.toBe(true)
    expect(
      await prisma.sessionPullRequestWake.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 77 } }
      })
    ).toMatchObject({ sessionId: earlySessionId })

    await expect(link(repo, linkedSessionId, 78)).resolves.toBe(true)
    await repo.enqueue(ORG_ID, signal('delivery-linked', 78), NOW, NOW)
    expect(
      await prisma.sessionPullRequestWake.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 78 } }
      })
    ).toMatchObject({ sessionId: linkedSessionId })
  })

  it('coalesces each PR into one dirty generation and preserves a concurrent newer wake', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    const sessionId = randomUUID()
    await seedSessionMeta(prisma, sessionId, AGENT_ID, { daemonId: DAEMON_ID })
    await expect(link(repo, sessionId, 77)).resolves.toBe(true)

    await repo.enqueue(ORG_ID, signal('delivery-1', 77), NOW, NOW)
    const owner = randomUUID()
    const claimed = await repo.claimNext(owner, NOW, new Date(NOW.getTime() + 60_000))
    expect(claimed).toMatchObject({ deliveryKey: 'delivery-1', generation: 1 })

    await repo.enqueue(ORG_ID, signal('delivery-2', 77), NOW, new Date(NOW.getTime() + 10_000))
    await repo.markDelivered(claimed!.id, claimed!.generation, owner, NOW)
    await repo.enqueue(ORG_ID, signal('delivery-2', 77), NOW, new Date(NOW.getTime() + 20_000))

    expect(
      await prisma.sessionPullRequestWake.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 77 } }
      })
    ).toMatchObject({
      latestDeliveryKey: 'delivery-2',
      generation: 2,
      deliveredAt: null,
      claimOwner: null,
      nextAttemptAt: new Date(NOW.getTime() + 10_000)
    })
  })

  it('defers one unavailable PR without blocking the next due PR', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    const firstSessionId = randomUUID()
    const secondSessionId = randomUUID()
    await seedSessionMeta(prisma, firstSessionId, AGENT_ID, { daemonId: DAEMON_ID })
    await seedSessionMeta(prisma, secondSessionId, AGENT_ID, { daemonId: DAEMON_ID })
    await expect(link(repo, firstSessionId, 77)).resolves.toBe(true)
    await expect(link(repo, secondSessionId, 78)).resolves.toBe(true)
    await repo.enqueue(ORG_ID, signal('delivery-1', 77), NOW, NOW)
    await repo.enqueue(ORG_ID, signal('delivery-2', 78), NOW, NOW)

    const owner = randomUUID()
    const first = await repo.claimNext(owner, NOW, new Date(NOW.getTime() + 60_000))
    expect(first?.pullNumber).toBe(77)
    await repo.defer(first!.id, first!.generation, owner, new Date(NOW.getTime() + 10_000))

    const second = await repo.claimNext(owner, NOW, new Date(NOW.getTime() + 60_000))
    expect(second?.pullNumber).toBe(78)
  })

  it('expires an unmatched wake by signal age even after a retry updates the row', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    await repo.enqueue(ORG_ID, signal('delivery-unmatched', 79), NOW, NOW)
    const owner = randomUUID()
    const claimed = await repo.claimNext(owner, NOW, new Date(NOW.getTime() + 60_000))
    await repo.defer(claimed!.id, claimed!.generation, owner, new Date(NOW.getTime() + 60_000))

    await expect(repo.deleteExpired(new Date(NOW.getTime() + 1), new Date(0))).resolves.toBe(1)
    await expect(prisma.sessionPullRequestWake.count()).resolves.toBe(0)
  })
})
