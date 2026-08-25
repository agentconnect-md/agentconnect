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
    pullNumber
  })
}

function seedEligibleSession(sessionId: string): Promise<string> {
  return seedSessionMeta(prisma, sessionId, AGENT_ID, {
    daemonId: DAEMON_ID,
    phase: 'end',
    workspaceIsolation: 'session'
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
    await seedEligibleSession(earlySessionId)
    await seedEligibleSession(linkedSessionId)

    await repo.enqueue(ORG_ID, signal('delivery-early', 77), NOW, NOW)
    expect(
      await prisma.sessionPullRequest.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 77 } }
      })
    ).toMatchObject({ sessionId: null })
    await expect(repo.claimNext(randomUUID(), NOW, new Date(NOW.getTime() + 60_000))).resolves.toBeNull()
    await expect(link(repo, earlySessionId, 77)).resolves.toBe(true)
    expect(
      await prisma.sessionPullRequest.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 77 } }
      })
    ).toMatchObject({ sessionId: earlySessionId })

    await expect(link(repo, linkedSessionId, 78)).resolves.toBe(true)
    await repo.enqueue(ORG_ID, signal('delivery-linked', 78), NOW, NOW)
    expect(
      await prisma.sessionPullRequest.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 78 } }
      })
    ).toMatchObject({ sessionId: linkedSessionId })
  })

  it('leases one exact-session capture and removes it atomically with the PR binding', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    const sessionId = randomUUID()
    await seedEligibleSession(sessionId)

    await expect(repo.enqueueCapture(SessionId(sessionId), NOW)).resolves.toBe(true)
    const owner = randomUUID()
    const claimed = await repo.claimNextCapture(owner, NOW, new Date(NOW.getTime() + 60_000))
    expect(claimed).toEqual({ sessionId })
    await repo.deferCapture(claimed!, owner, new Date(NOW.getTime() + 10_000))
    await expect(repo.claimNextCapture(owner, NOW, new Date(NOW.getTime() + 60_000))).resolves.toBeNull()

    const retried = await repo.claimNextCapture(
      owner,
      new Date(NOW.getTime() + 10_000),
      new Date(NOW.getTime() + 70_000)
    )
    expect(retried).toEqual({ sessionId })
    await expect(link(repo, sessionId, 80)).resolves.toBe(true)
    await expect(prisma.sessionPullRequestCapture.findUnique({ where: { sessionId } })).resolves.toBeNull()
  })

  it('coalesces each PR and preserves a concurrent newer wake', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    const sessionId = randomUUID()
    await seedEligibleSession(sessionId)
    await expect(link(repo, sessionId, 77)).resolves.toBe(true)

    await repo.enqueue(ORG_ID, signal('delivery-1', 77), NOW, NOW)
    const owner = randomUUID()
    const claimed = await repo.claimNext(owner, NOW, new Date(NOW.getTime() + 60_000))
    expect(claimed).toMatchObject({ deliveryKey: 'delivery-1' })

    await repo.enqueue(
      ORG_ID,
      signal('delivery-2', 77),
      new Date(NOW.getTime() + 1_000),
      new Date(NOW.getTime() + 10_000)
    )
    await repo.complete(claimed!, owner)
    await repo.enqueue(
      ORG_ID,
      signal('delivery-2', 77),
      new Date(NOW.getTime() + 2_000),
      new Date(NOW.getTime() + 20_000)
    )

    expect(
      await prisma.sessionPullRequest.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 77 } }
      })
    ).toMatchObject({
      deliveryKey: 'delivery-2',
      claimOwner: null,
      signalAt: new Date(NOW.getTime() + 1_000),
      nextAttemptAt: new Date(NOW.getTime() + 10_000)
    })

    const newer = await repo.claimNext(owner, new Date(NOW.getTime() + 10_000), new Date(NOW.getTime() + 70_000))
    await repo.complete(newer!, owner)
    expect(
      await prisma.sessionPullRequest.findUnique({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 77 } }
      })
    ).toMatchObject({ sessionId, deliveryKey: null, nextAttemptAt: null })
  })

  it('defers one unavailable PR without blocking the next due PR', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    const firstSessionId = randomUUID()
    const secondSessionId = randomUUID()
    await seedEligibleSession(firstSessionId)
    await seedEligibleSession(secondSessionId)
    await expect(link(repo, firstSessionId, 77)).resolves.toBe(true)
    await expect(link(repo, secondSessionId, 78)).resolves.toBe(true)
    await repo.enqueue(ORG_ID, signal('delivery-1', 77), NOW, NOW)
    await repo.enqueue(ORG_ID, signal('delivery-2', 78), NOW, NOW)

    const owner = randomUUID()
    const first = await repo.claimNext(owner, NOW, new Date(NOW.getTime() + 60_000))
    expect(first?.pullNumber).toBe(77)
    await repo.defer(first!, owner, new Date(NOW.getTime() + 10_000))

    const second = await repo.claimNext(owner, NOW, new Date(NOW.getTime() + 60_000))
    expect(second?.pullNumber).toBe(78)
  })

  it('expires an unmatched wake by latest signal age', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    await repo.enqueue(ORG_ID, signal('delivery-1', 79), NOW, NOW)

    const freshSignalAt = new Date(NOW.getTime() + 2_000)
    await repo.enqueue(ORG_ID, signal('delivery-2', 79), freshSignalAt, new Date(freshSignalAt.getTime() + 10_000))
    await expect(repo.deleteExpired(new Date(NOW.getTime() + 1))).resolves.toBe(0)
    expect(
      await prisma.sessionPullRequest.findUniqueOrThrow({
        where: { orgId_repoId_pullNumber: { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 79 } }
      })
    ).toMatchObject({ deliveryKey: 'delivery-2', signalAt: freshSignalAt })

    await expect(repo.deleteExpired(new Date(freshSignalAt.getTime() + 1))).resolves.toBe(1)
    await expect(prisma.sessionPullRequest.count()).resolves.toBe(0)
  })
})
