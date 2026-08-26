import { z } from 'zod'

export const ClusterSkillOwnedRootSchema = z
  .object({
    path: z.string().min(1).max(512),
    sourceId: z.string().min(1).max(160),
    sourceKind: z.enum(['agent', 'managed', 'dream']),
    digest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

export const ClusterSkillLedgerSchema = z.object({ roots: z.array(ClusterSkillOwnedRootSchema).max(512) }).strict()

export type ClusterSkillLedger = z.infer<typeof ClusterSkillLedgerSchema>

export interface ClusterSkillLedgerRecord {
  revision: number
  ledger: ClusterSkillLedger
}

export interface ClusterSkillReconcileAuthority {
  groupId: string
  term: string
  daemonId: string
  agentId: string
  workspaceIncarnation: string
  operationId: string
}
