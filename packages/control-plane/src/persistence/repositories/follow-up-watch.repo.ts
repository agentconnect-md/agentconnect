import type { FollowUpWatch } from '../../generated/prisma/client.js'
import type { CodeHostProvider, FollowUpEventKind, FollowUpWatchSubject } from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../../domain/ids.js'
import type { PrismaLike } from '../prisma.js'
import type { FollowUpPendingWake, FollowUpWatchObject, FollowUpWatchRecord, FollowUpWatchRepo } from '../ports.js'

function toRecord(row: FollowUpWatch): FollowUpWatchRecord {
  return {
    agentId: AgentId(row.agentId),
    followUpId: row.followUpId,
    orgId: OrgId(row.orgId),
    provider: row.provider as CodeHostProvider,
    installationId: row.installationId,
    bindingId: row.bindingId,
    host: row.host,
    repoId: row.repoId,
    subject: row.subject as FollowUpWatchSubject,
    number: row.number,
    repoPath: row.repoPath,
    generation: row.generation,
    wakeSeq: row.wakeSeq,
    pendingSince: row.pendingSince,
    pendingStateSince: row.pendingStateSince,
    pendingLatestAt: row.pendingLatestAt,
    pendingKinds: row.pendingKinds as FollowUpEventKind[],
    dueAt: row.dueAt,
    endedReason: row.endedReason === 'access_lost' ? 'access_lost' : null,
    lastWakeAt: row.lastWakeAt,
    lastWakeKinds: row.lastWakeKinds as FollowUpEventKind[]
  }
}

function objectKey(object: FollowUpWatchObject) {
  return {
    orgId: object.orgId,
    provider: object.provider,
    bindingId: object.bindingId,
    repoId: object.repoId,
    subject: object.subject,
    number: object.number
  }
}

const NO_PENDING = {
  pendingSince: null,
  pendingStateSince: null,
  pendingLatestAt: null,
  pendingKinds: [],
  dueAt: null
}

export class PgFollowUpWatchRepo implements FollowUpWatchRepo {
  constructor(private readonly db: PrismaLike) {}

