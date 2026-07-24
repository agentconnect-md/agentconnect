/**
 * Process-local read/write gate for one agent's placement boundary.
 *
 * Agent moves take the exclusive side. Ordinary agent/integration/cron writes
 * take the shared side, so they may still run concurrently with each other but
 * never overlap a cold move. Acquisition never waits: callers return 409 and
 * let the operator retry against fresh state.
 *
 * This matches the current single-control-plane deployment. A future multi-CP
 * topology must replace it with a distributed lock or transactional lease.
 */
export class AgentMutationGate {
  private readonly states = new Map<string, { moving: boolean; mutations: number }>()

  tryBeginMove(agentId: string): (() => void) | null {
    const state = this.states.get(agentId)
    if (state?.moving || (state?.mutations ?? 0) > 0) return null
    this.states.set(agentId, { moving: true, mutations: 0 })
    return this.releaseOnce(() => this.states.delete(agentId))
  }

  tryBeginMutation(agentIds: string | readonly string[]): (() => void) | null {
    const ids = [...new Set(typeof agentIds === 'string' ? [agentIds] : agentIds)].sort()
    if (ids.some((id) => this.states.get(id)?.moving)) return null
    for (const id of ids) {
      const state = this.states.get(id)
      this.states.set(id, { moving: false, mutations: (state?.mutations ?? 0) + 1 })
    }
    return this.releaseOnce(() => {
      for (const id of ids) {
        const state = this.states.get(id)
        if (!state || state.moving) continue
        if (state.mutations <= 1) this.states.delete(id)
        else state.mutations -= 1
      }
    })
  }

  isMoving(agentId: string): boolean {
    return this.states.get(agentId)?.moving === true
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
