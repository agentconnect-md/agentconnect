import { Prisma, type SessionPullRequest } from '../../generated/prisma/client.js'
import { AgentId, OrgId, SessionId } from '../../domain/ids.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type { PullRequestCaptureRecord, PullRequestWakeRecord, SessionPullRequestFeedbackRepo } from '../ports.js'

function toRecord(row: SessionPullRequest): PullRequestWakeRecord {
  if (!row.deliveryKey) throw new Error('claimed pull request has no delivery key')
  if (!row.sessionId) throw new Error('claimed pull request has no session owner')
  return {
    deliveryKey: row.deliveryKey,
    orgId: OrgId(row.orgId),
    installationId: row.installationId,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    sessionId: SessionId(row.sessionId)
  }
}

function identity(item: Pick<PullRequestWakeRecord, 'orgId' | 'repoId' | 'pullNumber'>) {
  return { orgId: item.orgId, repoId: item.repoId, pullNumber: item.pullNumber }
}

export class PgSessionPullRequestFeedbackRepo implements SessionPullRequestFeedbackRepo {
  constructor(private readonly db: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withAmbientTx(this.db, fn)
  }

  async hasSession(sessionId: SessionId): Promise<boolean> {
    return (await this.db.sessionPullRequest.findUnique({ where: { sessionId }, select: { sessionId: true } })) !== null
  }

  async enqueueCapture(sessionId: SessionId, nextAttemptAt: Date): Promise<boolean> {
    return this.transaction(async (tx) => {
      const session = await tx.sessionMeta.findUnique({
        where: { id: sessionId },
        select: { phase: true, workspaceIsolation: true, contentPurgedAt: true }
      })
      if (
        !session ||
        (session.phase !== 'end' && session.phase !== 'problem') ||
        session.workspaceIsolation !== 'session' ||
        session.contentPurgedAt
      )
        return false
      if (await tx.sessionPullRequest.findUnique({ where: { sessionId }, select: { sessionId: true } })) return false
      await tx.sessionPullRequestCapture.upsert({
        where: { sessionId },
        create: { sessionId, nextAttemptAt },
        update: {}
      })
      return true
    })
  }

  async claimNextCapture(owner: string, now: Date, until: Date): Promise<PullRequestCaptureRecord | null> {
    const candidates = await this.db.sessionPullRequestCapture.findMany({
      where: { nextAttemptAt: { lte: now }, OR: [{ claimUntil: null }, { claimUntil: { lt: now } }] },
      orderBy: [{ nextAttemptAt: 'asc' }, { sessionId: 'asc' }],
      take: 20
    })
    for (const candidate of candidates) {
      const claimed = await this.db.sessionPullRequestCapture.updateMany({
        where: {
          sessionId: candidate.sessionId,
          nextAttemptAt: { lte: now },
          OR: [{ claimUntil: null }, { claimUntil: { lt: now } }]
        },
        data: { claimOwner: owner, claimUntil: until }
      })
      if (claimed.count === 1) return { sessionId: SessionId(candidate.sessionId) }
    }
    return null
  }

  async completeCapture(item: PullRequestCaptureRecord, owner: string): Promise<void> {
    await this.db.sessionPullRequestCapture.deleteMany({
      where: { sessionId: item.sessionId, claimOwner: owner }
    })
  }

  async deferCapture(item: PullRequestCaptureRecord, owner: string, nextAttemptAt: Date): Promise<void> {
    await this.db.sessionPullRequestCapture.updateMany({
      where: { sessionId: item.sessionId, claimOwner: owner },
      data: { nextAttemptAt, claimOwner: null, claimUntil: null }
    })
  }

