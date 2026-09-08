// Where an agent's managed memory lives — the ONE placement decision — as the file ports plus the change-log sink
// (memory-evolution.md §3.2.1). Today the tree is on this disk or on the bound sandbox volume, and the sidecar inside
// the store is the sink either way; a `control-plane` home will pick `CpMemoryFs` and `CpMemoryHistorySink` here.
import { LocalMemoryFs, MemorySandboxUnavailableError, type MemoryFs } from './fs.js'
import { SidecarMemoryHistorySink, type MemoryHistorySink } from './store.js'

/** The sandbox plane as the factory sees it: the port over a bound sandbox volume, or nothing. */
export interface SandboxMemoryFsSource {
  memoryFsFor(agentId: string): MemoryFs | undefined
}

/** The ports the dream runner and every managed-memory writer work over; today `live` and `staging` are one tree. */
export interface MemoryHomePorts {
  /** The live store: `memory/`, `channels/`, `memory-backups/`, and the adoption temp dir beside them. */
  live: MemoryFs
  /** Dream staging (`memory-dreams/`), on the filesystem the extraction host runs in — its root is the host's cwd. */
  staging: MemoryFs
  /** The change-log sink for one store under `live` (the agent's own tree or a channel root), in its coordinates. */
  historyFor(store: MemoryFs): MemoryHistorySink
}

/** The sidecar inside whichever store is written: the sink every home selects today. */
export function sidecarMemoryHistory(store: MemoryFs): MemoryHistorySink {
  return new SidecarMemoryHistorySink(store)
}

/**
 * With a sandbox plane (every agent of a `--k8s` daemon runs in a pod) the tree is the port over the agent's sandbox
 * volume, reachable exactly while the pod is bound — no fallback to this member's disk, since a duty move would leave
 * the memory behind; without one, the local port over the agent dir. A later home moves `live` and the sink alone;
 * `staging` stays where the extraction host can see it.
 */
export function resolveMemoryHomePorts(
  agent: { id: string; dir: string },
  sandbox: SandboxMemoryFsSource | undefined
): MemoryHomePorts {
  if (!sandbox) {
    const fs = new LocalMemoryFs(agent.dir)
    return { live: fs, staging: fs, historyFor: sidecarMemoryHistory }
  }
  const fs = sandbox.memoryFsFor(agent.id)
  if (!fs) {
    throw new MemorySandboxUnavailableError(
      `agent "${agent.id}" has no running sandbox, so its memory cannot be reached`
    )
  }
  return { live: fs, staging: fs, historyFor: sidecarMemoryHistory }
}

/** The live store alone, for the consumers that never touch dream staging (the provider, the CP memory reader). */
export function resolveMemoryFs(
  agent: { id: string; dir: string },
  sandbox: SandboxMemoryFsSource | undefined
): MemoryFs {
  return resolveMemoryHomePorts(agent, sandbox).live
}
