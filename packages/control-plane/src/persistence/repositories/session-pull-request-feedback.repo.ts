import { Prisma, type SessionPullRequest } from '../../generated/prisma/client.js'
import type { CodeHostProvider } from '@agentconnect.md/protocol'
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
    provider: row.provider as CodeHostProvider,
    bindingId: row.bindingId,
    ...(row.host ? { host: row.host } : {}),
    ...(row.headSha ? { headSha: row.headSha } : {}),
    ...(row.sourceAgentId ? { sourceAgentId: row.sourceAgentId } : {}),
    ...(row.sourceSessionId ? { sourceSessionId: row.sourceSessionId } : {}),
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    sessionId: SessionId(row.sessionId)
  }
}

function identity(item: Pick<PullRequestWakeRecord, 'orgId' | 'repoId' | 'pullNumber' | 'provider' | 'bindingId'>) {
  return {
    orgId: item.orgId,
    provider: item.provider ?? 'github',
    bindingId: item.bindingId ?? '',
    repoId: item.repoId,
    pullNumber: item.pullNumber
  }
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
      // Latest turn first: that workspace is the likeliest still awake, and rows failing for hours must not delay it.
      orderBy: [{ session: { lastActivityAt: 'desc' } }, { sessionId: 'asc' }],
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

  async linkSession(input: Parameters<SessionPullRequestFeedbackRepo['linkSession']>[0]): Promise<boolean> {
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

        const key = identity(input)
        await tx.sessionPullRequest.upsert({
          where: { orgId_provider_bindingId_repoId_pullNumber: key },
          create: { ...key, installationId: input.installationId, repoFullName: input.repoFullName, host: input.host },
          update: { installationId: input.installationId, repoFullName: input.repoFullName, host: input.host }
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
    const key = identity({ ...signal, orgId, repoId: BigInt(signal.repoId) })
    const installationId = signal.installationId ? BigInt(signal.installationId) : null
    await this.transaction(async (tx) => {
      // Preserve receipts written before provider-scoped, multi-PR delivery keys.
      if (
        await tx.sessionPullRequestDelivery.findFirst({
          where: {
            orgId,
            provider: key.provider,
            bindingId: key.bindingId,
            repoId: 0n,
            pullNumber: 0,
            deliveryKey: signal.deliveryKey
          }
        })
      )
        return
      const received = await tx.sessionPullRequestDelivery.createMany({
        data: [{ ...key, deliveryKey: signal.deliveryKey, receivedAt: signalAt }],
        skipDuplicates: true
      })
      if (received.count === 0) return
      const row = await tx.sessionPullRequest.upsert({
        where: { orgId_provider_bindingId_repoId_pullNumber: key },
        create: {
          ...key,
          installationId,
          repoFullName: signal.repoFullName,
          host: signal.host,
          headSha: signal.headSha ?? null,
          sourceAgentId: signal.sourceAgentId ?? null,
          sourceSessionId: signal.sourceSessionId ?? null,
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
          host: signal.host,
          headSha: signal.headSha ?? null,
          sourceAgentId: signal.sourceAgentId ?? null,
          sourceSessionId: signal.sourceSessionId ?? null,
          deliveryKey: signal.deliveryKey,
          signalAt,
          nextAttemptAt
        }
      })
    })
  }

  async owner(
    orgId: OrgId,
    provider: CodeHostProvider,
    bindingId: string,
    repoId: bigint,
    pullNumber: number
  ): Promise<{ agentId: AgentId; sessionId: SessionId } | null> {
    const row = await this.db.sessionPullRequest.findUnique({
      where: { orgId_provider_bindingId_repoId_pullNumber: { orgId, provider, bindingId, repoId, pullNumber } },
      select: { session: { select: { id: true, agentId: true } } }
    })
    return row?.session ? { agentId: AgentId(row.session.agentId), sessionId: SessionId(row.session.id) } : null
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
          ...identity({
            ...candidate,
            orgId: OrgId(candidate.orgId),
            provider: candidate.provider as CodeHostProvider
          }),
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
    await this.db.sessionPullRequestDelivery.deleteMany({ where: { receivedAt: { lt: unmatchedBefore } } })
    const deleted = await this.db.sessionPullRequest.deleteMany({
      where: { sessionId: null, signalAt: { lt: unmatchedBefore } }
    })
    return deleted.count
  }
}
