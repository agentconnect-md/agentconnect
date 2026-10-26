import type {
  CapabilityAskers,
  CapabilityDecider,
  CapabilityKind,
  CapabilityRequestStatus
} from '@agentconnect.md/protocol'
import {
  Prisma,
  type CapabilityRequest,
  type CapabilityRequestOrigin,
  type PrismaClient
} from '../../generated/prisma/client.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import type { PrismaLike } from '../prisma.js'
import type {
  CapabilityRequestOriginRecord,
  CapabilityRequestRecord,
  CapabilityRequestRepo,
  CapabilitySettlement,
  CapabilityWakeState,
  NewCapabilityOrigin
} from '../ports.js'

type Row = CapabilityRequest & { origins: CapabilityRequestOrigin[] }

const WITH_ORIGINS = { origins: { orderBy: { askedAt: 'asc' as const } } }

function toOrigin(row: CapabilityRequestOrigin): CapabilityRequestOriginRecord {
  return {
    requestId: row.requestId,
    sessionId: row.sessionId,
    sessionKey: row.sessionKey,
    platform: row.platform,
    placeLabel: row.placeLabel,
    external: row.external,
    askers: row.askers as unknown as CapabilityAskers,
    askedAt: row.askedAt,
    wakeGeneration: row.wakeGeneration,
    wakeState: row.wakeState as CapabilityWakeState,
    wakeAttempts: row.wakeAttempts,
    wakeReason: row.wakeReason,
    wakeSince: row.wakeSince,
    wakeDueAt: row.wakeDueAt
  }
}

function toRecord(row: Row): CapabilityRequestRecord {
  return {
    id: row.id,
    orgId: OrgId(row.orgId),
    agentId: AgentId(row.agentId),
    kind: row.kind as CapabilityKind,
    target: row.target,
    want: row.want as Record<string, unknown>,
    summary: row.summary,
    reason: row.reason,
    generation: row.generation,
    status: row.status as CapabilityRequestStatus,
    outcome: row.outcome,
    differs: row.differs,
    note: row.note,
    settledBy: (row.settledBy as CapabilityDecider | null) ?? null,
    settledAt: row.settledAt,
    settledRevision: row.settledRevision,
    changeAppliedAt: row.changeAppliedAt,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    origins: row.origins.map(toOrigin)
  }
}

