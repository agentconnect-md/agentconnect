import type { HostKey } from '../acp/host-key.js'
import type { SpawnDriver } from '../acp/spawn-driver.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { PreparedRuntimeLaunch } from '../launch/prepare.js'
import type { GitRunner } from '../workspace/git-runner.js'
import type { WorkspacePlacement } from '../workspace/workspace-fs.js'
import type { WorkspaceManager } from '../workspace/workspace-manager.js'

/** One host launch, as the plane that runs it sees it. */
export interface PlaneLaunch {
  agent: LoadedAgent
  hostKey: HostKey
  cwd: string
  prepared: PreparedRuntimeLaunch
  /** Whether the host serves one confined session (git-workspace-model §11); a function, so only a plane that routes on it pays for the answer. */
  confined: () => boolean
}

/** What AcpHost launches with: the plane's driver, and the host key when the plane names the host to it. */
export interface PlaneSpawn {
  driver: SpawnDriver
  hostKey?: HostKey
}

/** Where runtimes execute and workspaces live when that is not this daemon's own host: a cluster's sandbox pods, or the microsandbox backend's VMs. */
export interface ExecutionPlane {
  /** Whether a workspace placed here is off this daemon's disk, its paths in the plane's own coordinates: true for a cluster's pods, false for microsandbox, whose VMs mount directories of this host. */
  workspacesOffDisk: boolean
  spawnFor: (launch: PlaneLaunch) => PlaneSpawn
  /** A git runner where the path lives; undefined keeps the caller on its local runner. */
  gitRunnerFor: (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined
  /** The filesystem and mount the agent's workspace files live in; undefined keeps the caller on this daemon's disk. */
  workspaceFsFor: (agentId: string) => WorkspacePlacement | undefined
  /** Empty a directory no `rmSync` here can reach, answering why not instead of throwing; absent where the files are on this daemon's disk. */
  clearPath?: (agentId: string, root: string) => Promise<string | undefined>
  /** Retire every session sandbox of the agent but the leaf named: a replaced workspace leaves them holding the old repository (§11). */
  discardSessions: (agentId: string, exceptLeaf?: string) => Promise<void>
}

/** What a workspace operation knows about where it lands: the agent, plus the narrowest locator its caller holds — a session key, else a path in the coordinates the workspace is addressed in, else neither. */
export interface PlaneScope {
  agentId: string
  sessionKey?: string
  path?: string
}

/** The plane one scope is placed on; undefined is this daemon's own host and disk. */
export type PlaneResolver = (scope: PlaneScope) => ExecutionPlane | undefined

/** Place every scope of every agent on one plane, which is all a daemon with a single plane has to say. */
export function wireWorkspacePlane(workspaces: WorkspaceManager, plane: ExecutionPlane): void {
  workspaces.setPlaneResolver(() => plane)
}
