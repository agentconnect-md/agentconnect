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
  spawnFor: (launch: PlaneLaunch) => PlaneSpawn
  /** A git runner where the path lives; undefined keeps the caller on its local runner. */
  gitRunnerFor: (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined
  /** The filesystem and mount the agent's workspace files live in; undefined keeps the caller on this daemon's disk. */
  workspaceFsFor: (agentId: string) => WorkspacePlacement | undefined
  /** Retire every session sandbox of the agent but the leaf named: a replaced workspace leaves them holding the old repository (§11). */
  discardSessions: (agentId: string, exceptLeaf?: string) => Promise<void>
}

/** Point the workspace manager's single-slot resolvers at one plane. */
export function wireWorkspacePlane(workspaces: WorkspaceManager, plane: ExecutionPlane): void {
  workspaces.setGitRunnerResolver((agentId, cwd, abort) => plane.gitRunnerFor(agentId, cwd, abort))
  workspaces.setFsResolver((agentId) => plane.workspaceFsFor(agentId))
  workspaces.setSessionsDiscarder((agentId, exceptLeaf) => plane.discardSessions(agentId, exceptLeaf))
}
