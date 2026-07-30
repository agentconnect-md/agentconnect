/**
 * PgDaemonRepo — `DaemonRepo` over Prisma (design §3.3, §3.14).
 *
 * One of the only modules that imports `@prisma/client` (the repository seam).
 * `upsertOnAuth` bumps the `sessionEpoch` fencing root atomically: Prisma's
 * `{ increment: 1 }` compiles to `SET "sessionEpoch" = "sessionEpoch" + 1` in a
 * single UPDATE, so repeated auth yields strictly increasing, never-reused
 * epochs (§3.1, §3.13). The first auth creates the row at epoch 1.
 */
import type { Prisma, Daemon, User } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  DaemonRepo,
  DaemonRecord,
  AuthReqInput,
  RegisterReqInput,
  DaemonStatus,
  HealthState,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import { DaemonId, OrgId } from '../../domain/ids.js'
import type { Heartbeat, FactsMcpServer } from '@agentconnect.md/protocol'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'

// The daemon row plus its joined creator + last-modifier users — every read that
// feeds `toRecord` carries both joins so the console never needs a second query.
type DaemonWithUsers = Daemon & { createdBy: User | null; lastModifiedBy: User | null }
const withUsers = { createdBy: true, lastModifiedBy: true } as const

function toRecord(d: DaemonWithUsers): DaemonRecord {
  return {
    id: DaemonId(d.id),
    orgId: OrgId(d.orgId),
    host: d.host,
    name: d.name,
    agentVersion: d.agentVersion,
    capabilities: d.capabilities,
    mcpServers: d.mcpServers,
    maxAgents: d.maxAgents,
    sessionEpoch: d.sessionEpoch,
    routingEpoch: d.routingEpoch,
    status: d.status as DaemonStatus,
    health: d.health as HealthState,
    load: d.load,
    activeSessions: d.activeSessions,
    degradedScopes: d.degradedScopes,
    lastSeenAt: d.lastSeenAt,
    unreachableAt: d.unreachableAt,
    createdAt: d.createdAt,
    createdBy: d.createdBy
      ? { userId: d.createdBy.id, displayName: d.createdBy.displayName, email: d.createdBy.email }
      : null,
    createdByUserId: d.createdByUserId,
    ownerUserId: d.ownerUserId,
    visibility: d.visibility,
    sharedWith: d.sharedWith,
    lastModifiedAt: d.lastModifiedAt,
    lastModifiedBy: d.lastModifiedBy
      ? { userId: d.lastModifiedBy.id, displayName: d.lastModifiedBy.displayName, email: d.lastModifiedBy.email }
      : null
  }
}

export class PgDaemonRepo implements DaemonRepo {
  constructor(private readonly db: PrismaLike) {}

  async provision(daemonId: DaemonId, orgId: OrgId, createdByUserId?: string): Promise<DaemonRecord> {
    return withAmbientTx(this.db, async (tx) => {
      await lockResourceWriteMemberships(tx, {
        orgId,
        visibility: 'org',
        actorUserId: createdByUserId,
        ownerUserId: createdByUserId
      })
      const daemon = await tx.daemon.create({
        data: {
          id: daemonId,
          orgId,
          status: 'provisioned', // sessionEpoch defaults to 0 (§4.1)
          // Console-provisioned: the provisioning principal is both creator and
          // first last-modifier (lastModifiedAt defaults to now = createdAt).
          ...(createdByUserId
            ? { createdByUserId, ownerUserId: createdByUserId, lastModifiedByUserId: createdByUserId }
            : {})
        },
        include: withUsers
      })
      return toRecord(daemon)
    })
  }

  async upsertOnAuth(input: AuthReqInput): Promise<{ daemon: DaemonRecord; sessionEpoch: bigint }> {
    const daemon = await this.db.daemon.upsert({
      where: { id: input.daemonId },
      create: {
        id: input.daemonId,
        orgId: input.orgId,
        agentVersion: input.agentVersion,
        machineId: input.machineId,
        tokenFp: input.tokenFp,
        sessionEpoch: 1n, // first successful auth mints epoch 1
        status: 'authenticating'
      },
      update: {
        agentVersion: input.agentVersion,
        machineId: input.machineId,
        tokenFp: input.tokenFp,
        sessionEpoch: { increment: 1n }, // atomic monotonic bump (§3.13)
        status: 'authenticating'
      },
      include: withUsers
    })
    return { daemon: toRecord(daemon), sessionEpoch: daemon.sessionEpoch }
  }

