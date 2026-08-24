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

function signal(deliveryKey: string, pullNumber: number, kind: PullRequestFeedbackSignal['kind'] = 'comment') {
  return {
    deliveryKey,
    installationId: INSTALLATION_ID.toString(),
    repoId: REPO_ID.toString(),
    repoFullName: 'acme/infra',
    pullNumber,
    event: kind === 'ci_failure' ? ('check_suite:completed' as const) : ('issue_comment:created' as const),
    kind,
    ...(kind === 'ci_failure' ? { detail: 'failure' } : {}),
    observedAt: new Date().toISOString()
  } satisfies PullRequestFeedbackSignal
}

describe('PgSessionPullRequestFeedbackRepo', () => {
  beforeEach(async () => {
    await seedDaemon(prisma, DAEMON_ID)
    await seedAgent(prisma, AGENT_ID, { daemonId: DAEMON_ID })
  })

  it('converges both enqueue/link orders and leases one session batch', async () => {
    const repo = new PgSessionPullRequestFeedbackRepo(prisma)
    const earlySessionId = randomUUID()
    const linkedSessionId = randomUUID()
    await seedSessionMeta(prisma, earlySessionId, AGENT_ID, { daemonId: DAEMON_ID })
    await seedSessionMeta(prisma, linkedSessionId, AGENT_ID, { daemonId: DAEMON_ID })

    await repo.enqueue(ORG_ID, signal('delivery-early', 77))
    expect(
      await prisma.sessionPullRequestFeedback.findUnique({ where: { deliveryKey: 'delivery-early' } })
    ).toMatchObject({ sessionId: null })
    await expect(
      repo.linkSession({
        sessionId: SessionId(earlySessionId),
        agentId: AgentId(AGENT_ID),
        orgId: ORG_ID,
        repoId: REPO_ID,
        repoFullName: 'acme/infra',
        installationId: INSTALLATION_ID,
        pullNumber: 77,
        at: new Date()
      })
    ).resolves.toBe(true)
    expect(
      await prisma.sessionPullRequestFeedback.findUnique({ where: { deliveryKey: 'delivery-early' } })
    ).toMatchObject({ sessionId: earlySessionId })

    await expect(
      repo.linkSession({
        sessionId: SessionId(linkedSessionId),
        agentId: AgentId(AGENT_ID),
        orgId: ORG_ID,
        repoId: REPO_ID,
        repoFullName: 'acme/infra',
        installationId: INSTALLATION_ID,
        pullNumber: 78,
        at: new Date()
      })
    ).resolves.toBe(true)
    await repo.enqueue(ORG_ID, signal('delivery-linked', 78))
    expect(
      await prisma.sessionPullRequestFeedback.findUnique({ where: { deliveryKey: 'delivery-linked' } })
    ).toMatchObject({ sessionId: linkedSessionId })

    await repo.enqueue(ORG_ID, signal('delivery-ci', 77, 'ci_failure'))
    const now = new Date()
    const owner = randomUUID()
    const batch = await repo.claimPendingBatch(
      owner,
      now,
      new Date(now.getTime() + 60_000),
      new Date(now.getTime() + 60_000)
    )
    expect(batch.map((row) => row.deliveryKey).sort()).toEqual(['delivery-ci', 'delivery-early'])
    await repo.markDelivered(
      batch.map((row) => row.id),
      owner,
      now
    )
    expect(
      await prisma.sessionPullRequestFeedback.count({
        where: { sessionId: earlySessionId, deliveredAt: { not: null } }
      })
    ).toBe(2)
  })
})
