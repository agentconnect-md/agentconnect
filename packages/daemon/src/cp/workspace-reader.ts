/**
 * `WorkspaceReader` — the seam answering the CP's workspace file list/read/write/delete
 * REQs. File bytes live only at the edge (§1/§12); the CP proxies single pages/slices or
 * one bounded scratch-file mutation and never persists them.
 *
 * This module is the POLICY half: which agent, which workspace root, whether that workspace
 * may be written at all, and serialising a mutation against the agent's runtime. The
 * filesystem work itself is {@link WorkspaceFiles}, so a cluster agent's files — which live
 * on its sandbox pod's volume and not on this disk — are served by the same operations
 * running inside the pod. Containment, the atomic publish and the frame budgets are
 * documented there.
 */
import type {
  WorkspaceListReq,
  WorkspaceListPage,
  WorkspaceReadReq,
  WorkspaceReadContent,
  WorkspaceWriteReq,
  WorkspaceWriteOk,
  WorkspaceDeleteReq,
  WorkspaceDeleteOk
} from '@agentconnect.md/protocol'
import {
  localWorkspaceFiles,
  workspaceEditBytes,
  WorkspaceViolationError,
  type WorkspaceFiles,
  type WorkspaceLocation
} from '../workspace/workspace-files.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { PlaneScope } from '../execution/plane.js'

// Re-exported rather than moved-and-chased: the error classes are what the CP dispatcher maps onto
// wire frames, and the two path helpers are what the git seam contains its pathspecs with. Neither
// caller cares that the implementation now lives in the placement layer.
export {
  canonicalWorkspacePath,
  containedWorkspacePath,
  WorkspaceConflictError,
  WorkspaceViolationError,
  type WorkspaceLocation
} from '../workspace/workspace-files.js'

export interface WorkspaceReader {
  list(req: WorkspaceListReq): Promise<WorkspaceListPage>
  read(req: WorkspaceReadReq): Promise<WorkspaceReadContent>
  write(req: WorkspaceWriteReq): Promise<WorkspaceWriteOk>
  delete(req: WorkspaceDeleteReq): Promise<WorkspaceDeleteOk>
}

export type WorkspaceWriteCoordinator = <T>(agentId: string, write: () => Promise<T>) => Promise<T>

/** Which filesystem a workspace root lives on, asked per agent and per session because only the execution plane knows where each runs; undefined ⇒ this daemon's. */
export type WorkspaceFilesResolver = (
  agentId: string,
  scope?: Omit<PlaneScope, 'agentId'>
) => WorkspaceFiles | undefined

export function createWorkspaceReader(
  workspaces: WorkspaceManager,
  workspaceByAgent: (agentId: string, sessionId?: string, repo?: string) => Promise<WorkspaceLocation | undefined>,
  coordinateWrite: WorkspaceWriteCoordinator,
  filesFor: WorkspaceFilesResolver = () => undefined
): WorkspaceReader {
  async function locationFor(agentId: string, sessionId?: string, repo?: string): Promise<WorkspaceLocation> {
    const location = await workspaceByAgent(agentId, sessionId, repo)
    if (!location) throw new WorkspaceViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
    return location
  }

  /** The filesystem this request runs on, resolved ONCE and held by the caller: the shim re-dials at half its credential TTL, so probing for a channel and resolving again to use it can answer `localWorkspaceFiles` against a root in the POD's coordinates — an off-disk root therefore has no fallback, and the one resolution's absence is the refusal. */
  function filesOf(agentId: string, { root, sessionKey }: WorkspaceLocation): WorkspaceFiles {
    // Judged by the session's own scope, as its root was composed, never by whether its pipe still names that root.
    const scope = { path: root, ...(sessionKey === undefined ? {} : { sessionKey }) }
    const remote = filesFor(agentId, scope)
    if (remote) return remote
    if (workspaces.offDisk({ agentId, ...scope })) {
      throw new WorkspaceViolationError(
        `agent "${agentId}" has no running sandbox, so its workspace cannot be reached`,
        'sandbox-unavailable'
      )
    }
    return localWorkspaceFiles
  }

  return {
    async list(req) {
      const location = await locationFor(req.agentId, req.sessionId, req.repo)
      return filesOf(req.agentId, location).list(location.root, req)
    },

    async read(req) {
      const location = await locationFor(req.agentId, req.sessionId, req.repo)
      return filesOf(req.agentId, location).read(location.root, req)
    },

    async write(req) {
      // Gated BEFORE the coordinator so a read-only workspace is refused without first waiting for
      // the agent's runtime to go quiet, and the bytes are validated here so oversized or binary
      // content is refused without being shipped anywhere. Both checks run again where it lands.
      if (!(await locationFor(req.agentId)).scratch) {
        throw new WorkspaceViolationError(
          'workspace files are editable only in scratch workspaces',
          'read-only-workspace'
        )
      }
      workspaceEditBytes(req)

      return coordinateWrite(req.agentId, async () => {
        // Re-read inside the coordinator: the configuration can change while a write waits, and the mode at mutation time governs.
        const location = await locationFor(req.agentId)
        return filesOf(req.agentId, location).write(location.root, location.scratch, req)
      })
    },

    async delete(req) {
      if (!(await locationFor(req.agentId)).scratch) {
        throw new WorkspaceViolationError(
          'workspace files are editable only in scratch workspaces',
          'read-only-workspace'
        )
      }

      return coordinateWrite(req.agentId, async () => {
        const location = await locationFor(req.agentId)
        return filesOf(req.agentId, location).delete(location.root, location.scratch, req)
      })
    }
  }
}
