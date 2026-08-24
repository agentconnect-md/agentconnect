import { z } from 'zod'
import { Platform } from './route.js'

/**
 * Cron sinks to the daemon (D5) — protocol §5.4.
 *
 * A cron periodically triggers ONE AGENT with a synthetic prompt (`trigger`) to
 * carry out some work. The CP owns the definition; the daemon owns firing +
 * last-run persistence, so crons fire even when the CP is down. On receipt the
 * daemon persists the def into the owning agent's `agent.json` `crons[]` (the
 * single source of truth, same model as integrations) — surviving a restart
 * with the CP down.
 *
 * `target` is OPTIONAL output routing: when present, the daemon posts the
 * trigger as a real message in that channel and the agent's session replies in
 * its thread; when absent the fire is headless (the agent works with no
 * platform output).
 */

export const CronTarget = z.object({
  // S1a open reader (route.ts Platform policy). The `'slack'` default is the
  // legacy envelope default §6.8 removes (anchor platform will derive from
  // `integrationId`); it is NOT a fold — a present unknown id passes through.
  platform: Platform.default('slack'),
  channel: z.string(),
  // The agent integration whose connection posts the anchor — targets come from
  // the owning agent's integrations, so the daemon posts through the right bot
  // when the agent has several. Absent (legacy defs) ⇒ first integration.
  integrationId: z.string().uuid().optional()
})
export type CronTarget = z.infer<typeof CronTarget>

export const CronUpsert = z.object({
  orgId: z.string().min(1).max(64).optional(),
  cronId: z.string().uuid(),
  agentId: z.string().uuid(), // the agent this cron drives — routes the def to its daemon
  schedule: z.string(), // croner expression interpreted in `timezone`
  timezone: z.string().min(1), // resolved IANA timezone; daemon converts ticks to UTC instants
  target: CronTarget.optional(), // absent ⇒ headless fire
  trigger: z.string(), // synthetic prompt text injected on fire
  enabled: z.boolean().default(true)
})
export type CronUpsert = z.infer<typeof CronUpsert>

export const CronRemove = z.object({
  cronId: z.string().uuid()
})
export type CronRemove = z.infer<typeof CronRemove>

/**
 * `cron/report` (D→C EVT, fire-and-forget) — one CP-owned cron fired. The
 * daemon stamps the fire into its local store first (it stays authoritative,
 * §5.4) and reports it here so the console's `lastRunAt` converges; the CP
 * upsert is latest-wins, so the daemon re-asserting its stored stamps on
 * reconnect (fires while the CP was unreachable) is idempotent and can never
 * regress the value. Hand-authored (no-origin) crons are never reported.
 *
 * Reports are keyed by `(cronId, firedAt)`: the FIRE report (no `status`)
 * opens the run, an optional SESSION report attaches the ACP session as soon
 * as it is initialized, and the COMPLETION report (with `status` + outcome
 * fields) closes the run once the dispatched turn ends. A completion without
 * a prior fire report (CP was down at fire time) still creates the run row.
 */
export const CronRunStatus = z.enum(['success', 'failed'])
export type CronRunStatus = z.infer<typeof CronRunStatus>

export const CronReport = z.object({
  cronId: z.string().uuid(),
  agentId: z.string().uuid(), // the owning agent — scopes the report to its daemon
  firedAt: z.string().datetime(),
  // Terminal outcome fields (absent on fire/session progress reports).
  status: CronRunStatus.optional(),
  durationMs: z.number().int().nonnegative().optional(), // fire → turn end
  // Sent once the session exists, then repeated on completion.
  sessionId: z.string().optional(), // the session the run prompted, by its outward id (§1.1)
  reason: z.string().optional() // short failure text (status "failed")
})
export type CronReport = z.infer<typeof CronReport>

/**
 * `cron/run` (C→D REQ → ack) — fire one CP-owned cron NOW (console "Run now").
 * The daemon accepts (`ok:true`) and runs the fire asynchronously — outcome
 * arrives as normal `cron/report`s; `ok:false` when it holds no such cron.
 */
export const CronRunNow = z.object({
  cronId: z.string().uuid()
})
export type CronRunNow = z.infer<typeof CronRunNow>