  async applyRegister(daemonId: DaemonId, reg: RegisterReqInput): Promise<DaemonRecord> {
    const daemon = await this.db.daemon.update({
      where: { id: daemonId },
      data: {
        host: reg.host,
        capabilities: reg.capabilities as Prisma.InputJsonValue,
        maxAgents: reg.maxAgents,
        status: 'ready',
        // The `facts/daemon-runtimes.seq` counter is per-connection: reset the
        // fence so the reconnecting daemon's fresh count is accepted from 1.
        runtimesSnapshotSeq: null
      },
      include: withUsers
    })
    // Seed the display name from the reported hostname on the FIRST registration
    // only (name still null). A later register never overwrites it, so the initial
    // seed — and any manual rename after it — sticks across reconnects.
    if (daemon.name === null && reg.host) {
      return toRecord(
        await this.db.daemon.update({ where: { id: daemonId }, data: { name: reg.host }, include: withUsers })
      )
    }
    return toRecord(daemon)
  }

  async setMcpServers(daemonId: DaemonId, servers: FactsMcpServer[]): Promise<void> {
    // Wholesale replace — the frame carries the daemon's full MCP-server list,
    // so an empty array clears every previously reported server.
    await this.db.daemon.update({
      where: { id: daemonId },
      data: { mcpServers: servers as unknown as Prisma.InputJsonValue }
    })
  }

  async touchHeartbeat(daemonId: DaemonId, hb: Heartbeat, at: Date): Promise<void> {
    await this.db.daemon.update({
      where: { id: daemonId },
      data: {
        load: hb.load as Prisma.InputJsonValue,
        health: hb.health,
        activeSessions: hb.activeSessions,
        degradedScopes: hb.degradedScopes,
        lastSeenAt: at
      }
    })
  }

  async markUnreachable(daemonId: DaemonId, at: Date): Promise<void> {
    await this.db.daemon.update({
      where: { id: daemonId },
      data: { status: 'unreachable', unreachableAt: at }
    })
  }

  async rename(daemonId: DaemonId, name: string, byUserId?: string): Promise<DaemonRecord> {
    // A rename is a human edit — advance the last-modified audit (editor stamped
    // when known; absent under devAuth ⇒ leave the prior editor as-is).
    const daemon = await this.db.daemon.update({
      where: { id: daemonId },
      data: { name, lastModifiedAt: new Date(), ...(byUserId ? { lastModifiedByUserId: byUserId } : {}) },
      include: withUsers
    })
    return toRecord(daemon)
  }

  async setSharing(
    daemonId: DaemonId,
    sharing: { visibility: DaemonRecord['visibility']; sharedWith: string[] },
    byUserId?: string
  ): Promise<DaemonRecord> {
    return withAmbientTx(this.db, async (tx) => {
      const existing = await tx.daemon.findUniqueOrThrow({
        where: { id: daemonId },
        select: { orgId: true, ownerUserId: true }
      })
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: existing.orgId,
        visibility: sharing.visibility,
        actorUserId: byUserId,
        ownerUserId: existing.ownerUserId ?? undefined,
        sharedWith: sharing.sharedWith
      })
      // A sharing change is a human edit — advance the last-modified audit
      // (editor stamped when known; absent under devAuth ⇒ leave it unchanged).
      const daemon = await tx.daemon.update({
        where: { id: daemonId },
        data: {
          visibility: sharing.visibility,
          sharedWith: memberships.sharedWith ?? [],
          lastModifiedAt: new Date(),
          ...(byUserId ? { lastModifiedByUserId: byUserId } : {})
        },
        include: withUsers
      })
      return toRecord(daemon)
    })
  }

  async delete(daemonId: DaemonId): Promise<void> {
    // One DELETE; the DB FKs cascade api-keys/leases/launches/runtime-profiles and
    // SET NULL agents/assignments (§3.3). Throws P2025 if absent → 404 at the edge.
    await this.db.daemon.delete({ where: { id: daemonId } })
  }

  async bumpRoutingEpoch(daemonId: DaemonId): Promise<bigint> {
    const d = await this.db.daemon.update({
      where: { id: daemonId },
      data: { routingEpoch: { increment: 1n } }, // atomic monotonic bump (§4.11)
      select: { routingEpoch: true }
    })
    return d.routingEpoch
  }

  async findReassignable(graceSec: number, now: Date): Promise<DaemonRecord[]> {
    const cutoff = new Date(now.getTime() - graceSec * 1000)
    const rows = await this.db.daemon.findMany({
      where: { status: 'unreachable', unreachableAt: { lte: cutoff } },
      include: withUsers
    })
    return rows.map(toRecord)
  }

  async get(daemonId: DaemonId): Promise<DaemonRecord | null> {
    const d = await this.db.daemon.findUnique({ where: { id: daemonId }, include: withUsers })
    return d ? toRecord(d) : null
  }

  async list(orgId?: OrgId, viewer?: ViewCtx): Promise<DaemonRecord[]> {
    const where = { ...(orgId ? { orgId } : {}), ...visibilityWhere(viewer) }
    const rows = await this.db.daemon.findMany({
      ...(Object.keys(where).length ? { where } : {}),
      orderBy: { createdAt: 'asc' },
      include: withUsers
    })
    return rows.map(toRecord)
  }
}
