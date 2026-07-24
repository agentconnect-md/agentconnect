/**
 * PgAssignmentRepo — the routing table (design §3.7, §3.14).
 *
 * `assign` writes an `active` row; the partial-unique index
 * `assignment_session_active_uq` enforces single-ownership at the storage layer.
 * A unique violation (Prisma P2002) is translated into {@link OwnerConflict} so
 * C3 reacts to a typed, transport-free error. `release` moves a row to
 * `released` (excluded from the index), enabling reassignment under a new epoch.
 */
import { Prisma, type Assignment } from '../../generated/prisma/client.js'
import type { BindRule, Platform } from '@agentconnect.md/protocol'
import type { PrismaLike } from '../prisma.js'
import type { AssignmentRepo, AssignmentRecord, AssignmentState } from '../ports.js'
import { OwnerConflict } from '../errors.js'
import { toDbPlatform } from '../platform.js'
import { AgentId, DaemonId } from '../../domain/ids.js'
import type { SessionKey } from '../../domain/sessionKey.js'

function toRecord(a: Assignment): AssignmentRecord {
  return {
    id: a.id,
    platform: a.platform as Platform,
    channel: a.channel,
    thread: a.thread,
    agentId: AgentId(a.agentId),
    daemonId: a.daemonId ? DaemonId(a.daemonId) : null,
    workspaceId: a.workspaceId,
    assignedEpoch: a.assignedEpoch,
    assignedSeq: a.assignedSeq,
    routingEpoch: a.routingEpoch,
    state: a.state as AssignmentState,
    bindRules: a.bindRules
  }
}

/** The set of states inside the partial-unique predicate (§3.7). */
const ACTIVE_STATES: AssignmentState[] = ['active', 'draining', 'frozen']

export class PgAssignmentRepo implements AssignmentRepo {
  constructor(private readonly db: PrismaLike) {}

  async assign(
    key: SessionKey,
    agentId: AgentId,
    daemonId: DaemonId,
    workspaceId: string,
    epoch: bigint,
    routingEpoch: bigint,
    bindRules: BindRule[] = []
  ): Promise<AssignmentRecord> {
    try {
      const a = await this.db.assignment.create({
        data: {
          platform: toDbPlatform(key.platform),
          channel: key.channel,
          thread: key.thread ?? null,
          agentId,
          daemonId,
          workspaceId,
          assignedEpoch: epoch,
          routingEpoch,
          state: 'active',
          bindRules: bindRules as unknown as Prisma.InputJsonValue
        }
      })
      return toRecord(a)
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new OwnerConflict(key.platform, key.channel, key.thread)
      }
      throw err
    }
  }

  async activeForDaemon(daemonId: DaemonId): Promise<AssignmentRecord[]> {
    const rows = await this.db.assignment.findMany({
      where: { daemonId, state: { in: ACTIVE_STATES } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async ownerOf(key: SessionKey): Promise<AssignmentRecord | null> {
    const row = await this.db.assignment.findFirst({
      where: {
        platform: toDbPlatform(key.platform),
        channel: key.channel,
        threadKey: key.thread ?? '',
        state: { in: ACTIVE_STATES }
      }
    })
    return row ? toRecord(row) : null
  }

  async release(key: SessionKey, at: Date): Promise<void> {
    await this.db.assignment.updateMany({
      where: {
        platform: toDbPlatform(key.platform),
        channel: key.channel,
        threadKey: key.thread ?? '',
        state: { in: ACTIVE_STATES }
      },
      data: { state: 'released', daemonId: null, releasedAt: at }
    })
  }

  async releaseForAgent(agentId: AgentId, daemonId: DaemonId, at: Date): Promise<SessionKey[]> {
    const released = await this.db.assignment.updateManyAndReturn({
      where: { agentId, daemonId, state: { in: ACTIVE_STATES } },
      data: { state: 'released', daemonId: null, releasedAt: at },
      select: { platform: true, channel: true, thread: true }
    })
    return released.map((row) => ({
      platform: row.platform as Platform,
      channel: row.channel,
      ...(row.thread ? { thread: row.thread } : {})
    }))
  }

  async freeze(daemonId: DaemonId): Promise<void> {
    await this.db.assignment.updateMany({
      where: { daemonId, state: { in: ['active', 'draining'] } },
      data: { state: 'frozen' }
    })
  }
}
