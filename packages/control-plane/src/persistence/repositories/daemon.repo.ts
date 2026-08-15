/**
 * PgDaemonRepo — `DaemonRepo` over Prisma (design §3.3, §3.14).
 *
 * One of the only modules that imports `@prisma/client` (the repository seam).
 * `upsertOnAuth` bumps the `sessionEpoch` fencing root atomically: Prisma's
 * `{ increment: 1 }` compiles to `SET "sessionEpoch" = "sessionEpoch" + 1` in a
 * single UPDATE, so repeated auth yields strictly increasing, never-reused
 * epochs (§3.1, §3.13). The first auth creates the row at epoch 1.
 */
import { randomUUID } from 'node:crypto'
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
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { lockAgentPlacement, settleCascadedUnplacement } from './agent-placement.js'
import { enrollDaemonInSet } from './member-set.repo.js'
import type { Heartbeat, FactsMcpServer } from '@agentconnect.md/protocol'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'

// The daemon row plus its joined creator + last-modifier users — every read that
// feeds `toRecord` carries both joins so the console never needs a second query.
type DaemonWithUsers = Daemon & { createdBy: User | null; lastModifiedBy: User | null }
const withUsers = { createdBy: true, lastModifiedBy: true } as const

function toRecord(d: DaemonWithUsers): DaemonRecord {
  return {
    id: DaemonId(d.id),
    orgId: d.orgId ? OrgId(d.orgId) : null,
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
    visibility: d.visibility,
    sharedWith: d.sharedWith,
    sessionRetention: d.sessionRetention,
    lastModifiedAt: d.lastModifiedAt,
    lastModifiedBy: d.lastModifiedBy
      ? { userId: d.lastModifiedBy.id, displayName: d.lastModifiedBy.displayName, email: d.lastModifiedBy.email }
      : null
  }
}

// What an install-wide pool member is, as a where-clause: org-less, cluster-reviewed, and
// bound to one Pod UID. An envelope daemon carries an identity but no Pod, so it never matches.
const POOL_MEMBER_WHERE = { orgId: null, clusterIdentity: { not: null }, clusterPodUid: { not: null } } as const

/** ONE definition of "retired", shared by the worklist read and the delete that acts on it: a
 *  claim fenced on a different predicate than the one that selected the row is not a claim.
 *  A row that never heartbeated is judged by its own age — `lastSeenAt` stays null for a Pod
 *  that authenticated and died before its first beat. */
function retiredPoolMemberWhere(cutoff: Date) {
  return {
    ...POOL_MEMBER_WHERE,
    OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null, createdAt: { lt: cutoff } }]
  }
}

export class PgDaemonRepo implements DaemonRepo {
  constructor(private readonly db: PrismaLike) {}

  async provision(daemonId: DaemonId, orgId: OrgId, createdByUserId?: string): Promise<DaemonRecord> {
    return withAmbientTx(this.db, async (tx) => {
      await lockResourceWriteMemberships(tx, {
        orgId,
        visibility: 'org',
        actorUserId: createdByUserId
      })
      const daemon = await tx.daemon.create({
        data: {
          id: daemonId,
          orgId,
          status: 'provisioned', // sessionEpoch defaults to 0 (§4.1)
          // Console-provisioned: the provisioning principal is both creator and
          // first last-modifier (lastModifiedAt defaults to now = createdAt).
          ...(createdByUserId ? { createdByUserId, lastModifiedByUserId: createdByUserId } : {})
        },
        include: withUsers
      })
      return toRecord(daemon)
    })
  }