function originData(origin: NewCapabilityOrigin, at: Date) {
  return {
    sessionId: origin.sessionId,
    sessionKey: origin.sessionKey,
    platform: origin.platform,
    placeLabel: origin.placeLabel,
    external: origin.external,
    askers: origin.askers as unknown as Prisma.InputJsonValue,
    askedAt: at
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

export class PgCapabilityRequestRepo implements CapabilityRequestRepo {
  constructor(private readonly db: PrismaLike) {}

  /** Run both writes of a state change in one transaction where the handle can open one. */
  private atomic<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db)
  }

  async get(orgId: OrgId, id: string): Promise<CapabilityRequestRecord | null> {
    const row = await this.db.capabilityRequest.findFirst({ where: { id, orgId }, include: WITH_ORIGINS })
    return row ? toRecord(row) : null
  }

  async getForAgent(agentId: AgentId, id: string): Promise<CapabilityRequestRecord | null> {
    const row = await this.db.capabilityRequest.findFirst({ where: { id, agentId }, include: WITH_ORIGINS })
    return row ? toRecord(row) : null
  }

  async list(
    orgId: OrgId,
    filter: { agentIds?: AgentId[]; status?: CapabilityRequestStatus }
  ): Promise<CapabilityRequestRecord[]> {
    const rows = await this.db.capabilityRequest.findMany({
      where: {
        orgId,
        ...(filter.agentIds ? { agentId: { in: filter.agentIds } } : {}),
        ...(filter.status ? { status: filter.status } : {})
      },
      include: WITH_ORIGINS,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 200
    })
    return rows.map(toRecord)
  }

  async open(agentId: AgentId, kind: CapabilityKind, target: string): Promise<CapabilityRequestRecord | null> {
    const row = await this.db.capabilityRequest.findFirst({
      where: { agentId, kind, target, status: 'open' },
      include: WITH_ORIGINS
    })
    return row ? toRecord(row) : null
  }

  async openForAgent(agentId: AgentId): Promise<CapabilityRequestRecord[]> {
    const rows = await this.db.capabilityRequest.findMany({
      where: { agentId, status: 'open' },
      include: WITH_ORIGINS,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async declinedSince(
    agentId: AgentId,
    kind: CapabilityKind,
    target: string,
    since: Date
  ): Promise<CapabilityRequestRecord | null> {
    const row = await this.db.capabilityRequest.findFirst({
      where: { agentId, kind, target, status: 'declined', settledAt: { gte: since } },
      include: WITH_ORIGINS,
      orderBy: { settledAt: 'desc' }
    })
    return row ? toRecord(row) : null
  }

  async openForSession(sessionId: string): Promise<number> {
    return this.db.capabilityRequestOrigin.count({ where: { sessionId, request: { status: 'open' } } })
  }

  async create(input: Parameters<CapabilityRequestRepo['create']>[0]): Promise<CapabilityRequestRecord | null> {
    try {
      const row = await this.db.capabilityRequest.create({
        data: {
          id: input.id,
          orgId: input.orgId,
          agentId: input.agentId,
          kind: input.kind,
          target: input.target,
          want: input.want as Prisma.InputJsonValue,
          summary: input.summary,
          reason: input.reason,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          origins: { create: originData(input.origin, input.createdAt) }
        },
        include: WITH_ORIGINS
      })
      return toRecord(row)
    } catch (err) {
      if (isUniqueViolation(err)) return null
      throw err
    }
  }

  async addOrigin(id: string, origin: NewCapabilityOrigin, at: Date): Promise<boolean> {
    return this.atomic(async (db) => {
      // Locked against `settle`: a join that waited for a settlement sees it, and one that won is woken by it.
      const open = await db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "capability_request" WHERE "id" = ${id}::uuid AND "status" = 'open' FOR UPDATE`
      if (open.length === 0) return false
      await db.capabilityRequestOrigin.upsert({
        where: { requestId_sessionId: { requestId: id, sessionId: origin.sessionId } },
        create: { requestId: id, ...originData(origin, at) },
        update: {}
      })
      return true
    })
  }

  async withdrawOrigin(id: string, sessionId: string, at: Date): Promise<'withdrawn' | 'left' | null> {
    return this.atomic(async (db) => {
      const request = await db.capabilityRequest.findFirst({ where: { id, status: 'open' }, include: WITH_ORIGINS })
      if (!request || !request.origins.some((origin) => origin.sessionId === sessionId)) return null
      if (request.origins.length > 1) {
        await db.capabilityRequestOrigin.delete({ where: { requestId_sessionId: { requestId: id, sessionId } } })
        return 'left'
      }
      const done = await db.capabilityRequest.updateMany({
        where: { id, status: 'open' },
        data: { status: 'withdrawn', settledAt: at }
      })
      return done.count === 1 ? 'withdrawn' : null
    })
  }

  async markChangeApplied(agentIds: readonly string[], revision: bigint | null, at: Date): Promise<number> {
    if (agentIds.length === 0) return 0
    const done = await this.db.capabilityRequest.updateMany({
      where: {
        agentId: { in: [...agentIds] },
        status: 'completed',
        changeAppliedAt: null,
        // A registration hands over every agent's current spec, so no revision bound applies to it.
        ...(revision === null ? { settledAt: { lte: at } } : { settledRevision: { lte: revision } })
      },
      data: { changeAppliedAt: at }
    })
    return done.count
  }

  async settle(id: string, generation: number, settlement: CapabilitySettlement): Promise<boolean> {
    return this.atomic(async (db) => {
      const done = await db.capabilityRequest.updateMany({
        where: { id, status: 'open', generation },
        data: {
          status: settlement.status,
          outcome: settlement.outcome,
          differs: settlement.differs,
          note: settlement.note,
          settledBy: (settlement.settledBy ?? Prisma.DbNull) as Prisma.InputJsonValue,
          settledAt: settlement.at,
          settledRevision: settlement.settledRevision,
          changeAppliedAt: settlement.changeApplied ? settlement.at : null
        }
      })
      if (done.count !== 1) return false
      await db.capabilityRequestOrigin.updateMany({
        where: { requestId: id },
        data: {
          wakeGeneration: generation,
          wakeState: 'pending',
          wakeAttempts: 0,
          wakeReason: null,
          wakeSince: settlement.at,
          wakeDueAt: settlement.at,
          claimOwner: null,
          claimUntil: null
        }
      })
      return true
    })
  }

  async reopen(id: string, generation: number, at: Date, expiresAt: Date): Promise<CapabilityRequestRecord | null> {
    try {
      return await this.atomic(async (db) => {
        const done = await db.capabilityRequest.updateMany({
          where: { id, status: 'declined', generation },
          data: {
            status: 'open',
            generation: generation + 1,
            outcome: null,
            differs: false,
            note: null,
            settledBy: Prisma.DbNull,
            settledAt: null,
            settledRevision: null,
            changeAppliedAt: null,
            createdAt: at,
            expiresAt
          }
        })
        if (done.count !== 1) return null
        await db.capabilityRequestOrigin.updateMany({
          where: { requestId: id },
          data: {
            wakeGeneration: generation + 1,
            wakeState: 'none',
            wakeAttempts: 0,
            wakeReason: null,
            wakeSince: null,
            wakeDueAt: null,
            claimOwner: null,
            claimUntil: null
          }
        })
        const row = await db.capabilityRequest.findUnique({ where: { id }, include: WITH_ORIGINS })
        return row ? toRecord(row) : null
      })
    } catch (err) {
      if (isUniqueViolation(err)) return null
      throw err
    }
  }

  async expired(now: Date, limit: number): Promise<CapabilityRequestRecord[]> {
    const rows = await this.db.capabilityRequest.findMany({
      where: { status: 'open', expiresAt: { lte: now } },
      include: WITH_ORIGINS,
      orderBy: { expiresAt: 'asc' },
      take: limit
    })
    return rows.map(toRecord)
  }

  async claimWake(
    owner: string,
    now: Date,
    until: Date
  ): Promise<{ request: CapabilityRequestRecord; origin: CapabilityRequestOriginRecord } | null> {
    const free = {
      wakeState: 'pending',
      wakeDueAt: { lte: now },
      OR: [{ claimUntil: null }, { claimUntil: { lt: now } }]
    }
    const candidates = await this.db.capabilityRequestOrigin.findMany({
      where: free,
      orderBy: [{ wakeDueAt: 'asc' }, { askedAt: 'asc' }],
      take: 20
    })
    for (const candidate of candidates) {
      const claimed = await this.db.capabilityRequestOrigin.updateMany({
        where: { requestId: candidate.requestId, sessionId: candidate.sessionId, ...free },
        data: { claimOwner: owner, claimUntil: until }
      })
      if (claimed.count !== 1) continue
      const request = await this.db.capabilityRequest.findUnique({
        where: { id: candidate.requestId },
        include: WITH_ORIGINS
      })
      if (!request) continue
      return { request: toRecord(request), origin: toOrigin(candidate) }
    }
    return null
  }

  async finishWake(
    requestId: string,
    sessionId: string,
    owner: string,
    generation: number,
    next: { state: CapabilityWakeState; reason: string | null; dueAt: Date | null; attempts: number }
  ): Promise<void> {
    const key = { requestId, sessionId, claimOwner: owner }
    const done = await this.db.capabilityRequestOrigin.updateMany({
      where: { ...key, wakeGeneration: generation },
      data: {
        wakeState: next.state,
        wakeReason: next.reason,
        wakeDueAt: next.dueAt,
        wakeAttempts: next.attempts,
        claimOwner: null,
        claimUntil: null
      }
    })
    if (done.count === 0) {
      await this.db.capabilityRequestOrigin.updateMany({ where: key, data: { claimOwner: null, claimUntil: null } })
    }
  }
}
