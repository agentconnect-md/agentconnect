/**
 * Process-local, fail-fast exclusive gate for a set of resource ids.
 *
 * External-memory connection definition/grant mutations and agent bind/unbind
 * writes share this gate. That closes the otherwise possible check-then-delete
 * race around the JSON agent binding (there is deliberately no database FK from
 * Agent.memory to the connection table). This process-local gate is valid only
 * while one CP writer is active; a multi-instance topology must replace it with
 * a distributed lock or a transactional reference model.
 */
export class ExclusiveMutationGate {
  private readonly active = new Set<string>()

  tryBeginMutation(resourceIds: string | readonly string[]): (() => void) | null {
    const ids = [...new Set(typeof resourceIds === 'string' ? [resourceIds] : resourceIds)].sort()
    if (ids.some((id) => this.active.has(id))) return null
    for (const id of ids) this.active.add(id)
    return this.releaseOnce(() => {
      for (const id of ids) this.active.delete(id)
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