  async resolveClusterIdentity(
    orgId: OrgId,
    clusterIdentity: string,
    opts: { adoptDaemonId?: string } = {}
  ): Promise<DaemonRecord | null> {
    const existing = await this.db.daemon.findFirst({
      where: { clusterIdentity, clusterPodUid: null },
      include: withUsers
    })
    if (existing) return existing.orgId === orgId ? toRecord(existing) : null
    const adopted = opts.adoptDaemonId ? await this.adoptForIdentity(orgId, clusterIdentity, opts.adoptDaemonId) : null
    if (adopted) return adopted
    try {
      return await withAmbientTx(this.db, async (tx) => {
        await lockResourceWriteMemberships(tx, { orgId, visibility: 'org' })
        const daemon = await tx.daemon.create({
          data: { id: randomUUID(), orgId, clusterIdentity, status: 'provisioned' },
          include: withUsers
        })
        return toRecord(daemon)
      })
    } catch (error) {
      // A concurrent first connect won the unique index; its row is the binding.
      if ((error as { code?: string }).code !== 'P2002') throw error
      const raced = await this.db.daemon.findFirst({
        where: { clusterIdentity, clusterPodUid: null },
        include: withUsers
      })
      if (!raced) throw error
      return raced.orgId === orgId ? toRecord(raced) : null
    }
  }

  async resolvePoolClusterIdentity(clusterIdentity: string, clusterPodUid: string): Promise<DaemonRecord> {
    const where = { clusterIdentity_clusterPodUid: { clusterIdentity, clusterPodUid } }
    const existing = await this.db.daemon.findUnique({ where, include: withUsers })
    if (existing) return toRecord(existing)
    try {
      const daemon = await this.db.daemon.create({
        data: { id: randomUUID(), orgId: null, clusterIdentity, clusterPodUid, status: 'provisioned' },
        include: withUsers
      })
      return toRecord(daemon)
    } catch (error) {
      // A concurrent connection from the same Pod won the compound unique index.
      if ((error as { code?: string }).code !== 'P2002') throw error
      const raced = await this.db.daemon.findUnique({ where, include: withUsers })
      if (!raced) throw error
      return toRecord(raced)
    }
  }

  async findClusterIdentity(daemonId: DaemonId): Promise<{ orgId: string | null; clusterIdentity: string } | null> {
    const row = await this.db.daemon.findUnique({
      where: { id: daemonId },
      select: { orgId: true, clusterIdentity: true }
    })
    return row?.clusterIdentity ? { orgId: row.orgId, clusterIdentity: row.clusterIdentity } : null
  }

  async clusterBoundIds(orgId: OrgId): Promise<string[]> {
    const rows = await this.db.daemon.findMany({
      where: { orgId, clusterIdentity: { not: null } },
      select: { id: true }
    })
    return rows.map((row) => row.id)
  }

  /** Bind an envelope's existing daemon record — the one the API-key path pinned — to the
   *  identity now authenticating for it, so an org provisioned before the token path keeps
   *  its placements and history instead of gaining a second record beside them. Conditional
   *  on the row being this org's and still unbound; anything else falls through to a create. */
  private async adoptForIdentity(
    orgId: OrgId,
    clusterIdentity: string,
    daemonId: string
  ): Promise<DaemonRecord | null> {
    try {
      const claimed = await this.db.daemon.updateMany({
        where: { id: daemonId, orgId, clusterIdentity: null },
        data: { clusterIdentity }
      })
      if (claimed.count !== 1) return null
    } catch (error) {
      // Another identity claimed this record first; it is not this envelope's to adopt.
      if ((error as { code?: string }).code !== 'P2002') throw error
      return null
    }
    const daemon = await this.db.daemon.findUnique({ where: { id: daemonId }, include: withUsers })
    return daemon ? toRecord(daemon) : null
  }

