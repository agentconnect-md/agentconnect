import { Prisma, type SessionPullRequestWake } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type { PullRequestWakeRecord, SessionPullRequestFeedbackRepo } from '../ports.js'
import { AgentId, OrgId, SessionId } from '../../domain/ids.js'

function toRecord(row: SessionPullRequestWake): PullRequestWakeRecord {
  return {
    id: row.id,
    deliveryKey: row.latestDeliveryKey,
    generation: row.generation,
    orgId: OrgId(row.orgId),
    installationId: row.installationId,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    sessionId: row.sessionId ? SessionId(row.sessionId) : null
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
        const attached = await tx.sessionPullRequestWake.updateMany({
          where: {
            orgId: input.orgId,
            repoId: input.repoId,
            pullNumber: input.pullNumber,
            sessionId: null
          },
          data: {
            sessionId: input.sessionId,
            repoFullName: input.repoFullName,
            installationId: input.installationId,
            claimOwner: null,
            claimUntil: null
          }
        })
        if (attached.count === 0) {
          await tx.sessionPullRequestWake.updateMany({
            where: {
              orgId: input.orgId,
              repoId: input.repoId,
              pullNumber: input.pullNumber,
              sessionId: input.sessionId
            },
            data: { repoFullName: input.repoFullName, installationId: input.installationId }
          })
        }
        return true
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false
      throw err
    }
  }

  async enqueue(
    orgId: OrgId,
    signal: Parameters<SessionPullRequestFeedbackRepo['enqueue']>[1],
    nextAttemptAt: Date
  ): Promise<void> {
    const repoId = BigInt(signal.repoId)
    const installationId = BigInt(signal.installationId)
    await this.transaction(async (tx) => {
      const wake = await tx.sessionPullRequestWake.upsert({
        where: { orgId_repoId_pullNumber: { orgId, repoId, pullNumber: signal.pullNumber } },
        create: {
          orgId,
          installationId,
          repoId,
          repoFullName: signal.repoFullName,
          pullNumber: signal.pullNumber,
          latestDeliveryKey: signal.deliveryKey,
          nextAttemptAt
        },
        update: {}
      })
      if (wake.latestDeliveryKey !== signal.deliveryKey) {
        await tx.sessionPullRequestWake.updateMany({
          where: { id: wake.id, latestDeliveryKey: { not: signal.deliveryKey } },
          data: {
            installationId,
            repoFullName: signal.repoFullName,
            latestDeliveryKey: signal.deliveryKey,
            generation: { increment: 1 },
            nextAttemptAt,
            deliveredAt: null
          }
        })
      }
      const linked = await tx.sessionMeta.findFirst({
        where: {
          orgId,
          pullRequestRepoId: repoId,
          pullRequestNumber: signal.pullNumber,
          contentPurgedAt: null
        },
        select: { id: true }
      })
      if (linked) {
        await tx.sessionPullRequestWake.updateMany({
          where: { id: wake.id, sessionId: null },
          data: { sessionId: linked.id }
        })
      }
    })
  }

  async claimNext(owner: string, now: Date, until: Date): Promise<PullRequestWakeRecord | null> {
    const candidates = await this.db.sessionPullRequestWake.findMany({
      where: {
        deliveredAt: null,
        nextAttemptAt: { lte: now },
        OR: [{ claimUntil: null }, { claimUntil: { lt: now } }]
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 20
    })
    for (const candidate of candidates) {
      const claimed = await this.db.sessionPullRequestWake.updateMany({
        where: {
          id: candidate.id,
          generation: candidate.generation,
          deliveredAt: null,
          nextAttemptAt: { lte: now },
          OR: [{ claimUntil: null }, { claimUntil: { lt: now } }]
        },
        data: { claimOwner: owner, claimUntil: until }
      })
      if (claimed.count === 1) return toRecord(candidate)
    }
    return null
  }

  async markDelivered(id: string, generation: number, owner: string, at: Date): Promise<void> {
    const completed = await this.db.sessionPullRequestWake.updateMany({
      where: { id, generation, claimOwner: owner, deliveredAt: null },
      data: { deliveredAt: at, claimOwner: null, claimUntil: null }
    })
    if (completed.count === 0) {
      await this.db.sessionPullRequestWake.updateMany({
        where: { id, claimOwner: owner },
        data: { claimOwner: null, claimUntil: null }
      })
    }
  }

  async defer(id: string, generation: number, owner: string, nextAttemptAt: Date): Promise<void> {
    const deferred = await this.db.sessionPullRequestWake.updateMany({
      where: { id, generation, claimOwner: owner, deliveredAt: null },
      data: { nextAttemptAt, claimOwner: null, claimUntil: null }
    })
    if (deferred.count === 0) {
      await this.db.sessionPullRequestWake.updateMany({
        where: { id, claimOwner: owner },
        data: { claimOwner: null, claimUntil: null }
      })
    }
  }

  async deleteExpired(unmatchedBefore: Date, deliveredBefore: Date): Promise<number> {
    const deleted = await this.db.sessionPullRequestWake.deleteMany({
      where: {
        OR: [
          { sessionId: null, updatedAt: { lt: unmatchedBefore } },
          { deliveredAt: { not: null, lt: deliveredBefore } }
        ]
      }
    })
    return deleted.count
  }
}
