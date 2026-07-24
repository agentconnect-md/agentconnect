/**
 * `cron/report` handler (dashboard telemetry).
 *
 * A fire-and-forget EVT (no reply). The daemon stamps each CP-owned cron fire
 * into its local store (it stays authoritative, protocol §5.4) and reports it
 * here so the console's `lastRunAt` and run history converge: the FIRE report
 * (no `status`) stamps lastRunAt and opens the run row, an optional SESSION
 * report attaches the deep-link while it is running, and the COMPLETION report
 * closes it with the outcome/duration. The repo write is scoped (the
 * cron's owning agent must be placed on the REPORTING daemon) and latest-wins
 * (the daemon re-asserts stored stamps on reconnect; an older `firedAt` never
 * regresses the value) — so unknown, foreign, and stale reports all drop
 * silently, never error.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { CronId, DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleCronReport: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/report')(frame)) return
  const p = frame.payload
  const firedAt = new Date(p.firedAt)
  if (Number.isNaN(firedAt.getTime())) return
  await deps.cron.recordReport(CronId(p.cronId), DaemonId(conn.daemonId), {
    firedAt,
    ...(p.status ? { status: p.status } : {}),
    ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
    ...(p.reason ? { reason: p.reason } : {})
  })
}
