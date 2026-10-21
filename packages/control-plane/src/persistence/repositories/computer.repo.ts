// PgComputerRepo — registered desktops, their one-time registration tokens and key binding (computer-use.md §2.2, §3.6).
import type { Computer, ComputerRegistration, Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  ComputerLiveReport,
  ComputerRecord,
  ComputerRegistrationRecord,
  ComputerRepo,
  CreateComputerRegistrationInput,
  CreateManagedComputerInput,
  ManagedComputerKey,
  PoolPhaseWrite,
  RegisterComputerInput,
  ResourceVisibility,
  ViewCtx
} from '../ports.js'
import { isComputerPoolPhase, type ComputerAllocation } from '../../domain/computerPool.js'
import { visibilityWhere } from '../../authorization/policy.js'
import { ComputerId, OrgId } from '../../domain/ids.js'
import {
  defaultComputerPolicy,
  readComputerCapabilities,
  readComputerDoctor,
  readComputerPolicy,
  type ComputerKind,
  type ComputerPolicy,
  type ComputerSession
} from '../../domain/computer.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'
import { OrgMembershipMissing } from '../errors.js'

// Prisma enum members cannot hold `-`, so the client spells the wire values with `_` (the columns keep the wire spelling via @map).
const toDbKind = (k: ComputerKind) => (k === 'self-hosted' ? 'self_hosted' : k)
const fromDbKind = (k: Computer['kind']): ComputerKind => (k === 'self_hosted' ? 'self-hosted' : k)
const toDbSession = (s: ComputerSession) => (s === 'wayland-gnome' ? 'wayland_gnome' : s)
const fromDbSession = (s: Computer['session']): ComputerSession => (s === 'wayland_gnome' ? 'wayland-gnome' : s)
const toDbAllocation = (a: ComputerAllocation): NonNullable<Computer['allocation']> =>
  a === 'per-agent' ? 'per_agent' : a
const fromDbAllocation = (a: NonNullable<Computer['allocation']>): ComputerAllocation =>
  a === 'per_agent' ? 'per-agent' : a

function toRecord(c: Computer): ComputerRecord {
  return {
    id: ComputerId(c.id),
    orgId: OrgId(c.orgId),
    name: c.name,
    ownerUserId: c.ownerUserId,
    kind: fromDbKind(c.kind),
    isolation: c.isolation,
    os: c.os,
    osVersion: c.osVersion,
    session: fromDbSession(c.session),
    status: c.status,
    capabilities: readComputerCapabilities(c.capabilities),
    doctor: readComputerDoctor(c.doctor),
    desktopDaemonVersion: c.desktopDaemonVersion,
    driverVersion: c.driverVersion,
    policy: readComputerPolicy(c.policy, c.ownerUserId),
    visibility: c.visibility as ResourceVisibility,
    sharedWith: c.sharedWith,
    lastSeenAt: c.lastSeenAt,
    revokedAt: c.revokedAt,
    stoppedAt: c.stoppedAt,
    stoppedByUserId: c.stoppedByUserId,
    allocation: c.allocation ? fromDbAllocation(c.allocation) : null,
    ownerAgentId: c.ownerAgentId,
    poolSessionId: c.poolSessionId,
    poolPhase: isComputerPoolPhase(c.poolPhase) ? c.poolPhase : null,
    poolPhaseAt: c.poolPhaseAt,
    poolActiveAt: c.poolActiveAt,
    poolError: c.poolError,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  }
}

const isUniqueViolation = (err: unknown): boolean => (err as { code?: unknown })?.code === 'P2002'

function toRegistrationRecord(r: ComputerRegistration): ComputerRegistrationRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    createdByUserId: r.createdByUserId,
    displayTail: r.displayTail,
    name: r.name,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    computerId: r.computerId ? ComputerId(r.computerId) : null,
    createdAt: r.createdAt
  }
}

const policyJson = (p: ComputerPolicy) => p as unknown as Prisma.InputJsonValue

export class PgComputerRepo implements ComputerRepo {
  constructor(private readonly db: PrismaLike) {}

  async createRegistration(input: CreateComputerRegistrationInput): Promise<ComputerRegistrationRecord> {
    return withAmbientTx(this.db, async (tx) => {
      // The registrant must still be a member when the token is minted, and again when it is spent; the pool mints its own.
      if (!input.computerId) {
        await lockResourceWriteMemberships(tx, {
          orgId: input.orgId,
          visibility: 'org',
          actorUserId: input.createdByUserId
        })
      }
      const row = await tx.computerRegistration.create({
        data: {
          orgId: input.orgId,
          createdByUserId: input.createdByUserId,
          hash: input.hash,
          displayTail: input.displayTail,
          name: input.name ?? null,
          expiresAt: input.expiresAt,
          ...(input.computerId ? { computerId: input.computerId } : {})
        }
      })
      return toRegistrationRecord(row)
    })
  }

