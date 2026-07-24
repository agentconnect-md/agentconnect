/**
 * PgLaunchRepo — launch fencing & per-agent launch tracking (design §3.9, §3.14).
 *
 * One row per running agent instance. `record` persists the `launchId` fence and
 * the active-capability pin under the `sessionEpoch` it was issued. `currentLaunch`
 * returns the most recent live launch for an agent — the value the ControlSender
 * stamps on agent-scoped frames so an old launchId is rejected `STALE_LAUNCH` (§4.8).
 */
import type { AgentLaunch } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { LaunchRepo, LaunchRecord, RecordLaunchInput, LaunchMode, LaunchStatus } from '../ports.js'
import { AgentId, DaemonId, LaunchId } from '../../domain/ids.js'

function toRecord(l: AgentLaunch): LaunchRecord {
  return {
    id: LaunchId(l.id),
    agentId: AgentId(l.agentId),
    daemonId: DaemonId(l.daemonId),
    runtime: l.runtime,
    mode: l.mode as LaunchMode,
    acpSessionId: l.acpSessionId,
    status: l.status as LaunchStatus,
    launchEpoch: l.launchEpoch
  }
}

export class PgLaunchRepo implements LaunchRepo {
  constructor(private readonly db: PrismaLike) {}

  async record(input: RecordLaunchInput): Promise<LaunchRecord> {
    const l = await this.db.agentLaunch.create({
      data: {
        id: input.launchId,
        agentId: input.agentId,
        daemonId: input.daemonId,
        runtime: input.runtime,
        acpSessionId: input.acpSessionId,
        activeCapabilities: input.activeCapabilities ?? [],
        mode: input.mode ?? 'long_lived',
        launchEpoch: input.epoch,
        status: 'running',
        startedAt: input.startedAt ?? new Date()
      }
    })
    return toRecord(l)
  }

  async currentLaunch(agentId: AgentId): Promise<LaunchId | undefined> {
    const l = await this.db.agentLaunch.findFirst({
      where: { agentId, status: { in: ['launching', 'running'] } },
      orderBy: { createdAt: 'desc' }
    })
    return l ? LaunchId(l.id) : undefined
  }

  async markStopped(launchId: LaunchId, status: 'stopped' | 'crashed', at: Date): Promise<void> {
    await this.db.agentLaunch.update({
      where: { id: launchId },
      data: { status, stoppedAt: at }
    })
  }
}
