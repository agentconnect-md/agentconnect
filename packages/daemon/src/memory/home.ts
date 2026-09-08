// Where an agent's managed memory lives — the ONE placement decision — as the file ports plus the change-log sink
// (memory-evolution.md §3.2.1). A `daemon` home is this disk or the bound sandbox volume with the sidecar as its sink; a
// `control-plane` home is `CpMemoryFs` over the CP connection with `CpMemoryHistorySink`, gated here at activation.
import {
  AGENT_MEMORY_STORE_V1_FEATURE,
  type AgentMemoryBinding,
  type ManagedMemoryHome
} from '@agentconnect.md/protocol'
import { CpMemoryFs, type CpMemoryStoreLink } from '../cp/memory-fs.js'
import { CpMemoryHistorySink, type CpMemoryHistoryLink } from '../cp/memory-history.js'
import type { Logger } from '../log.js'
import { LocalMemoryFs, MemoryHomeUnavailableError, MemorySandboxUnavailableError, type MemoryFs } from './fs.js'
import { SidecarMemoryHistorySink, type MemoryHistorySink } from './store.js'

/** The sandbox plane as the factory sees it: the port over a bound sandbox volume, or nothing. */
export interface SandboxMemoryFsSource {
  memoryFsFor(agentId: string): MemoryFs | undefined
}

/** The CP connection as a memory home: the store and change-log request pairs behind the READY and feature gates. */
export type CpMemoryHomeLink = CpMemoryStoreLink & CpMemoryHistoryLink

/** What the factory reads off an agent: its root on this disk, and the binding whose `home` places the tree. */
export interface MemoryHomeAgent {
  id: string
  dir: string
  memory?: AgentMemoryBinding | undefined
}

/** Where the homes are reached from: the sandbox plane of a `--k8s` member, and the CP connection. */
export interface MemoryHomeDeps {
  /** Every agent of a `--k8s` daemon runs in a pod; absent on a self-hosted daemon. */
  sandbox?: SandboxMemoryFsSource | undefined
  /** Absent until the daemon has a CP client — a `control-plane` home is then unreachable, never this member's disk. */
  cp?: CpMemoryHomeLink | undefined
  log: Pick<Logger, 'warn'>
}

/** The ports the dream runner and every managed-memory writer work over. */
export interface MemoryHomePorts {
  /** The live store: `memory/`, `channels/`, `memory-backups/`, and the adoption temp dir beside them. */
  live: MemoryFs
  /** Dream staging (`memory-dreams/`) beside the extraction host; resolved on access, so over a sandbox volume it refuses with `MemorySandboxUnavailableError` while the pod is not bound. */
  staging: MemoryFs
  /** The change-log sink for one store under `live` (the agent's own tree or a channel root), in its coordinates. */
  historyFor(store: MemoryFs): MemoryHistorySink
}

/** The sidecar inside whichever store is written: the sink of every `daemon` home, and of every staged store. */
export function sidecarMemoryHistory(store: MemoryFs): MemoryHistorySink {
  return new SidecarMemoryHistorySink(store)
}

/** The `daemon` home's ports over one tree: both roles on it, the sidecar inside it as the sink. */
export function localMemoryHome(fs: MemoryFs): MemoryHomePorts {
  return { live: fs, staging: fs, historyFor: sidecarMemoryHistory }
}

/** The agent's `home`: what a managed binding says, `daemon` for every other binding (`none`/`native` carry none). */
export function memoryHomeOf(agent: Pick<MemoryHomeAgent, 'memory'>): ManagedMemoryHome {
  return agent.memory?.provider === 'managed' ? agent.memory.home : 'daemon'
}

function sandboxAsleep(agentId: string): MemorySandboxUnavailableError {
  return new MemorySandboxUnavailableError(`agent "${agentId}" has no running sandbox, so its memory cannot be reached`)
}

