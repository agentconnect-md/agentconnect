// Session executors (session-executors.md §6): the registration facts, the two requests a holder sends, and the birth verdict.
import { z } from 'zod'

/** A strategy as `sandbox.backend` names it; a slug rather than an enum, so a later strategy needs no frame revision. */
export const ExecutorStrategyName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
export type ExecutorStrategyName = z.infer<typeof ExecutorStrategyName>

/** Wire mirror of the daemon's `StrategyAvailability`: a strategy this machine can run now, or the reason it cannot. */
export const ExecutorStrategyAvailability = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true) }),
  z.object({ available: z.literal(false), reason: z.string().max(2000) })
])
export type ExecutorStrategyAvailability = z.infer<typeof ExecutorStrategyAvailability>

/** The EFFECTIVE strategy table (§5): what the machine can run, never merely what it is configured to offer. */
export const ExecutorStrategyTable = z.record(ExecutorStrategyName, ExecutorStrategyAvailability)
export type ExecutorStrategyTable = z.infer<typeof ExecutorStrategyTable>

/** Where a holder dials an executor's TLS-PSK listener. */
export const ExecutorEndpoint = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535)
})
export type ExecutorEndpoint = z.infer<typeof ExecutorEndpoint>

/** Process-level executor facts riding `register` and `capabilities/update`; absent whole for a daemon that reports none. */
export const ExecutorFacts = z.object({
  enabled: z.boolean(), // the facet is on: `sandbox.share` is set and the listener is bound
  strategies: ExecutorStrategyTable.optional(),
  endpoint: ExecutorEndpoint.optional(),
  capacity: z.number().int().min(0).optional() // the daemon's `limits.maxConcurrentSessions`
})
export type ExecutorFacts = z.infer<typeof ExecutorFacts>

/** D→C REQ (reply: `executor/candidates/result`): the duty holder asks, at session birth, who in the agent's group could host it. */
export const ExecutorCandidatesReq = z.object({
  agentId: z.string().uuid()
})
export type ExecutorCandidatesReq = z.infer<typeof ExecutorCandidatesReq>

/** Why the answer is empty; `not_holder` is the refusal of an asker that does not hold the agent's duty. */
export const ExecutorCandidatesEmptyReason = z.enum([
  'not_holder',
  'not_on_group',
  'group_switch_off',
  'no_member_shares'
])
export type ExecutorCandidatesEmptyReason = z.infer<typeof ExecutorCandidatesEmptyReason>

/** One connected member of the agent's set whose facet is on. Facts only: the CP ranks and recommends nothing. */
export const ExecutorCandidate = z.object({
  daemonId: z.string().uuid(),
  strategies: ExecutorStrategyTable,
  endpoint: ExecutorEndpoint.optional(),
  capacity: z.number().int().min(0).optional(),
  hostedSessions: z.number().int().min(0).optional(), // latest heartbeat or relayed `liveCount`; absent before the first
  runtimes: z.array(z.object({ runtime: z.string(), authRequired: z.boolean() })) // from the member's `facts/daemon-runtimes`
})
export type ExecutorCandidate = z.infer<typeof ExecutorCandidate>

/** C→D REP to `executor/candidates`. The asker is never listed — it is always its own candidate; `reason` rides an empty list only. */
export const ExecutorCandidatesResult = z.object({
  candidates: z.array(ExecutorCandidate),
  reason: ExecutorCandidatesEmptyReason.optional()
})
export type ExecutorCandidatesResult = z.infer<typeof ExecutorCandidatesResult>

/** D→C REQ, and the same payload C→D once the CP relays it to the executor; both hops reply `executor/prepare/result`. */
export const ExecutorPrepareReq = z.object({
  agentId: z.string().uuid(),
  sessionKey: z.string().min(1).max(1024),
  executorDaemonId: z.string().uuid(),
  generation: z.number().int().positive(), // the launch's binding generation: a resend carries the same one, a new launch a higher one
  strategy: ExecutorStrategyName,
  // The two below matter to the `microsandbox` strategy only.
  resources: z
    .object({
      cpus: z.number().int().positive().optional(),
      memoryMiB: z.number().int().positive().optional(),
      diskGiB: z.number().int().positive().optional()
    })
    .optional(),
  image: z.string().min(1).max(512).optional()
})
export type ExecutorPrepareReq = z.infer<typeof ExecutorPrepareReq>

/** Why nothing was prepared. The first four are the executor's; the rest are the CP's, decided without relaying (`relay_failed`: the executor did not answer in time). */
export const ExecutorPrepareRefusal = z.enum([
  'stale_generation',
  'launch_retired',
  'draining',
  'strategy_unavailable',
  'not_holder',
  'not_on_group',
  'group_switch_off',
  'not_member',
  'facet_off',
  'relay_failed'
])
export type ExecutorPrepareRefusal = z.infer<typeof ExecutorPrepareRefusal>

/** REP to `executor/prepare`. `ready` carries the pipe's pre-shared key — NEVER log or persist this frame. `offline` is the CP's own record of an executor whose control connection is down. */
export const ExecutorPrepareResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    endpoint: ExecutorEndpoint,
    psk: z.string().min(1).max(512),
    runtimeRoot: z.string().min(1).max(4096),
    helperRoot: z.string().min(1).max(4096).optional(), // a `host` executor's own bundle; absent ⇒ the image's default
    missingHelpers: z.array(z.string().min(1).max(64)).optional(), // `shimPaths` keys the executor has nothing at
    liveCount: z.number().int().min(0) // environments live on the executor now, this one included
  }),
  z.object({ status: z.literal('full'), liveCount: z.number().int().min(0).optional() }),
  z.object({ status: z.literal('refused'), reason: ExecutorPrepareRefusal }),
  z.object({ status: z.literal('offline'), lastSeenAt: z.string().datetime().nullable() })
])
export type ExecutorPrepareResult = z.infer<typeof ExecutorPrepareResult>

/** Why a session stayed with its holder (§7). Closed: a value added later is frame-fatal to an older CP, so it ships behind its own feature. */
export const SessionStayedHomeReason = z.enum([
  'not_on_group',
  'group_switch_off',
  'shared_session',
  'memory_daemon_homed',
  'no_candidate',
  'candidates_full',
  'control_plane_unreachable',
  'holder_least_loaded'
])
export type SessionStayedHomeReason = z.infer<typeof SessionStayedHomeReason>
