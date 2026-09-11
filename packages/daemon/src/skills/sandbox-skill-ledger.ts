import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { ClusterSkillLedgerSchema, type ClusterSkillLedger } from '../store/cluster-skill-ledger.js'
import {
  assertSkillLedgerOwner,
  readSkillLedger,
  recoverSkillLedger,
  skillLedgerLocation,
  withSkillWorkspaceLock
} from './skill-install-ledger.js'

// Only the daemon-owned receipt can authorize adopting skills installed before the VM handled them.
export async function legacySandboxSkillLedger(
  agentId: string,
  cwd: string,
  stateDir: string
): Promise<ClusterSkillLedger | undefined> {
  const directory = await lstat(cwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  })
  if (!directory?.isDirectory()) return undefined
  return withSkillWorkspaceLock(
    cwd,
    async () => {
      const location = await skillLedgerLocation(cwd, stateDir)
      const ledger = await readSkillLedger(location)
      if (!ledger) return undefined
      assertSkillLedgerOwner(ledger, agentId)
      // These journals describe host-originated mutations and must recover using their original filesystem identities.
      const ready = await recoverSkillLedger(cwd, location, ledger)
      return ClusterSkillLedgerSchema.parse({
        roots: ready.owned.map((root) => ({
          path: root.relativeRoot,
          sourceId: `legacy:${createHash('sha256').update(root.sourceKey).digest('hex')}`,
          sourceKind: 'agent',
          digest: root.treeDigest,
          files: root.files
        })),
        gitResolutions: ready.gitResolutions
      })
    },
    stateDir
  )
}