/** The tree the agent's pod holds, or this disk without a plane: the `daemon` home's store, every home's dream staging, and the source of the one-way migration. */
export function daemonHomeMemoryFs(agent: MemoryHomeAgent, sandbox: SandboxMemoryFsSource | undefined): MemoryFs {
  if (!sandbox) return new LocalMemoryFs(agent.dir)
  const fs = sandbox.memoryFsFor(agent.id)
  if (!fs) throw sandboxAsleep(agent.id)
  return fs
}

/** Whether the binding still carries the CP's migration marker: the copy has not been reported complete. */
export function memoryHomeMigrationPending(agent: Pick<MemoryHomeAgent, 'memory'>): boolean {
  return (
    agent.memory?.provider === 'managed' &&
    agent.memory.home === 'control-plane' &&
    agent.memory.homeMigration === 'pending'
  )
}

// Why the agent's memory home is out of reach right now, or undefined when it can be served: the activation gate
// `resolveMemoryHomePorts` refuses on, and the memory capture outbox's reachability predicate. One resolution, never a
// fallback to this member's disk — a `daemon` home on a pool member needs its pod bound; a `control-plane` home needs
// the CP connection READY and advertising `agent-memory-store-v1`, and no migration copy still pending against it.
export function memoryHomeUnavailable(
  agent: MemoryHomeAgent,
  deps: MemoryHomeDeps
): MemoryHomeUnavailableError | undefined {
  if (memoryHomeOf(agent) !== 'control-plane') {
    return deps.sandbox && !deps.sandbox.memoryFsFor(agent.id) ? sandboxAsleep(agent.id) : undefined
  }
  const home = `agent "${agent.id}" keeps its memory in the Control Plane, which`
  // The CP stamps `homeMigration: 'pending'` on a flipped binding and the migration clears it after the copy: no CP tree is served before the copy exists.
  if (memoryHomeMigrationPending(agent)) {
    return new MemoryHomeUnavailableError('migrating', `${home} is still receiving the copy of its tree`)
  }
  if (!deps.cp?.connected()) return new MemoryHomeUnavailableError('connection', `${home} is unreachable`)
  if (!deps.cp.supportsServerFeature(AGENT_MEMORY_STORE_V1_FEATURE)) {
    return new MemoryHomeUnavailableError('feature', `${home} does not serve the memory store`)
  }
  return undefined
}

// The selection. A `daemon` home is one tree for both roles — the local port over the agent dir, or the port over the
// agent's sandbox volume, reachable exactly while the pod is bound. A `control-plane` home puts `live` and the sink on
// the CP connection without touching any pod, and leaves `staging` where the extraction host can see it.
export function resolveMemoryHomePorts(agent: MemoryHomeAgent, deps: MemoryHomeDeps): MemoryHomePorts {
  if (memoryHomeOf(agent) !== 'control-plane') return localMemoryHome(daemonHomeMemoryFs(agent, deps.sandbox))
  const unavailable = memoryHomeUnavailable(agent, deps)
  if (unavailable) throw unavailable
  const cp = deps.cp!
  const live = new CpMemoryFs(cp, agent.id)
  return {
    live,
    // Looked up on use, not at activation: the store never needs the pod, and a review of a draft on the pool still wakes it.
    get staging(): MemoryFs {
      return daemonHomeMemoryFs(agent, deps.sandbox)
    },
    // A store under `live` logs to the CP table in its own coordinates; a staged store, never in the CP, keeps its sidecar.
    historyFor: (store) =>
      store instanceof CpMemoryFs
        ? new CpMemoryHistorySink(cp, agent.id, store.root, deps.log)
        : sidecarMemoryHistory(store)
  }
}

/** The live store alone, for the consumers that never touch dream staging (the provider, the CP memory reader). */
export function resolveMemoryFs(agent: MemoryHomeAgent, deps: MemoryHomeDeps): MemoryFs {
  return resolveMemoryHomePorts(agent, deps).live
}
