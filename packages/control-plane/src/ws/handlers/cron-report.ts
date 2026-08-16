/**
 * `cron/report` handler (dashboard telemetry).
 *
 * A fire-and-forget EVT (no reply). The daemon stamps each CP-owned cron fire
 * into its local store (it stays authoritative, protocol §5.4) and reports it
 * here so the console's `lastRunAt` and run history converge: the FIRE report
 * (no `status`) stamps lastRunAt and opens the run row, an optional SESSION
 * report attaches the deep-link while it is running, and the COMPLETION report
 * closes it with the outcome/duration. The write is fenced on the LIVE seam
 * (the reporting daemon must serve the cron's agent — its placement, or a duty
 * it holds) and latest-wins (the daemon re-asserts stored stamps on reconnect;
 * an older `firedAt` never regresses the value) — so unknown, foreign, and
 * stale reports all drop silently, never error.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { CronId, DaemonId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { Handler } from './index.js'

export const handleCronReport: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/report')(frame)) return
  const p = frame.payload
  const firedAt = new Date(p.firedAt)
  if (Number.isNaN(firedAt.getTime())) return
  // The cron's OWN agent, never the frame's claim: `agentId` rides an untrusted daemon payload.
  const cron = await deps.cron.getUnscoped(CronId(p.cronId))
  if (!cron?.agentId) return // unknown / orphaned cron — inert by design
  const agent = await deps.agent.getUnscoped(cron.agentId)
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
