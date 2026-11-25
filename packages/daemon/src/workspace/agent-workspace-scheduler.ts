// Per-agent admission, first come first served: exclusive work runs alone, and up to `sharedLimit` sessions with their own isolation prepare side by side, one preparation per session.

type Kind = 'exclusive' | 'shared'

interface Waiter {
  kind: Kind
  /** The session a shared operation prepares; two of one session never overlap. */
  sessionKey?: string
  start: () => void
}

interface AgentLane {
  queue: Waiter[]
  runningSessions: Set<string>
  runningExclusive: boolean
  /** Settles when the lane has no queued or running work left. */
  idle?: { promise: Promise<void>; resolve: () => void }
}

export class AgentWorkspaceScheduler {
  private readonly lanes = new Map<string, AgentLane>()

  constructor(private readonly sharedLimit: number) {}

  exclusive<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.admit(agentId, 'exclusive', undefined, operation)
  }

  shared<T>(agentId: string, sessionKey: string, operation: () => Promise<T>): Promise<T> {
    return this.admit(agentId, 'shared', sessionKey, operation)
  }

  /** Whether the agent has queued or running workspace work. */
  busy(agentId: string): boolean {
    return this.lanes.has(agentId)
  }

  /** Settles once the agent has no queued or running workspace work. */
  async idle(agentId: string): Promise<void> {
    while (true) {
      const lane = this.lanes.get(agentId)
      if (!lane) return
      lane.idle ??= deferred()
      await lane.idle.promise
    }
  }

  /** Settles once no agent has queued or running workspace work. */
  async allIdle(): Promise<void> {
    while (this.lanes.size > 0) await Promise.all([...this.lanes.keys()].map((agentId) => this.idle(agentId)))
  }

  private admit<T>(
    agentId: string,
    kind: Kind,
    sessionKey: string | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    let lane = this.lanes.get(agentId)
    if (!lane) {
      lane = { queue: [], runningSessions: new Set(), runningExclusive: false }
      this.lanes.set(agentId, lane)
    }
    const admitted = lane
    return new Promise<T>((resolve, reject) => {
      admitted.queue.push({
        kind,
        ...(sessionKey === undefined ? {} : { sessionKey }),
        start: () => {
          if (sessionKey === undefined) admitted.runningExclusive = true
          else admitted.runningSessions.add(sessionKey)
          // Started on the next microtask, as a chained tail would: callers register what they report before the work begins.
          const run = Promise.resolve().then(operation)
          run.then(resolve, reject).finally(() => {
            if (sessionKey === undefined) admitted.runningExclusive = false
            else admitted.runningSessions.delete(sessionKey)
            this.pump(agentId, admitted)
          })
        }
      })
      this.pump(agentId, admitted)
    })
  }

  private pump(agentId: string, lane: AgentLane): void {
    while (lane.queue.length > 0 && !lane.runningExclusive) {
      const next = lane.queue[0]!
      if (next.kind === 'exclusive' && lane.runningSessions.size > 0) break
      if (next.kind === 'shared' && lane.runningSessions.size >= this.sharedLimit) break
      // A session's retry waits for its own stale preparation, which an aborted caller leaves running in the same directory.
      if (next.sessionKey !== undefined && lane.runningSessions.has(next.sessionKey)) break
      lane.queue.shift()
      next.start()
    }
    if (lane.queue.length === 0 && !lane.runningExclusive && lane.runningSessions.size === 0) {
      if (this.lanes.get(agentId) === lane) this.lanes.delete(agentId)
      lane.idle?.resolve()
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
