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
  workspaces: WorkspaceManager,
  workspaceByAgent: (agentId: string, sessionId?: string) => Promise<WorkspaceLocation | undefined>,
  coordinateWrite: WorkspaceWriteCoordinator,
  filesFor: WorkspaceFilesResolver = () => undefined
): WorkspaceReader {
  async function locationFor(agentId: string, sessionId?: string): Promise<WorkspaceLocation> {
    const location = await workspaceByAgent(agentId, sessionId)
    if (!location) throw new WorkspaceViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
    return location
  }

  /**
   * The filesystem this request runs on, resolved ONCE and returned so the caller holds it.
   *
   * The reachability refusal lives HERE rather than beside it, because the two cannot be separate
   * steps: the shim re-dials at half its credential TTL, so a resolver probed to prove a channel
   * exists and then probed again to use it can answer differently across those two calls — and the
   * second answer would be `localWorkspaceFiles` against a path in the POD's coordinates. A read
   * would report an empty workspace; a create would `mkdir -p` that pod path on this daemon's disk
   * and publish the file into it. So sandbox mode has no fallback at all: one resolution, and its
   * absence is the refusal.
   */
  function filesOf(agentId: string): WorkspaceFiles {
    const remote = filesFor(agentId)
    if (remote) return remote
    if (workspaces.sandboxMode) {
      throw new WorkspaceViolationError(
        `agent "${agentId}" has no running sandbox, so its workspace cannot be reached`,
        'sandbox-unavailable'
      )
    }
    return localWorkspaceFiles
  }

  return {
    async list(req) {
      const root = (await locationFor(req.agentId, req.sessionId)).root
      return filesOf(req.agentId).list(root, req)
    },

    async read(req) {
      const root = (await locationFor(req.agentId, req.sessionId)).root
      return filesOf(req.agentId).read(root, req)
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
        // Re-read inside the coordinator, as before: the agent's configuration can change while a
        // write waits for quiescence, and the mode that governs is the one at mutation time.
        const location = await locationFor(req.agentId)
        return filesOf(req.agentId).write(location.root, location.scratch, req)
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
        return filesOf(req.agentId).delete(location.root, location.scratch, req)
      })
    }
  }
}