  async listForAgent(agentId: AgentId): Promise<FollowUpWatchRecord[]> {
    const rows = await this.db.followUpWatch.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toRecord)
  }

  async put(input: Parameters<FollowUpWatchRepo['put']>[0]): Promise<void> {
    const object = objectKey(input)
    const where = { agentId_followUpId: { agentId: input.agentId, followUpId: input.followUpId } }
    const existing = await this.db.followUpWatch.findUnique({ where })
    const same =
      existing &&
      existing.orgId === object.orgId &&
      existing.provider === object.provider &&
      existing.bindingId === object.bindingId &&
      existing.repoId === object.repoId &&
      existing.subject === object.subject &&
      existing.number === object.number
    await this.db.followUpWatch.upsert({
      where,
      create: {
        agentId: input.agentId,
        followUpId: input.followUpId,
        ...object,
        installationId: input.installationId,
        host: input.host,
        repoPath: input.repoPath
      },
      update: {
        ...object,
        installationId: input.installationId,
        host: input.host,
        repoPath: input.repoPath,
        endedReason: null,
        ...(same
          ? {}
          : {
              ...NO_PENDING,
              lastWakeAt: null,
              lastWakeKinds: [],
              generation: { increment: 1 },
              claimOwner: null,
              claimUntil: null
            })
      }
    })
  }

  async remove(agentId: AgentId, followUpIds: string[]): Promise<FollowUpWatchRecord[]> {
    if (followUpIds.length === 0) return []
    const where = { agentId, followUpId: { in: followUpIds } }
    const rows = await this.db.followUpWatch.findMany({ where })
    await this.db.followUpWatch.deleteMany({ where })
    return rows.map(toRecord)
  }

  async removeIf(row: FollowUpWatchRecord): Promise<boolean> {
    const deleted = await this.db.followUpWatch.deleteMany({
      where: { agentId: row.agentId, followUpId: row.followUpId, generation: row.generation }
    })
    return deleted.count === 1
  }

  async forObject(object: FollowUpWatchObject): Promise<FollowUpWatchRecord[]> {
    const rows = await this.db.followUpWatch.findMany({ where: { ...objectKey(object), endedReason: null } })
    return rows.map(toRecord)
  }

  async watched(object: FollowUpWatchObject): Promise<boolean> {
    return (await this.db.followUpWatch.count({ where: objectKey(object) })) > 0
  }

  async receive(object: FollowUpWatchObject, deliveryKey: string, at: Date): Promise<boolean> {
    const created = await this.db.followUpWatchDelivery.createMany({
      data: [{ ...objectKey(object), deliveryKey, receivedAt: at }],
      skipDuplicates: true
    })
    return created.count === 1
  }

  async fold(row: FollowUpWatchRecord, pending: FollowUpPendingWake): Promise<boolean> {
    const folded = await this.db.followUpWatch.updateMany({
      where: {
        agentId: row.agentId,
        followUpId: row.followUpId,
        generation: row.generation,
        wakeSeq: row.wakeSeq,
        endedReason: null
      },
      data: { ...pending, wakeSeq: row.wakeSeq + 1 }
    })
    return folded.count === 1
  }

  async claimNext(owner: string, now: Date, until: Date): Promise<FollowUpWatchRecord | null> {
    const free = { dueAt: { lte: now }, OR: [{ claimUntil: null }, { claimUntil: { lt: now } }] }
    const candidates = await this.db.followUpWatch.findMany({
      where: free,
      orderBy: [{ dueAt: 'asc' }, { agentId: 'asc' }, { followUpId: 'asc' }],
      take: 20
    })
    for (const candidate of candidates) {
      const claimed = await this.db.followUpWatch.updateMany({
        where: { agentId: candidate.agentId, followUpId: candidate.followUpId, ...free },
        data: { claimOwner: owner, claimUntil: until }
      })
      if (claimed.count === 1) return toRecord(candidate)
    }
    return null
  }

  async complete(row: FollowUpWatchRecord, owner: string, at: Date): Promise<void> {
    const key = { agentId: row.agentId, followUpId: row.followUpId, claimOwner: owner }
    const completed = await this.db.followUpWatch.updateMany({
      where: { ...key, generation: row.generation, wakeSeq: row.wakeSeq },
      data: { ...NO_PENDING, lastWakeAt: at, lastWakeKinds: row.pendingKinds, claimOwner: null, claimUntil: null }
    })
    if (completed.count === 0) {
      await this.db.followUpWatch.updateMany({ where: key, data: { claimOwner: null, claimUntil: null } })
    }
  }

  async defer(row: FollowUpWatchRecord, owner: string, nextAttemptAt: Date): Promise<void> {
    await this.db.followUpWatch.updateMany({
      where: { agentId: row.agentId, followUpId: row.followUpId, generation: row.generation, claimOwner: owner },
      data: { dueAt: nextAttemptAt, claimOwner: null, claimUntil: null }
    })
  }

  async end(row: FollowUpWatchRecord, reason: 'access_lost', at: Date): Promise<boolean> {
    const ended = await this.db.followUpWatch.updateMany({
      where: { agentId: row.agentId, followUpId: row.followUpId, generation: row.generation },
      data: { ...NO_PENDING, endedReason: reason, dueAt: at }
    })
    return ended.count === 1
  }

  async objects(provider: CodeHostProvider): Promise<Array<FollowUpWatchObject & { installationId: bigint | null }>> {
    const rows = await this.db.followUpWatch.findMany({
      where: { provider, endedReason: null },
      distinct: ['orgId', 'provider', 'bindingId', 'repoId', 'subject', 'number'],
      select: {
        orgId: true,
        provider: true,
        bindingId: true,
        repoId: true,
        subject: true,
        number: true,
        installationId: true
      }
    })
    return rows.map((row) => ({
      ...row,
      orgId: OrgId(row.orgId),
      provider: row.provider as CodeHostProvider,
      subject: row.subject as FollowUpWatchSubject
    }))
  }

  async deleteExpiredReceipts(before: Date): Promise<number> {
    return (await this.db.followUpWatchDelivery.deleteMany({ where: { receivedAt: { lt: before } } })).count
  }
}
