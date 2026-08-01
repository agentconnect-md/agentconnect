/**
 * Process-local read/write gate for one agent's placement boundary.
 *
 * Agent moves take the exclusive side. Ordinary agent/integration/cron writes
 * take the shared side, so they may still run concurrently with each other but
 * never overlap a cold move. User-initiated acquisition never waits: callers
 * return 409 and let the operator retry against fresh state. Reconnect recovery
 * may queue one of the same exclusive moves behind the interrupted request.
 *
 * ROLLING-UPDATE EXPOSURE (known, accepted for now): the control plane deploys
 * via rolling update, so for a bounded window (SIGTERM → drain → close, ≤ ~10s;
 * see index.ts) two CP processes serve writes and this gate does not span them —
 * an exclusive section admitted on the draining pod and a shared/exclusive
 * section admitted on the new pod can overlap. Placement AUTHORITY stays
 * consistent regardless: it is guarded by durable fences below this gate — the
 * agent-row placement CAS (`movePlacement` FOR UPDATE + expectedDaemonId), the
 * daemon-side moveId/detach fencing, the activation fingerprint stability loop,
 * and fail-closed handling of unknown outcomes (orchestrator/agentMove.ts).
 * What the window costs is the gate's fail-fast UX and section tidiness: an
 * overlap surfaces as an AgentMoveConflict/AgentMoveFailed retry, or as a
 * transient stale definition push that the reconcile/reconnect roster converges.
 *
 * Unlike the fences that used to live beside this one (skill-source name scopes,
 * external-memory mutation scopes — both now pg advisory xact locks inside their
 * write transactions), this gate cannot ride a transaction: an exclusive section
 * spans multi-step orchestration with daemon RPCs between transactions, and its
 * exclusive hold legitimately lasts as long as a drain (unbounded — a running
 * turn is drained first). The Postgres shape that fits is a LEASE ROW (cf.
 * DaemonLifecycleOp's pending row + partial unique index): `tryBeginMove` ⇒
 * insert (unique violation ⇒ 409), release ⇒ settle. But a faithful port also
 * needs holder heartbeats + a reaper for leases orphaned by a CP crash (a fixed
 * TTL either kills legitimate long drains or blocks all CRUD for the TTL), a
 * shared-holder representation for the high-frequency tryBeginMutation call
 * sites (HTTP routes and WS handlers), and beginMoveWhenIdle's reserved-next-
 * exclusive-slot queueing — a substantial redesign, tracked in issue #376
 * rather than bolted on here.
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
