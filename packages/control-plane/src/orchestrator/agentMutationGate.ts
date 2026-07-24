/**
 * Process-local read/write gate for one agent's placement boundary.
 *
 * Agent moves take the exclusive side. Ordinary agent/integration/cron writes
 * take the shared side, so they may still run concurrently with each other but
 * never overlap a cold move. User-initiated acquisition never waits: callers
 * return 409 and let the operator retry against fresh state. Reconnect recovery
 * may queue one of the same exclusive moves behind the interrupted request.
 *
 * This matches the current single-control-plane deployment. A future multi-CP
 * topology must replace it with a distributed lock or transactional lease.
 */
export class AgentMutationGate {
  private readonly states = new Map<
    string,
    { moving: boolean; mutations: number; moveWaiters: Array<(release: () => void) => void> }
  >()

  tryBeginMove(agentId: string): (() => void) | null {
    const state = this.states.get(agentId)
    if (state) return null
    this.states.set(agentId, { moving: true, mutations: 0, moveWaiters: [] })
    return this.moveRelease(agentId)
  }

  /** Queue an internal recovery behind the current holder and reserve the next
   * exclusive slot so new user mutations cannot overtake it. */
  beginMoveWhenIdle(agentId: string): Promise<() => void> {
    const release = this.tryBeginMove(agentId)
    if (release) return Promise.resolve(release)
    return new Promise((resolve) => {
      this.states.get(agentId)!.moveWaiters.push(resolve)
    })
  }

  tryBeginMutation(agentIds: string | readonly string[]): (() => void) | null {
    const ids = [...new Set(typeof agentIds === 'string' ? [agentIds] : agentIds)].sort()
    if (ids.some((id) => (this.states.get(id)?.moveWaiters.length ?? 0) > 0 || this.states.get(id)?.moving)) return null
    for (const id of ids) {
      const state = this.states.get(id)
      this.states.set(id, {
        moving: false,
        mutations: (state?.mutations ?? 0) + 1,
        moveWaiters: state?.moveWaiters ?? []
      })
    }
    return this.releaseOnce(() => {
      for (const id of ids) {
        const state = this.states.get(id)
        if (!state || state.moving) continue
        state.mutations -= 1
        if (state.mutations > 0) continue
        const next = state.moveWaiters.shift()
        if (!next) {
          this.states.delete(id)
          continue
        }
        state.moving = true
        next(this.moveRelease(id))
      }
    })
  }

  isMoving(agentId: string): boolean {
    return this.states.get(agentId)?.moving === true
  }

  private moveRelease(agentId: string): () => void {
    return this.releaseOnce(() => {
      const state = this.states.get(agentId)
      if (!state?.moving) return
      const next = state.moveWaiters.shift()
      if (!next) {
        this.states.delete(agentId)
        return
      }
      next(this.moveRelease(agentId))
    })
  }

  private releaseOnce(release: () => void): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }
}
