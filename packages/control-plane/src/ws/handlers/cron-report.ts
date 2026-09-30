// `cron/report` EVT and its acknowledged `cron/report-sync` REQ (protocol §5.4): run history fenced to the daemon serving the cron's agent, latest-wins; unknown, foreign or stale reports drop silently.
import { isFrame, type CronReport } from '@agentconnect.md/protocol'
import { CronId, DaemonId, type OrgId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import type { Handler } from './index.js'

export const handleCronReport: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/report')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) return // no org to fence the reads on — drop, like every other unusable report
  await recordCronReport(frame.payload, orgId, conn, deps)
}

/** Durable variant: a store failure is retryable; an unknown, foreign or stale report is ACKed like a recorded one. */
export const handleCronReportSync: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/report-sync')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  try {
    await recordCronReport(frame.payload, orgId, conn, deps)
    conn.replyTo(frame, 'ack', { ok: true })
  } catch (err) {
    deps.log.error(
      { err, daemonId: conn.daemonId, cronId: frame.payload.cronId },
      'cron/report-sync: report failed to persist'
    )
    conn.sendError(frame.id, 'INTERNAL', 'cron report failed to persist', true)
  }
}

async function recordCronReport(
  p: CronReport,
  orgId: OrgId,
  conn: DaemonConnection,
  deps: DaemonWsDeps
): Promise<void> {
  const firedAt = new Date(p.firedAt)
  if (Number.isNaN(firedAt.getTime())) return
  // The cron's OWN agent, never the frame's claim: `agentId` rides an untrusted daemon payload.
  const cron = await deps.cron.get(orgId, CronId(p.cronId))
  if (!cron?.agentId) return // unknown / orphaned / out-of-org cron — inert by design
  const agent = await deps.agent.get(orgId, cron.agentId)
  if (!agent) return
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  if (!(await resolver.mayAct(agent, DaemonId(conn.daemonId)))) return
  await deps.cron.recordReport(cron.id, {
    firedAt,
    ...(p.status ? { status: p.status } : {}),
    ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
    ...(p.reason ? { reason: p.reason } : {})
  })
}
