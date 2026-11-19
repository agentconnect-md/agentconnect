// A likely task's model host started while its coordinator decides, so the task skips the cold start (auto-session-mode.md §4.8).
import { postlessWebchat, type DeliveredMessage } from './coordinator-turns.js'

/** How long a prewarmed host waits for its task after the coordinator's turn ends, for a task dispatch still on its way. */
export const TASK_PREWARM_GRACE_MS = 30_000

/** The most a prewarmed host is kept unclaimed, however long the coordinator's turn runs. */
export const TASK_PREWARM_MAX_MS = 5 * 60_000

/** At most this many hosts are prewarmed for one coordinator turn. */
export const TASK_PREWARMS_PER_TURN = 2

/** Whether a message is likely to become a task: a person's message addressed to the agent — a webchat message, a direct message or a mention — that opens in a thread. */
export function prewarmsTask(message: Pick<DeliveredMessage, 'msg' | 'report' | 'mentionsYou'>): boolean {
  const { msg } = message
  if (message.report || msg.source !== 'user' || postlessWebchat(msg)) return false
  return msg.platform === 'webchat' || msg.isDm === true || message.mentionsYou
}

/** What prewarming needs from its daemon. */
export interface TaskPrewarmHost {
  /** Start the task session's model host; it must settle even when the start fails. */
  start(agentId: string, taskKey: string): Promise<void>
  /** Whether the host may go now: not while a turn of its task owns the key, which uses the host claimed or not. */
  releasable(taskKey: string): boolean
  /** Stop the host and give its credential back. */
  release(taskKey: string): Promise<void>
  warn(message: string): void
}

interface Prewarm {
  coordinatorKey: string
  started: Promise<void>
  timer: ReturnType<typeof setTimeout>
  releasing?: Promise<void>
}

/** The prewarmed task hosts not yet claimed by their task's first turn. */
export class TaskPrewarms {
  private readonly warm = new Map<string, Prewarm>()
  private stopped = false

  constructor(private readonly host: TaskPrewarmHost) {}

  /** Start a host for the task a coordinator turn may open; it is released unless the task claims it. */
  begin(coordinatorKey: string, agentId: string, taskKey: string): void {
    if (this.stopped) return
    const live = this.warm.get(taskKey)
    // A later turn deciding on the same message keeps the host from its predecessor's grace.
    if (live && !live.releasing) {
      clearTimeout(live.timer)
      live.coordinatorKey = coordinatorKey
      live.timer = this.expireIn(taskKey, TASK_PREWARM_MAX_MS)
    }
    if (live) return
    const started = this.host.start(agentId, taskKey).catch(() => undefined)
    this.warm.set(taskKey, { coordinatorKey, started, timer: this.expireIn(taskKey, TASK_PREWARM_MAX_MS) })
  }

  /** The coordinator's turn ended: what it did not hand to a task is released after the grace. */
  turnEnded(coordinatorKey: string): void {
    for (const [taskKey, prewarm] of this.warm) {
      if (prewarm.coordinatorKey !== coordinatorKey || prewarm.releasing) continue
      clearTimeout(prewarm.timer)
      prewarm.timer = this.expireIn(taskKey, TASK_PREWARM_GRACE_MS)
    }
  }

  /** The task's first turn takes the host: wait for its start, or for a release already under way, before the turn asks for one. */
  async claim(taskKey: string): Promise<void> {
    const prewarm = this.warm.get(taskKey)
    if (!prewarm) return
    if (prewarm.releasing) return await prewarm.releasing
    clearTimeout(prewarm.timer)
    this.warm.delete(taskKey)
    await prewarm.started
  }

  /** Cancel the timers and let every start settle, so the pool's release finds each host it made; `final` refuses later prewarms. */
  async stop(final = false): Promise<void> {
    if (final) this.stopped = true
    const pending = [...this.warm.values()]
    for (const prewarm of pending) clearTimeout(prewarm.timer)
    this.warm.clear()
    await Promise.all(pending.map((prewarm) => prewarm.releasing ?? prewarm.started))
  }

  private expireIn(taskKey: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.expire(taskKey), ms)
    timer.unref?.()
    return timer
  }

  private expire(taskKey: string): void {
    const prewarm = this.warm.get(taskKey)
    if (!prewarm || prewarm.releasing) return
    if (!this.host.releasable(taskKey)) {
      prewarm.timer = this.expireIn(taskKey, TASK_PREWARM_GRACE_MS)
      return
    }
    // After its start settles, or the release would find no host and the start would leave one behind.
    prewarm.releasing = prewarm.started
      .then(async () => await this.host.release(taskKey))
      .catch((error: unknown) =>
        this.host.warn(`coordinator: releasing the unclaimed task host ${taskKey} failed: ${String(error)}`)
      )
      .finally(() => {
        if (this.warm.get(taskKey) === prewarm) this.warm.delete(taskKey)
      })
  }
}
