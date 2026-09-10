import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { ClusterSkillLedgerSchema, type ClusterSkillLedger } from '../store/cluster-skill-ledger.js'
import { assertSkillLedgerOwner, readSkillLedger, skillLedgerLocation } from './skill-install-ledger.js'

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
  const ledger = await readSkillLedger(await skillLedgerLocation(cwd, stateDir))
  if (!ledger) return undefined
  assertSkillLedgerOwner(ledger, agentId)
  if (ledger.phase !== 'ready' || ledger.cleanup) {
    throw new Error('an unfinished host skill installation must be recovered before moving it into the sandbox')
  }
  return ClusterSkillLedgerSchema.parse({
    roots: ledger.owned.map((root) => ({
      path: root.relativeRoot,
      sourceId: `legacy:${createHash('sha256').update(root.sourceKey).digest('hex')}`,
      sourceKind: 'agent',
      digest: root.treeDigest,
      files: root.files
    })),
    gitResolutions: ledger.gitResolutions
  })
}
