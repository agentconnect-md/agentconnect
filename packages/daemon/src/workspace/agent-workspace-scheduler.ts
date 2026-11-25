// Who may touch an agent's workspace at once. Work on the agent's own roots or authority (a reconciled generation, a
// prefetch, a rename, a published file, a shared-isolation session) is exclusive: it waits for everything admitted before
// it and holds off everything after it. A session with its own isolation prepares in its own directory, so up to
// `sharedLimit` of those run side by side; the agent roots they start from are guarded inside the workspace manager.
// Admission is first come, first served: a session queued behind an exclusive operation waits for it, so a reconciled
// generation is never overtaken by stale work.

type Kind = 'exclusive' | 'shared'

interface Waiter {
  kind: Kind
  start: () => void
}

interface AgentLane {
  queue: Waiter[]
  runningShared: number
  runningExclusive: boolean
  /** Settles when the lane has no queued or running work left. */
  idle?: { promise: Promise<void>; resolve: () => void }
}

export class AgentWorkspaceScheduler {
  private readonly lanes = new Map<string, AgentLane>()

  constructor(private readonly sharedLimit: number) {}

  exclusive<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.admit(agentId, 'exclusive', operation)
  }

  shared<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.admit(agentId, 'shared', operation)
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

  private admit<T>(agentId: string, kind: Kind, operation: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(agentId)
    if (!lane) {
      lane = { queue: [], runningShared: 0, runningExclusive: false }
      this.lanes.set(agentId, lane)
    }
    const admitted = lane
    return new Promise<T>((resolve, reject) => {
      admitted.queue.push({
        kind,
        start: () => {
          if (kind === 'exclusive') admitted.runningExclusive = true
          else admitted.runningShared += 1
          // Started on the next microtask, as a chained tail would: callers register what they report before the work begins.
          const run = Promise.resolve().then(operation)
          run.then(resolve, reject).finally(() => {
            if (kind === 'exclusive') admitted.runningExclusive = false
            else admitted.runningShared -= 1
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
      if (next.kind === 'exclusive' && lane.runningShared > 0) break
      if (next.kind === 'shared' && lane.runningShared >= this.sharedLimit) break
      lane.queue.shift()
      next.start()
    }
    if (lane.queue.length === 0 && !lane.runningExclusive && lane.runningShared === 0) {
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
