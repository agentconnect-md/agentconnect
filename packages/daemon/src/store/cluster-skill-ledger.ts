import { z } from 'zod'

export const ClusterSkillOwnedRootSchema = z
  .object({
    path: z.string().min(1).max(512),
    sourceId: z.string().min(1).max(160),
    sourceKind: z.enum(['agent', 'managed', 'dream']),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            mode: z.number().int().min(0).max(0o777),
            size: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/)
          })
          .strict()
      )
      .max(64)
  })
  .strict()

export const ClusterSkillLedgerSchema = z
  .object({
    roots: z.array(ClusterSkillOwnedRootSchema).max(256),
    gitResolutions: z
      .array(
        z
          .object({
            definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
            resolvedCommit: z.string().regex(/^[a-f0-9]{40}$/)
          })
          .strict()
      )
      .max(64)
      .optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.roots.reduce((total, root) => total + root.files.length, 0) > 256) {
      ctx.addIssue({ code: 'custom', message: 'cluster skill ledger receipt exceeds limit' })
    }
  })

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
