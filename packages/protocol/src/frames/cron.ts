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
 * `target` is OPTIONAL output routing: when present, the daemon posts an anchor
 * (`name` + fire time, never the `trigger` prompt) in that channel and the
 * agent's session replies in its thread; when absent the fire is headless.
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
  // Console display name; a targeted fire's channel anchor shows it (with the fire time) instead of `trigger`.
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().default(true),
  // The console user its runs read as (assistant-mode.md §5.5): its last human editor, else its creator; absent ⇒ no person.
  askerUserId: z.string().min(1).max(256).optional()
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

/** CP accepts `cron/report-sync`, the acknowledged form of a terminal `cron/report`; without it a daemon sends the EVT. */
export const CRON_REPORT_ACK_FEATURE = 'cron-report-ack-v1'

/**
 * `cron/run` (C→D REQ → ack) — fire one CP-owned cron NOW (console "Run now").
 * The daemon accepts (`ok:true`) and runs the fire asynchronously — outcome
 * arrives as normal `cron/report`s; `ok:false` when it holds no such cron.
 */
export const CronRunNow = z.object({
  cronId: z.string().uuid()
})
export type CronRunNow = z.infer<typeof CronRunNow>

/** CP serves `cron/self`: an agent lists, saves and deletes the crons bound to it, with no person's approval. */
export const AGENT_CRON_TOOLS_FEATURE = 'agent-cron-tools-v1'

/** A one-shot schedule is a croner ISO wall-clock datetime in the cron's timezone; it fires once and the CP deletes it after its run. */
export const ONE_SHOT_SCHEDULE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/

/** Whether a stored schedule fires once rather than repeating. */
export function isOneShotSchedule(schedule: string): boolean {
  return ONE_SHOT_SCHEDULE.test(schedule)
}

/** One cron bound to the asking agent, as its tools show it. */
export const AgentCronView = z.object({
  cronId: z.string().uuid(),
  name: z.string().nullable(),
  schedule: z.string(),
  timezone: z.string(),
  once: z.boolean(),
  trigger: z.string(),
  enabled: z.boolean(),
  target: z.object({ platform: z.string(), channel: z.string(), integrationId: z.string().nullable() }).nullable(),
  lastRunAt: z.string().datetime().nullable()
})
export type AgentCronView = z.infer<typeof AgentCronView>

/** What the agent saves: `cronId` edits one bound to it, absent creates; exactly one of a recurring `schedule` or a one-shot `runAt`. */
export const AgentCronSave = z.object({
  cronId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  schedule: z.string().min(1).max(200).optional(),
  // An ISO-8601 instant with an offset; the CP stores it as the wall-clock time in `timezone`.
  runAt: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().min(1).max(100),
  trigger: z.string().min(1).max(20_000),
  enabled: z.boolean().optional(),
  // A channel of one of the agent's integrations to post each run into; null makes it headless, absent keeps an edited cron's.
  target: z
    .object({ integrationId: z.string().uuid(), channel: z.string().min(1).max(200) })
    .nullable()
    .optional()
})
export type AgentCronSave = z.infer<typeof AgentCronSave>

/** D→C REQ, `cron/self`: the agent's own cron operation, sent by the daemon that serves it. */
export const AgentCronReq = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), agentId: z.string().uuid() }),
  z.object({ op: z.literal('save'), agentId: z.string().uuid(), cron: AgentCronSave }),
  z.object({ op: z.literal('delete'), agentId: z.string().uuid(), cronId: z.string().uuid() })
])
export type AgentCronReq = z.infer<typeof AgentCronReq>

/** C→D REP to `cron/self`: the crons after a list, the saved one, or why it was refused. */
export const AgentCronResult = z.object({
  status: z.enum(['ok', 'refused']),
  crons: z.array(AgentCronView).optional(),
  cron: AgentCronView.optional(),
  message: z.string().max(500).optional()
})
export type AgentCronResult = z.infer<typeof AgentCronResult>