  async register(input: RegisterComputerInput): Promise<{ computer: ComputerRecord; apiKeyId: string } | null> {
    try {
      return await withAmbientTx(this.db, async (tx) => {
        const registration = await tx.computerRegistration.findUnique({ where: { hash: input.registrationHash } })
        if (!registration) return null
        if (registration.computerId) return await this.registerBound(tx, registration, input)
        const owner = registration.createdByUserId
        // Lock the org and membership before the token row, the same order member removal takes them.
        const memberships = await lockResourceWriteMemberships(tx, {
          orgId: registration.orgId,
          visibility: 'restricted',
          actorUserId: owner,
          sharedWith: [owner]
        })
        // The role is rechecked at the exchange: a registrant demoted to viewer since minting may no longer register.
        const role = await tx.membership.findUnique({
          where: { orgId_userId: { orgId: registration.orgId, userId: owner } },
          select: { role: true }
        })
        if (!role || role.role === 'viewer') throw new OrgMembershipMissing()
        // The conditional update is the one-time gate: two concurrent exchanges cannot both match it.
        const consumed = await tx.computerRegistration.updateMany({
          where: { id: registration.id, consumedAt: null, expiresAt: { gt: input.now } },
          data: { consumedAt: input.now }
        })
        if (consumed.count !== 1) return null
        const p = input.profile
        const computer = await tx.computer.create({
          data: {
            id: input.computerId,
            orgId: registration.orgId,
            name: registration.name ?? p.name,
            ownerUserId: owner,
            kind: toDbKind(p.kind),
            isolation: p.isolation,
            os: p.os,
            osVersion: p.osVersion,
            session: toDbSession(p.session),
            capabilities: p.capabilities as unknown as Prisma.InputJsonValue,
            desktopDaemonVersion: p.desktopDaemonVersion,
            driverVersion: p.driverVersion,
            policy: policyJson(defaultComputerPolicy(owner)),
            visibility: 'restricted',
            sharedWith: memberships.sharedWith ?? [owner]
          }
        })
        await tx.computerRegistration.update({ where: { id: registration.id }, data: { computerId: computer.id } })
        const key = await tx.apiKey.create({
          data: {
            principalType: 'computer',
            orgId: registration.orgId,
            computerId: computer.id,
            hash: input.key.hash,
            displayTail: input.key.displayTail,
            createdByUserId: owner,
            expiresAt: null
          },
          select: { id: true }
        })
        return { computer: toRecord(computer), apiKeyId: key.id }
      })
    } catch (err) {
      // A registrant who left the organization spends nothing: the transaction rolled back and the token stays unusable.
      if (err instanceof OrgMembershipMissing) return null
      throw err
    }
  }

  // A pool-minted token keys the managed row it was minted for; its earlier keys are revoked, as only one pod holds it.
  private async registerBound(
    tx: Prisma.TransactionClient,
    registration: ComputerRegistration,
    input: RegisterComputerInput
  ): Promise<{ computer: ComputerRecord; apiKeyId: string } | null> {
    const computerId = registration.computerId!
    const consumed = await tx.computerRegistration.updateMany({
      where: { id: registration.id, consumedAt: null, expiresAt: { gt: input.now } },
      data: { consumedAt: input.now }
    })
    if (consumed.count !== 1) return null
    const existing = await tx.computer.findUnique({ where: { id: computerId } })
    if (!existing || existing.orgId !== registration.orgId || existing.revokedAt || existing.kind !== 'managed')
      return null
    await tx.apiKey.updateMany({
      where: { computerId, revokedAt: null },
      data: { revokedAt: input.now, revokedReason: 'managed computer re-registered' }
    })
    const p = input.profile
    const computer = await tx.computer.update({
      where: { id: computerId },
      data: {
        isolation: p.isolation,
        os: p.os,
        osVersion: p.osVersion,
        session: toDbSession(p.session),
        capabilities: p.capabilities as unknown as Prisma.InputJsonValue,
        desktopDaemonVersion: p.desktopDaemonVersion,
        driverVersion: p.driverVersion
      }
    })
    const key = await tx.apiKey.create({
      data: {
        principalType: 'computer',
        orgId: registration.orgId,
        computerId,
        hash: input.key.hash,
        displayTail: input.key.displayTail,
        createdByUserId: existing.ownerUserId,
        expiresAt: null
      },
      select: { id: true }
    })
    return { computer: toRecord(computer), apiKeyId: key.id }
  }

