import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'

// Cap per-session `!queue` depth so a hung turn or a user spamming `!queue` can't
// grow `queued` without bound. Past the cap we reject with a clear message.
export const MAX_QUEUED_PER_SESSION = 10
export const MAX_TURN_CONTEXT_REGENERATIONS = 3
/** How many absorbed transcript `ts` values one session key remembers — enough to cover every
 *  activation still travelling to the gate while a turn folds context, and no more. */
export const ABSORBED_CONTEXT_TS_MEMORY = 64
export const MAX_TURN_CONTEXT_REGENERATION_MS = 120_000

/** Bounded hard-stop for an isolated model pass (a dream extraction, a commit-message draft) whose
 *  runtime ignores `session/cancel`: how long after the abort the daemon stops awaiting
 *  `host.prompt` and discards the isolated ACP session, rather than wedging forever. The dream
 *  runner's own grace window (DreamRunnerDeps.cancelGraceMs) releases the reservation independently. */
export const CANCEL_FORCE_MS = 15_000

/** How often the idle sweep also reclaims abandoned probe temp roots. One disposable
 *  probe can materialize gigabytes of package caches, so PID-tagged roots whose owner
 *  has finished or exited should not wait behind the slower maintenance cadences. */
export const PROBE_ROOT_SWEEP_INTERVAL_MS = 60_000

/** How often the idle sweep also runs session-retention GC (#485). The retention
 *  window is measured in days, so an hourly pass is plenty — each pass walks the
 *  expired rows and may run several git commands per candidate. */
export const SESSION_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000

/** Receipts per `event/session-purged` frame. Matches the protocol schema's cap,
 *  which sits far under the frame budget (a batch of ACP ids is tiny). */
export const MAX_SESSION_PURGE_BATCH = 200

/** Backoff after a session-metadata persistence failure while the socket remains READY. */
export const SESSION_METADATA_RETRY_MS = 5_000
export const SESSION_METADATA_FAILURES_BEFORE_DEFER = 5
export const SESSION_METADATA_DEFER_MS = 5 * 60_000
// A snapshot this member cannot scope waits this long before it is offered again.
export const SESSION_METADATA_PARK_MS = 60_000

// §9.1 text-buffer: flush buffered agent body after this much streaming idle.
export const IDLE_FLUSH_MS = 2000
/** CardKit updates are cumulative and rate-limited. Sampling the converger at this
 * cadence streams visibly without queuing one HTTP request per model token. */
export const FEISHU_STREAM_FLUSH_MS = 350

/** Local Web App console origin used for session deep links when neither a local
 *  `webAppUrl` config nor a CP-provided one is set. */
export const DEFAULT_WEB_APP_URL = 'http://localhost:3000'

// Cap on agent→agent hop depth (design §2.4/§4.5) — reject a `messageAgent` whose
// outgoing hopCount reaches this boundary, so an A↔B wake loop can't run away.
// send-message-routing-rework.md §4.1 puts a platform `@mention` delivery on this SAME
// budget, which is why the constant is shared with the relay rather than redeclared here.
export const AGENT_CALL_HOP_LIMIT_NOTICE = `Agent conversation stopped after reaching the ${MAX_AGENT_CALL_HOPS}-hop limit.`

/** Poll interval for the deferred background-task wake (background-task-aware-reclaim.md
 *  §5.1). Claude re-enters a `running` cycle of its own to drain a settled task; the wake
 *  waits that cycle out rather than firing into it, because a turn injected mid-cycle would
 *  race the runtime's own work. It does NOT stand down for it — that cycle carries no
 *  `Pending`, so everything it emits is dropped at `onAcpUpdate` and the user sees nothing. */
export const BG_TASK_WAKE_GRACE_MS = 4_000

/** How many times the wake may re-arm while the runtime's self-drain cycle is still
 *  `running` (≈1 minute at {@link BG_TASK_WAKE_GRACE_MS}). A cycle that never returns to
 *  `idle` is either a genuinely long piece of work — which will produce its own turn-end —
 *  or a wedged runtime; either way, stop re-arming instead of polling forever. */
export const MAX_BG_TASK_WAKE_REARMS = 15

/** Per-session budget for background-task wakes. Unlike an agent call these carry no
 *  hopCount to bound, and a woken turn may spawn further background tasks, so the
 *  budget is the only backstop against a self-feeding wake loop. Counted over the
 *  lease's life (i.e. until the host is reclaimed), not per turn. */
export const MAX_BG_TASK_WAKES_PER_SESSION = 20

/** How many SETTLED background tasks one lease retains for the console's `task/list` read. The
 *  daemon keeps no task history anywhere else, so without this a finished task is unshowable;
 *  with it, a `done`/`failed` row survives until the 21st task settles, the session TTL-closes
 *  or the host is reclaimed. 20 is a display depth, not a durability promise — the panel is a
 *  live view, and the retained records are strictly outside the liveness set (see `settled`). */
export const MAX_SETTLED_TASKS_PER_SESSION = 20