  async linkSession(input: {
    sessionId: SessionId
    agentId: AgentId
    orgId: OrgId
    repoId: bigint
    repoFullName: string
    installationId: bigint
    pullNumber: number
  }): Promise<boolean> {
    try {
      return await this.transaction(async (tx) => {
        const session = await tx.sessionMeta.findUnique({
          where: { id: input.sessionId },
          select: { agentId: true, orgId: true, phase: true, workspaceIsolation: true, contentPurgedAt: true }
        })
        if (
          !session ||
          session.agentId !== input.agentId ||
          session.orgId !== input.orgId ||
          (session.phase !== 'end' && session.phase !== 'problem') ||
          session.workspaceIsolation !== 'session' ||
          session.contentPurgedAt
        ) {
          return false
        }

        const key = { orgId: input.orgId, repoId: input.repoId, pullNumber: input.pullNumber }
        await tx.sessionPullRequest.upsert({
          where: { orgId_repoId_pullNumber: key },
          create: { ...key, installationId: input.installationId, repoFullName: input.repoFullName },
          update: { installationId: input.installationId, repoFullName: input.repoFullName }
        })
        const linked = await tx.sessionPullRequest.updateMany({
          where: { ...key, OR: [{ sessionId: null }, { sessionId: input.sessionId }] },
          data: { sessionId: input.sessionId, claimOwner: null, claimUntil: null }
        })
        if (linked.count === 1) {
          await tx.sessionPullRequestCapture.deleteMany({ where: { sessionId: input.sessionId } })
        }
        return linked.count === 1
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false
      throw err
    }
  }

  async enqueue(
    orgId: OrgId,
    signal: Parameters<SessionPullRequestFeedbackRepo['enqueue']>[1],
    signalAt: Date,
    nextAttemptAt: Date
  ): Promise<void> {
    const key = { orgId, repoId: BigInt(signal.repoId), pullNumber: signal.pullNumber }
    const installationId = BigInt(signal.installationId)
    await this.transaction(async (tx) => {
      const row = await tx.sessionPullRequest.upsert({
        where: { orgId_repoId_pullNumber: key },
        create: {
          ...key,
          installationId,
          repoFullName: signal.repoFullName,
          deliveryKey: signal.deliveryKey,
          signalAt,
          nextAttemptAt
        },
        update: {}
      })
      if (row.deliveryKey === signal.deliveryKey) return
      await tx.sessionPullRequest.updateMany({
        where: { ...key, OR: [{ deliveryKey: null }, { deliveryKey: { not: signal.deliveryKey } }] },
        data: {
          installationId,
          repoFullName: signal.repoFullName,
          deliveryKey: signal.deliveryKey,
          signalAt,
          nextAttemptAt
        }
      })
    })
  }

  async claimNext(owner: string, now: Date, until: Date): Promise<PullRequestWakeRecord | null> {
    const candidates = await this.db.sessionPullRequest.findMany({
      where: {
        sessionId: { not: null },
        deliveryKey: { not: null },
        nextAttemptAt: { lte: now },
        OR: [{ claimUntil: null }, { claimUntil: { lt: now } }]
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { signalAt: 'asc' }, { repoId: 'asc' }, { pullNumber: 'asc' }],
      take: 20
    })
    for (const candidate of candidates) {
      if (!candidate.deliveryKey) continue
      const claimed = await this.db.sessionPullRequest.updateMany({
        where: {
          orgId: candidate.orgId,
          repoId: candidate.repoId,
          pullNumber: candidate.pullNumber,
          sessionId: { not: null },
          deliveryKey: candidate.deliveryKey,
          nextAttemptAt: { lte: now },
          OR: [{ claimUntil: null }, { claimUntil: { lt: now } }]
        },
        data: { claimOwner: owner, claimUntil: until }
      })
      if (claimed.count === 1) return toRecord(candidate)
    }
    return null
  }

  async complete(item: PullRequestWakeRecord, owner: string): Promise<void> {
    const key = identity(item)
    const completed = await this.db.sessionPullRequest.updateMany({
      where: { ...key, deliveryKey: item.deliveryKey, claimOwner: owner },
      data: { deliveryKey: null, nextAttemptAt: null, claimOwner: null, claimUntil: null }
    })
    if (completed.count === 0) {
      await this.db.sessionPullRequest.updateMany({
        where: { ...key, claimOwner: owner },
        data: { claimOwner: null, claimUntil: null }
      })
    }
  }

  async defer(item: PullRequestWakeRecord, owner: string, nextAttemptAt: Date): Promise<void> {
    const key = identity(item)
    const deferred = await this.db.sessionPullRequest.updateMany({
      where: { ...key, deliveryKey: item.deliveryKey, claimOwner: owner },
      data: { nextAttemptAt, claimOwner: null, claimUntil: null }
    })
    if (deferred.count === 0) {
      await this.db.sessionPullRequest.updateMany({
        where: { ...key, claimOwner: owner },
        data: { claimOwner: null, claimUntil: null }
      })
    }
  }

  async deleteExpired(unmatchedBefore: Date): Promise<number> {
    const deleted = await this.db.sessionPullRequest.deleteMany({
      where: { sessionId: null, signalAt: { lt: unmatchedBefore } }
    })
    return deleted.count
  }
}