  async get(orgId: OrgId, id: ComputerId): Promise<ComputerRecord | null> {
    const row = await this.db.computer.findUnique({ where: { id, orgId } })
    return row ? toRecord(row) : null
  }

  async getUnscoped(id: ComputerId): Promise<ComputerRecord | null> {
    const row = await this.db.computer.findUnique({ where: { id } })
    return row ? toRecord(row) : null
  }

  async list(orgId: OrgId, viewer?: ViewCtx): Promise<ComputerRecord[]> {
    const rows = await this.db.computer.findMany({
      where: { orgId, ...visibilityWhere(viewer) },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async getRegistration(orgId: OrgId, id: string): Promise<ComputerRegistrationRecord | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const row = await this.db.computerRegistration.findUnique({ where: { id, orgId } })
    return row ? toRegistrationRecord(row) : null
  }

  async setStop(
    orgId: OrgId,
    id: ComputerId,
    stop: { at: Date; byUserId: string | null } | null
  ): Promise<ComputerRecord | null> {
    // Conditional on status like the policy, so a revoke that commits first still wins.
    const written = await this.db.computer.updateMany({
      where: { id, orgId, status: { not: 'revoked' } },
      data: stop ? { stoppedAt: stop.at, stoppedByUserId: stop.byUserId } : { stoppedAt: null, stoppedByUserId: null }
    })
    if (written.count === 0) return null
    return this.get(orgId, id)
  }

  async setPolicy(orgId: OrgId, id: ComputerId, policy: ComputerPolicy): Promise<ComputerRecord | null> {
    // Conditional on status, so a revoke that commits after the route's read still wins.
    const written = await this.db.computer.updateMany({
      where: { id, orgId, status: { not: 'revoked' } },
      data: { policy: policyJson(policy) }
    })
    if (written.count === 0) return null
    return this.get(orgId, id)
  }

  async setSharing(
    orgId: OrgId,
    id: ComputerId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<ComputerRecord> {
    return withAmbientTx(this.db, async (tx) => {
      // Org fence on the opening read: a cross-org id throws the same P2025 as a missing row.
      const existing = await tx.computer.findUniqueOrThrow({
        where: { id, orgId },
        select: { kind: true, ownerUserId: true }
      })
      // A self-hosted desktop's registrant stays in a Selected audience while still a member (the lock drops a departed one).
      const requested =
        sharing.visibility === 'restricted' && existing.kind === 'self_hosted'
          ? [existing.ownerUserId, ...sharing.sharedWith]
          : sharing.sharedWith
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId,
        visibility: sharing.visibility,
        actorUserId: byUserId,
        sharedWith: requested
      })
      const row = await tx.computer.update({
        where: { id, orgId },
        data: { visibility: sharing.visibility, sharedWith: memberships.sharedWith ?? [] }
      })
      return toRecord(row)
    })
  }

  async revoke(
    orgId: OrgId,
    id: ComputerId,
    reason: string,
    at: Date
  ): Promise<{ computer: ComputerRecord; revokedKeyIds: string[] }> {
    return withAmbientTx(this.db, async (tx) => {
      const existing = await tx.computer.findUniqueOrThrow({ where: { id, orgId } })
      const live = await tx.apiKey.findMany({
        where: { computerId: id, orgId, revokedAt: null },
        select: { id: true }
      })
      if (live.length > 0) {
        await tx.apiKey.updateMany({
          where: { id: { in: live.map((k) => k.id) } },
          data: { revokedAt: at, revokedReason: reason }
        })
      }
      const row =
        existing.status === 'revoked'
          ? existing
          : await tx.computer.update({ where: { id, orgId }, data: { status: 'revoked', revokedAt: at } })
      return { computer: toRecord(row), revokedKeyIds: live.map((k) => k.id) }
    })
  }

  async recordLive(
    orgId: OrgId,
    id: ComputerId,
    apiKeyId: string,
    report: ComputerLiveReport,
    at: Date
  ): Promise<boolean> {
    // Conditional on the Computer and the channel's own key both still standing, so a revoke always wins the race.
    const written = await this.db.computer.updateMany({
      where: { id, orgId, revokedAt: null, apiKeys: { some: { id: apiKeyId, revokedAt: null } } },
      data: {
        status: report.status,
        lastSeenAt: at,
        ...(report.osVersion ? { osVersion: report.osVersion } : {}),
        ...(report.session ? { session: toDbSession(report.session) } : {}),
        ...(report.desktopDaemonVersion ? { desktopDaemonVersion: report.desktopDaemonVersion } : {}),
        ...(report.driverVersion ? { driverVersion: report.driverVersion } : {}),
        ...(report.capabilities ? { capabilities: report.capabilities as unknown as Prisma.InputJsonValue } : {}),
        ...(report.doctor ? { doctor: report.doctor as unknown as Prisma.InputJsonValue } : {})
      }
    })
    return written.count === 1
  }

  async markOffline(orgId: OrgId, id: ComputerId, at: Date): Promise<void> {
    // A pod the pool put to sleep closes its channel too; it stays sleeping.
    await this.db.computer.updateMany({
      where: { id, orgId, status: { notIn: ['revoked', 'offline', 'sleeping'] } },
      data: { status: 'offline', lastSeenAt: at }
    })
  }

  async liveKeyId(id: ComputerId, at: Date): Promise<string | null> {
    const key = await this.db.apiKey.findFirst({
      where: {
        computerId: id,
        principalType: 'computer',
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
        computer: { revokedAt: null }
      },
      orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: { id: true }
    })
    return key?.id ?? null
  }

  async reapRegistrations(expiredBefore: Date): Promise<number> {
    // A token is consumed before it expires, so its expiry bounds both the spent and the unspent rows.
    const { count } = await this.db.computerRegistration.deleteMany({ where: { expiresAt: { lt: expiredBefore } } })
    return count
  }

  async delete(orgId: OrgId, id: ComputerId): Promise<void> {
    await this.db.computer.delete({ where: { id, orgId } })
  }

  async createManaged(input: CreateManagedComputerInput): Promise<ComputerRecord | null> {
    try {
      const row = await this.db.computer.create({
        data: {
          id: input.id,
          orgId: input.orgId,
          name: input.name,
          ownerUserId: input.ownerUserId,
          kind: 'managed',
          isolation: 'container',
          os: 'linux',
          osVersion: '',
          session: 'xvfb',
          capabilities: {},
          desktopDaemonVersion: '',
          driverVersion: '',
          policy: policyJson(input.policy),
          visibility: 'org',
          sharedWith: [],
          allocation: toDbAllocation(input.allocation),
          ownerAgentId: input.ownerAgentId ?? null,
          poolSessionId: input.poolSessionId ?? null,
          poolPhase: 'provisioning',
          poolPhaseAt: input.now,
          poolActiveAt: input.now
        }
      })
      return toRecord(row)
    } catch (err) {
      // The partial unique indexes: a concurrent acquire made the agent's or session's computer first.
      if (isUniqueViolation(err)) return null
      throw err
    }
  }

  async findManaged(orgId: OrgId, key: ManagedComputerKey): Promise<ComputerRecord | null> {
    const where = {
      orgId,
      kind: 'managed' as const,
      allocation: toDbAllocation(key.allocation),
      ownerAgentId: key.ownerAgentId,
      ...(key.allocation === 'ephemeral' ? { poolSessionId: key.poolSessionId } : {})
    }
    const live = await this.db.computer.findFirst({
      where: { ...where, NOT: { poolPhase: 'reclaiming' } },
      orderBy: { createdAt: 'desc' }
    })
    if (live) return toRecord(live)
    const reclaiming = await this.db.computer.findFirst({
      where: { ...where, poolPhase: 'reclaiming' },
      orderBy: { poolPhaseAt: 'desc' }
    })
    return reclaiming ? toRecord(reclaiming) : null
  }

  async setPoolPhase(id: ComputerId, write: PoolPhaseWrite): Promise<boolean> {
    const written = await this.db.computer.updateMany({
      where: {
        id,
        kind: 'managed',
        ...(write.from ? { poolPhase: { in: [...write.from] } } : {}),
        ...(write.activeAt !== undefined ? { poolActiveAt: write.activeAt } : {})
      },
      data: {
        poolPhase: write.phase,
        poolPhaseAt: write.at,
        ...(write.error !== undefined ? { poolError: write.error } : {})
      }
    })
    // A revoked computer stays revoked whatever phase its pod is in.
    if (written.count === 1 && write.status)
      await this.db.computer.updateMany({ where: { id, revokedAt: null }, data: { status: write.status } })
    return written.count === 1
  }

  async touchPoolActive(id: ComputerId, at: Date): Promise<void> {
    await this.db.computer.updateMany({
      where: { id, kind: 'managed', poolPhase: { not: null } },
      data: { poolActiveAt: at }
    })
  }

  async listPool(): Promise<ComputerRecord[]> {
    const rows = await this.db.computer.findMany({
      where: { kind: 'managed', poolPhase: { not: null } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async orgOwnerUserId(orgId: OrgId): Promise<string | null> {
    const owner = await this.db.membership.findFirst({
      where: { orgId, role: 'owner' },
      orderBy: { createdAt: 'asc' },
      select: { userId: true }
    })
    return owner?.userId ?? null
  }
}
