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
import { sandboxWorkspaceMode } from '../workspace/workspace-manager.js'

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

/**
 * Which filesystem an agent's workspace files live on; undefined ⇒ this daemon's.
 *
 * Registered like the git runner's resolver, and per-agent for the same reason: one daemon can serve
 * a cluster-backed agent beside a self-hosted one, and only the execution plane knows which is which.
 */
export type WorkspaceFilesResolver = (agentId: string) => WorkspaceFiles | undefined

export function createWorkspaceReader(
  workspaceByAgent: (agentId: string, sessionId?: string) => WorkspaceLocation | undefined,
  coordinateWrite: WorkspaceWriteCoordinator,
  filesFor: WorkspaceFilesResolver = () => undefined
): WorkspaceReader {
  function locationFor(agentId: string, sessionId?: string): WorkspaceLocation {
    const location = workspaceByAgent(agentId, sessionId)
    if (!location) throw new WorkspaceViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
    // A sandbox workspace with no channel to reach it. Falling back to `localWorkspaceFiles` would
    // point them at a path in the POD's coordinates and answer `exists:false` — "this workspace is
    // empty" for one that is merely asleep, which is the answer a reader cannot act on.
    if (sandboxWorkspaceMode() && !filesFor(agentId)) {
      throw new WorkspaceViolationError(
        `agent "${agentId}" has no running sandbox, so its workspace cannot be reached`,
        'sandbox-unavailable'
      )
    }
    return location
  }

  const filesOf = (agentId: string): WorkspaceFiles => filesFor(agentId) ?? localWorkspaceFiles

  return {
    async list(req) {
      const root = locationFor(req.agentId, req.sessionId).root
      return filesOf(req.agentId).list(root, req)
    },

    async read(req) {
      const root = locationFor(req.agentId, req.sessionId).root
      return filesOf(req.agentId).read(root, req)
    },

    async write(req) {
      // Gated BEFORE the coordinator so a read-only workspace is refused without first waiting for
      // the agent's runtime to go quiet, and the bytes are validated here so oversized or binary
      // content is refused without being shipped anywhere. Both checks run again where it lands.
      if (!locationFor(req.agentId).scratch) {
        throw new WorkspaceViolationError(
          'workspace files are editable only in scratch workspaces',
          'read-only-workspace'
        )
      }
      workspaceEditBytes(req)

      return coordinateWrite(req.agentId, async () => {
        // Re-read inside the coordinator, as before: the agent's configuration can change while a
        // write waits for quiescence, and the mode that governs is the one at mutation time.
        const location = locationFor(req.agentId)
        return filesOf(req.agentId).write(location.root, location.scratch, req)
      })
    },

    async delete(req) {
      if (!locationFor(req.agentId).scratch) {
        throw new WorkspaceViolationError(
          'workspace files are editable only in scratch workspaces',
          'read-only-workspace'
        )
      }

      return coordinateWrite(req.agentId, async () => {
        const location = locationFor(req.agentId)
        return filesOf(req.agentId).delete(location.root, location.scratch, req)
      })
    }
  }
}
