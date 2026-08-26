// CP-facing read of an agent's workspace skill inventory (skills/local). Bodies
// stay at the edge; only per-skill metadata is returned. An agent whose
// workspace has not been materialized reports materialized=false with no skills,
// so the console can tell "not prepared yet" from "prepared, but no skills".
//
// A cluster agent's workspace is on its sandbox pod's volume, so `existsSync` here answers about a
// directory on the wrong machine — which reported "not prepared yet" for every one of them. The
// question travels with the workspace instead: the seam is asked whether the root is there, and the
// inventory is walked through it.

import { existsSync } from 'node:fs'
import type { LocalSkillsList, LocalSkillsReq } from '@agentconnect.md/protocol'
import { listLocalSkills, listSandboxSkills } from '../skills/local-skill-inventory.js'
import type { WorkspaceFiles } from '../workspace/workspace-files.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { ClusterSkillLedger } from '../store/cluster-skill-ledger.js'

export interface LocalSkillsReader {
  list(req: LocalSkillsReq): Promise<LocalSkillsList>
}

export function createLocalSkillsReader(
  workspaces: WorkspaceManager,
  workspacePathFor: (agentId: string) => Promise<string | undefined>,
  stateDir: string,
  /** The filesystem that agent's workspace lives on; undefined ⇒ this daemon's. */
  filesFor: (agentId: string) => WorkspaceFiles | undefined = () => undefined,
  clusterLedgerFor: (agentId: string) => Promise<ClusterSkillLedger | undefined> = async () => undefined,
  verifyClusterRoots: (agentId: string, roots: ClusterSkillLedger['roots']) => Promise<boolean[]> = async (
    _agentId,
    roots
  ) => roots.map(() => false)
): LocalSkillsReader {
  return {
    async list(req) {
      const cwd = await workspacePathFor(req.agentId)
      if (!cwd) return { materialized: false, skills: [] }
      // Resolved once, so a channel dropping mid-request cannot answer about the pod's workspace with
      // a listing of this daemon's disk.
      const files = filesFor(req.agentId)
      if (!files) {
        // In sandbox mode an absent handle means the pod is UNBOUND, not that the workspace is local:
        // `cwd` is already in pod coordinates, so `existsSync`/`listLocalSkills` would read whatever
        // sits at that path on this daemon's filesystem. Unreachable is reported as unmaterialized —
        // the wire has no third answer here, and the two other seams refuse with `sandbox-unavailable`
        // because theirs does.
        if (workspaces.sandboxMode) return { materialized: false, skills: [] }
        if (!existsSync(cwd)) return { materialized: false, skills: [] }
        return { materialized: true, skills: await listLocalSkills(cwd, stateDir) }
      }
      // `list` on the root itself: `exists` is the same fact `existsSync` was after, asked of the
      // filesystem that actually holds it.
      const root = await files.list(cwd, { agentId: req.agentId, path: '', limit: 1 }).catch(() => undefined)
      if (!root?.exists) return { materialized: false, skills: [] }
      return {
        materialized: true,
        skills: await listSandboxSkills(files, cwd, req.agentId, await clusterLedgerFor(req.agentId), (roots) =>
          verifyClusterRoots(req.agentId, roots)
        )
      }
    }
  }
}