  async upsertOnAuth(input: AuthReqInput): Promise<{ daemon: DaemonRecord; sessionEpoch: bigint }> {
    return withAmbientTx(this.db, async (tx) => {
      const daemon = await tx.daemon.upsert({
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
      // Pool membership stays AUTOMATIC (daemon-groups.md §6): an org-less row is a member of the
      // org-less set, enrolled in the same transaction that mints it. An org-scoped row is never
      // auto-enrolled anywhere — its set is an operator decision.
      if (daemon.orgId === null) {
        const pool = await tx.memberSet.findFirst({ where: { orgId: null }, select: { id: true } })
        if (pool) await enrollDaemonInSet(tx, pool.id, daemon.id)
      }
      return { daemon: toRecord(daemon), sessionEpoch: daemon.sessionEpoch }
    })
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

  async setCapabilities(daemonId: DaemonId, capabilities: RegisterReqInput['capabilities']): Promise<void> {
    await this.db.daemon.update({
      where: { id: daemonId },
      data: { capabilities: capabilities as Prisma.InputJsonValue }
    })
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

  async rename(orgId: OrgId, daemonId: DaemonId, name: string, byUserId?: string): Promise<DaemonRecord> {
    // A rename is a human edit — advance the last-modified audit (editor stamped
    // when known; absent under devAuth ⇒ leave the prior editor as-is).
    // The org filter rides the unique update (extended where): a cross-org id
    // throws the same P2025 as a missing row (org-scoped-data-layer.md §3).
    const daemon = await this.db.daemon.update({
      where: { id: daemonId, orgId },
      data: { name, lastModifiedAt: new Date(), ...(byUserId ? { lastModifiedByUserId: byUserId } : {}) },
      include: withUsers
    })
    return toRecord(daemon)
  }

  async setSessionRetention(
    orgId: OrgId,
    daemonId: DaemonId,
    sessionRetention: string,
    byUserId?: string
  ): Promise<DaemonRecord> {
    // A retention change is a human edit — advance the last-modified audit
    // (editor stamped when known; absent under devAuth ⇒ leave the prior editor).
    // Org-fenced on the update, like `rename`.
    const daemon = await this.db.daemon.update({
      where: { id: daemonId, orgId },
      data: { sessionRetention, lastModifiedAt: new Date(), ...(byUserId ? { lastModifiedByUserId: byUserId } : {}) },
      include: withUsers
    })
    return toRecord(daemon)
  }

  async setSharing(
    orgId: OrgId,
    daemonId: DaemonId,
    sharing: { visibility: DaemonRecord['visibility']; sharedWith: string[] },
    byUserId?: string
  ): Promise<DaemonRecord> {
    return withAmbientTx(this.db, async (tx) => {
      // Org fence on the opening read: a cross-org id throws the same P2025 as
      // a missing row, before the membership lock or any write.
      const existing = await tx.daemon.findUniqueOrThrow({
        where: { id: daemonId, orgId },
        select: { orgId: true }
      })
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: OrgId(existing.orgId!),
        visibility: sharing.visibility,
        actorUserId: byUserId,
        sharedWith: sharing.sharedWith
      })
      // A sharing change is a human edit — advance the last-modified audit
      // (editor stamped when known; absent under devAuth ⇒ leave it unchanged).
      const daemon = await tx.daemon.update({
        where: { id: daemonId, orgId },
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

  async delete(orgId: OrgId, daemonId: DaemonId): Promise<void> {
    // One DELETE; the DB FKs cascade api-keys/leases/launches/runtime-profiles and
    // SET NULL agents/assignments (§3.3). Throws P2025 if absent → 404 at the edge;
    // the org fence rides the same statement, so a cross-org id is refused with
    // exactly that error (org-scoped-data-layer.md §3).
    await this.db.daemon.delete({ where: { id: daemonId, orgId } })
  }

  /** The org-less pool shape rides every clause, so neither the worklist nor the delete can
   *  name an org's own daemon. A member still inside the window is left alone even if its Pod
   *  is long gone: only silence past `cutoff` retires a row. */
  async findRetiredPoolMembers(cutoff: Date): Promise<DaemonRecord[]> {
    const rows = await this.db.daemon.findMany({
      where: retiredPoolMemberWhere(cutoff),
      orderBy: { createdAt: 'asc' },
      include: withUsers
    })
    return rows.map(toRecord)
  }

  /**
   * Retire one pool member: the fenced delete AND the settlement of every agent it hosted,
   * in ONE transaction. Split across two commits, a process exit or a transient failure in
   * between would strand agents at `daemonId = null` with `status = 'active'` — nowhere to
   * run, live delegations, stale hook revisions — with no durable work item to retry from.
   *
   * The whole fence rides the DELETE statement, so this is a compare-and-delete and not a
   * delete that trusts an earlier read: still an org-less pool member, still silent past the
   * same cutoff the worklist selected on, still at the `sessionEpoch` it saw there. The epoch
   * is what makes it airtight — `upsertOnAuth` bumps it atomically on every (re)auth, while
   * `lastSeenAt` only moves on the first heartbeat AFTER one, so a member that just came back
   * is fresh by epoch before it is fresh by clock. A refused claim rolls back reads only.
   *
   * The agents are locked BEFORE the daemon row, matching the placement path's Agent → Daemon
   * order (`agent-placement.ts`), so a concurrent move cannot deadlock against this.
   */
  async retirePoolMember(
    daemonId: DaemonId,
    fence: { retiredBefore: Date; sessionEpoch: bigint }
  ): Promise<{ deleted: boolean; settled: { id: AgentId; orgId: OrgId }[] }> {
    return withAmbientTx(
      this.db,
      async (tx) => {
        // Read + lock before the delete: the FK is SetNull, so the cascade erases the only
        // record of which agents this member hosted.
        const placed = await tx.agent.findMany({
          where: { daemonId },
          select: { id: true, orgId: true },
          orderBy: { id: 'asc' } // one lock order for every concurrent retirement
        })
        for (const agent of placed) await lockAgentPlacement(tx, agent.id)
        const { count } = await tx.daemon.deleteMany({
          where: { id: daemonId, sessionEpoch: fence.sessionEpoch, ...retiredPoolMemberWhere(fence.retiredBefore) }
        })
        if (count !== 1) return { deleted: false, settled: [] }
        const settled: { id: AgentId; orgId: OrgId }[] = []
        for (const agent of placed) {
          if (await settleCascadedUnplacement(tx, agent.id))
            settled.push({ id: AgentId(agent.id), orgId: OrgId(agent.orgId) })
        }
        return { deleted: true, settled }
      },
      // How many agents a member hosts is not bounded by anything here, and the whole point is
      // that they settle with the delete — so the budget is the sweep's, not Prisma's 5s default.
      { timeout: 30_000 }
    )
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

  async get(orgId: OrgId, daemonId: DaemonId): Promise<DaemonRecord | null> {
    const d = await this.db.daemon.findUnique({ where: { id: daemonId, orgId }, include: withUsers })
    return d ? toRecord(d) : null
  }

  async getAvailable(orgId: OrgId, daemonId: DaemonId): Promise<DaemonRecord | null> {
    const d = await this.db.daemon.findFirst({
      where: { id: daemonId, OR: [{ orgId }, { orgId: null, clusterIdentity: { not: null } }] },
      include: withUsers
    })
    return d ? toRecord(d) : null
  }

  async getUnscoped(daemonId: DaemonId): Promise<DaemonRecord | null> {
    const d = await this.db.daemon.findUnique({ where: { id: daemonId }, include: withUsers })
    return d ? toRecord(d) : null
  }

  async list(orgId?: OrgId, viewer?: ViewCtx): Promise<DaemonRecord[]> {
    const visibility = visibilityWhere(viewer)
    const where = orgId ? { orgId, ...visibility } : visibility
    const rows = await this.db.daemon.findMany({
      ...(Object.keys(where).length ? { where } : {}),
      orderBy: { createdAt: 'asc' },
      include: withUsers
    })
    return rows.map(toRecord)
  }

  async listAvailable(orgId: OrgId, viewer?: ViewCtx): Promise<DaemonRecord[]> {
    const visibility = visibilityWhere(viewer)
    const rows = await this.db.daemon.findMany({
      where: {
        OR: [
          { orgId, ...visibility },
          { orgId: null, clusterIdentity: { not: null } }
        ]
      },
      orderBy: { createdAt: 'asc' },
      include: withUsers
    })
    return rows.map(toRecord)
  }
}
