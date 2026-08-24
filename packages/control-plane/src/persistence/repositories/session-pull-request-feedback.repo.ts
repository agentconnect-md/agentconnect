import { Prisma, type SessionPullRequestFeedback } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type { PullRequestFeedbackRecord, PullRequestFeedbackTarget, SessionPullRequestFeedbackRepo } from '../ports.js'
import { AgentId, OrgId, SessionId } from '../../domain/ids.js'

function toRecord(row: SessionPullRequestFeedback & { sessionId: string }): PullRequestFeedbackRecord {
  return {
    id: row.id,
    deliveryKey: row.deliveryKey,
    orgId: OrgId(row.orgId),
    installationId: row.installationId,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    event: row.event as PullRequestFeedbackRecord['event'],
    kind: row.kind as PullRequestFeedbackRecord['kind'],
    detail: row.detail,
    observedAt: row.observedAt,
    sessionId: SessionId(row.sessionId)
  }
}

export class PgSessionPullRequestFeedbackRepo implements SessionPullRequestFeedbackRepo {
  constructor(private readonly db: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withAmbientTx(this.db, fn)
  }

  async linkSession(input: {
    sessionId: SessionId
    agentId: AgentId
    orgId: OrgId
    repoId: bigint
    repoFullName: string
    installationId: bigint
    pullNumber: number
    at: Date
  }): Promise<boolean> {
    try {
      return await this.transaction(async (tx) => {
        const current = await tx.sessionMeta.findUnique({
          where: { id: input.sessionId },
          select: {
            agentId: true,
            orgId: true,
            contentPurgedAt: true,
            pullRequestRepoId: true,
            pullRequestNumber: true
          }
        })
        if (!current || current.agentId !== input.agentId || current.orgId !== input.orgId || current.contentPurgedAt) {
          return false
        }
        const same = current.pullRequestRepoId === input.repoId && current.pullRequestNumber === input.pullNumber
        if (current.pullRequestRepoId !== null && !same) return false
        if (!same) {
          const linked = await tx.sessionMeta.updateMany({
            where: { id: input.sessionId, pullRequestRepoId: null, pullRequestNumber: null },
            data: {
              pullRequestRepoId: input.repoId,
              pullRequestRepoFullName: input.repoFullName,
              pullRequestInstallationId: input.installationId,
              pullRequestNumber: input.pullNumber,
              pullRequestLinkedAt: input.at
            }
          })
          if (linked.count !== 1) return false
        } else {
          await tx.sessionMeta.update({
            where: { id: input.sessionId },
            data: {
              pullRequestRepoFullName: input.repoFullName,
              pullRequestInstallationId: input.installationId
            }
          })
        }
        await tx.sessionPullRequestFeedback.updateMany({
          where: {
            orgId: input.orgId,
            repoId: input.repoId,
            pullNumber: input.pullNumber,
            sessionId: null
          },
          data: { sessionId: input.sessionId }
        })
        return true
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false
      throw err
    }
  }

  async enqueue(orgId: OrgId, signal: Parameters<SessionPullRequestFeedbackRepo['enqueue']>[1]): Promise<void> {
    const repoId = BigInt(signal.repoId)
    const installationId = BigInt(signal.installationId)
    await this.db.sessionPullRequestFeedback.upsert({
      where: { deliveryKey: signal.deliveryKey },
      create: {
        deliveryKey: signal.deliveryKey,
        orgId,
        installationId,
        repoId,
        repoFullName: signal.repoFullName,
        pullNumber: signal.pullNumber,
        event: signal.event,
        kind: signal.kind,
        detail: signal.detail,
        observedAt: new Date(signal.observedAt)
      },
      update: {}
    })
    // Link and enqueue each attach from their side, so either transaction order converges.
    const linked = await this.db.sessionMeta.findFirst({
      where: {
        orgId,
        pullRequestRepoId: repoId,
        pullRequestNumber: signal.pullNumber,
        contentPurgedAt: null
      },
      select: { id: true }
    })
    if (linked) {
      await this.db.sessionPullRequestFeedback.updateMany({
        where: { deliveryKey: signal.deliveryKey, sessionId: null },
        data: { sessionId: linked.id }
      })
    }
  }

  async unmatchedTargets(limit: number): Promise<PullRequestFeedbackTarget[]> {
    const rows = await this.db.sessionPullRequestFeedback.findMany({
      where: { sessionId: null, deliveredAt: null },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(limit * 10, 200)),
      select: { orgId: true, repoId: true, pullNumber: true }
    })
    const seen = new Set<string>()
    const targets: PullRequestFeedbackTarget[] = []
    for (const row of rows) {
      const key = `${row.orgId}:${row.repoId}:${row.pullNumber}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ orgId: OrgId(row.orgId), repoId: row.repoId, pullNumber: row.pullNumber })
      if (targets.length >= limit) break
    }
    return targets
  }

  async claimPendingBatch(
    owner: string,
    now: Date,
    until: Date,
    readyBefore: Date
  ): Promise<PullRequestFeedbackRecord[]> {
    const candidates = await this.db.sessionPullRequestFeedback.findMany({
      where: {
        sessionId: { not: null },
        deliveredAt: null,
        OR: [{ claimUntil: null }, { claimUntil: { lt: now } }]
      },
      orderBy: { createdAt: 'asc' },
      take: 20
    })
    const visited = new Set<string>()
    for (const candidate of candidates) {
      if (!candidate.sessionId) continue
      if (visited.has(candidate.sessionId)) continue
      visited.add(candidate.sessionId)
      const [latest, activeClaim] = await Promise.all([
        this.db.sessionPullRequestFeedback.findFirst({
          where: { sessionId: candidate.sessionId, deliveredAt: null },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true }
        }),
        this.db.sessionPullRequestFeedback.findFirst({
          where: { sessionId: candidate.sessionId, deliveredAt: null, claimUntil: { gte: now } },
          select: { id: true }
        })
      ])
      if (!latest || latest.createdAt > readyBefore || activeClaim) continue
      const claimed = await this.db.sessionPullRequestFeedback.updateMany({
        where: {
          sessionId: candidate.sessionId,
          deliveredAt: null,
          OR: [{ claimUntil: null }, { claimUntil: { lt: now } }]
        },
        data: { claimOwner: owner, claimUntil: until }
      })
      if (claimed.count === 0) continue
      const batch = await this.db.sessionPullRequestFeedback.findMany({
        where: { sessionId: candidate.sessionId, deliveredAt: null, claimOwner: owner, claimUntil: until },
        orderBy: { createdAt: 'asc' }
      })
      return batch.flatMap((row) => (row.sessionId ? [toRecord({ ...row, sessionId: row.sessionId })] : []))
    }
    return []
  }

  async markDelivered(ids: string[], owner: string, at: Date): Promise<void> {
    if (ids.length === 0) return
    await this.db.sessionPullRequestFeedback.updateMany({
      where: { id: { in: ids }, claimOwner: owner, deliveredAt: null },
      data: { deliveredAt: at, claimOwner: null, claimUntil: null }
    })
  }

  async release(ids: string[], owner: string): Promise<void> {
    if (ids.length === 0) return
    await this.db.sessionPullRequestFeedback.updateMany({
      where: { id: { in: ids }, claimOwner: owner, deliveredAt: null },
      data: { claimOwner: null, claimUntil: null }
    })
  }

  async deleteExpired(unmatchedBefore: Date, deliveredBefore: Date): Promise<number> {
    const deleted = await this.db.sessionPullRequestFeedback.deleteMany({
      where: {
        OR: [
          { sessionId: null, createdAt: { lt: unmatchedBefore } },
          { deliveredAt: { not: null, lt: deliveredBefore } }
        ]
      }
    })
    return deleted.count
  }
}
