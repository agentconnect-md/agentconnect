import { z } from 'zod'

/**
 * Agent background tasks (C→D REQ → REP) — the console Tasks panel's on-demand read.
 *
 * The CP stores NO task data: descriptions are model-authored strings and states live only
 * in the owning daemon's in-memory background-task lease, pulled live and proxied, never
 * persisted (body-locality — webchat-side-panels.md §2).
 *
 * Scoped per (agent, session) because the lease already is: ACP session ids are
 * runtime-local, so two agents can each expose an `acp-1`
 * (background-task-aware-reclaim.md §3).
 *
 * `task/list` is the ONLY frame here. There is deliberately no `task/cancel`: the single
 * cancellation primitive an ACP runtime exposes is `session/cancel`, whose payload is
 * `{ sessionId }` — it cancels a whole prompt turn, and the only hard stop is killing the
 * agent's shared adapter process. Neither can address one background task, so a per-task
 * cancel could only report a cancellation it did not perform or silently cancel unrelated
 * work. It becomes possible when a task-addressed cancel exists upstream.
 */

/** Machine-readable `reason` on a task `BAD_PAYLOAD` error frame's `details`, so the CP can
 * answer with a status and a code the console can branch on instead of the 503 that reads as
 * an offline daemon. Everything else about tasks is DATA: an untracked session, a session
 * with no tasks and a runtime that reports none are all normal answers. */
export const TaskErrorReason = z.enum([
  'unknown-agent' // no such agent on this daemon
])
export type TaskErrorReason = z.infer<typeof TaskErrorReason>

/** Tasks per REP. The lease holds every live task plus a bounded settled history, so this is a
 * display ceiling rather than a pagination cursor — a panel showing 50 rows is already past
 * useful, and `truncated` says the daemon had more. */
export const MAX_TASK_LIST_TASKS = 50

/** Display ceiling for one task's description. Model-authored, so it is bounded on the wire
 * rather than trusted; the daemon truncates rather than dropping the row. */
export const MAX_TASK_DESCRIPTION = 500

/** Display ceiling for the `detail` line beside a settled task. */
export const MAX_TASK_DETAIL = 200

/**
 * What the daemon can actually know about a task, and nothing more.
 *
 * - `running` — the task is in the lease's live set, i.e. it is the thing fencing host reclaim.
 * - `done` — the task settled and no terminal edge reported a failure.
 * - `failed` — a terminal edge reported `failed` or `killed`.
 *
 * There is NO `queued`: the SDK lifecycle feed's only start signal is `task_started`, so a task
 * is either live in the lease or gone. Most settle edges (the authoritative snapshot, and
 * `task_notification`) carry no status at all, which is why `done` means "settled without a
 * reported failure" rather than "reported successful"; `detail` carries the reported status
 * when there was one.
 */
export const TaskState = z.enum(['running', 'done', 'failed'])
export type TaskState = z.infer<typeof TaskState>

/** C→D REQ: the background tasks of ONE session of one agent. */
export const TaskListReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  /** The session's outward id (§1.1) — the console asks by what it routed on, and the daemon
   *  resolves the runtime-scoped lease behind it. Required: a lease has no meaning without one. */
  sessionId: z.string().min(1)
})
export type TaskListReq = z.infer<typeof TaskListReq>

/** One background task. `subagent` is the runtime's own internal Task/subagent invocation: it
 *  is carried rather than filtered out, because the same records are what fence host reclaim —
 *  a panel that hid them at the SOURCE would show "no tasks" beside a host refusing to be
 *  reclaimed. Consumers filter at RENDER. */
export const TaskEntry = z.object({
  id: z.string(), // runtime-local task id
  description: z.string().max(MAX_TASK_DESCRIPTION).optional(), // absent when the runtime omitted it
  state: TaskState,
  subagent: z.boolean(),
  startedAt: z.string(), // RFC3339, from the `task_started` edge
  endedAt: z.string().optional(), // RFC3339; present iff the task settled
  detail: z.string().max(MAX_TASK_DETAIL).optional() // the terminal status the runtime reported, when any
})
export type TaskEntry = z.infer<typeof TaskEntry>

/** D→C REP (corr = the req id): live tasks newest-first, then the retained settled ones
 *  newest-first. `tracked:false` means this daemon holds no lease for the session — a
 *  non-Claude runtime, an adapter without the lifecycle extension, or a session that has not
 *  emitted an accepted lifecycle event yet. That is a different statement from "this session
 *  has no background tasks", and the console says so. */
export const TaskList = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  tracked: z.boolean(),
  tasks: z.array(TaskEntry).max(MAX_TASK_LIST_TASKS),
  truncated: z.boolean() // true ⇒ the daemon held more tasks than this REP carries
})
export type TaskList = z.infer<typeof TaskList>
