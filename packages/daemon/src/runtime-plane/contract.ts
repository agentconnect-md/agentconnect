import type { SpawnDriver } from '../acp/spawn-driver.js'
import type { ClusterSkillClient } from '../shim/skill-client.js'
import type { ShimAutoMergeClient } from '../shim/auto-merge-client.js'
import type { WorkspaceFiles } from '../workspace/workspace-files.js'
import type { WorkspacePlacement } from '../workspace/workspace-fs.js'
import type { GitRunner } from '../workspace/git-runner.js'
import type { MemoryFs } from '../memory/fs.js'
// Naming debt: the declared-runtime table is the same concept for any plane, but the type keeps its
// k8s name until something other than a rename needs it.
import type { K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'

/** Extra work for the held probe sandbox, given the identity that routes a launch into it and the
 *  cwd a session must use — the SANDBOX's mount, never a path on the daemon's disk. */
export type ProbeSandboxSweep = (table: K8sRuntimeTable, sandbox: { agentId: string; cwd: string }) => Promise<void>

/**
 * Where an agent's runtime runs when it does not run on this daemon's own host, and the seams that
 * follow from that: git, workspace files, memory and skills all have to reach the filesystem the
 * runtime actually sees.
 *
 * `SpawnDriver` is the narrow half of this seam and carries only the ACP byte streams. Everything
 * an agent needs AROUND its runtime is here, because moving the runtime off the host moves all of
 * it at once. Every `…For(agentId)` member answers `undefined` on the same condition — no bound
 * sandbox for that agent here — which keeps a caller from describing one filesystem while the work
 * happens in another.
 */
export interface RuntimePlane {
  /** Hands `AcpHost` the byte-stream pair; the plane owns everything filesystem-shaped around it. */
  driver: SpawnDriver
  /** This member's stable identity — one half of a pool-wide probe election. */
  memberId: string
  /** The runtime image this plane launches, and what a published probe result is keyed on. */
  runtimeImage: () => Promise<string>
  /** Bring an agent's sandbox up and bind its channel WITHOUT starting a runtime, so the
   *  workspace can be prepared on the sandbox's own volume before the runtime looks at it. */
  ensureChannel: (agentId: string) => Promise<void>
  /** Run `work` while holding the agent's sandbox against the ordinary idle sweep. */
  withSandbox: <T>(agentId: string, work: () => Promise<T>) => Promise<T>
  /** Ask a sandbox which runtimes the image actually provides, and tear it down again. `sweep` runs
   *  while that same sandbox is still held and bound, so a credentialed model probe can reuse it. */
  probeRuntimes: (sweep?: ProbeSandboxSweep) => Promise<K8sRuntimeTable>
  /** A git runner for an agent whose workspace lives in its sandbox, or undefined when this daemon
   *  has no channel for it — the caller then keeps its local behaviour. */
  gitRunnerFor: (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined
  /** The console's file operations for that same workspace, on the same condition. Separate from the
   *  git runner because they are separate capabilities (`read` vs `exec`) and a channel is not a
   *  blanket permission — not because the two ever disagree about which filesystem to use. */
  workspaceFilesFor: (agentId: string) => WorkspaceFiles | undefined
  /** Where the agent's WORKSPACE files live and which coordinates they are addressed in — the
   *  filesystem twin of `gitRunnerFor`, answering on the same condition. */
  workspaceFsFor: (agentId: string) => WorkspacePlacement | undefined
  /** The sandbox's merge-when-ready channel, on the same condition: the watcher runs INSIDE, so its
   *  armed set dies with the sandbox, which is the lifetime the console projects. */
  autoMergeFor: (agentId: string) => ShimAutoMergeClient | undefined
  /** The agent's managed memory tree on that same volume, on the same condition. */
  memoryFsFor: (agentId: string) => MemoryFs | undefined
  /** Whether this agent's work runs in a sandbox right now — the SAME condition `gitRunnerFor`
   *  answers on, read here rather than re-derived so the two can never disagree. */
  runsInSandbox: (agentId: string) => boolean
  /** Empty a directory on the agent's volume, reporting why not rather than throwing. It cannot be
   *  an `rmSync`: the directory is on a filesystem the daemon cannot see. */
  clearPath: (agentId: string, root: string) => Promise<string | undefined>
  /** Where the agent's bound sandbox mounts its workspace, as its shim reported; undefined before a
   *  bind or from a legacy shim (callers fall back to DEFAULT_SHIM_WORKSPACE_ROOT). */
  workspaceRootFor: (agentId: string) => string | undefined
  skillClientFor?: (agentId: string) => ClusterSkillClient | undefined
  workspaceIncarnationFor?: (agentId: string) => string | undefined
  shimGenerationFor?: (agentId: string) => number | undefined
  /** Agents this daemon holds a sandbox for, and since when — the idle sweep's candidates. Read from
   *  the driver, not inferred from live hosts: a launch outlives the host it was made for. */
  launchedAgents: () => Array<{ agentId: string; since: number }>
  /** Take over an agent's sandbox so this member can suspend it. */
  adoptAgent: (agentId: string) => Promise<void>
  /** No longer served here: launch, channel, tunnel and loss watch go; the sandbox and volume stay. */
  releaseAgent: (agentId: string) => void
  /** Suspend a quiet agent's sandbox, keeping its workspace volume. `busy` means work still holds
   *  it; `absent` means there is nothing to suspend. Waking is the next launch's bind, not a call. */
  suspendIdle: (agentId: string) => Promise<'suspended' | 'busy' | 'absent'>
  /** Destroy an agent's sandbox for good, workspace volume included. For agent REMOVAL only. */
  discardAgent: (agentId: string) => Promise<void>
  /** Names what a failed `discardAgent` left for the orphan reaper, for the operator's log alone. */
  describeResidue?: (agentId: string) => string
  stop: () => Promise<void>
}
