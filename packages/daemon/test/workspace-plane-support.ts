import { wireWorkspacePlane, type ExecutionPlane } from '../src/execution/plane.js'
import type { WorkspaceManager } from '../src/workspace/workspace-manager.js'

/** A plane that answers only what a test names — `workspacesOffDisk: true` is a cluster member's shape — while everything unnamed keeps the manager on this daemon's runner and disk. */
export function testPlane(parts: Partial<ExecutionPlane> = {}): ExecutionPlane {
  return {
    workspacesOffDisk: false,
    spawnFor: () => {
      throw new Error('a test plane launches nothing')
    },
    gitRunnerFor: () => undefined,
    workspaceFsFor: () => undefined,
    discardSessions: async () => {},
    ...parts
  }
}

/** Place every scope of every agent on one such plane, as a daemon with a single plane wires it. */
export function wireTestPlane(workspaces: WorkspaceManager, parts: Partial<ExecutionPlane>): void {
  wireWorkspacePlane(workspaces, testPlane(parts))
}
