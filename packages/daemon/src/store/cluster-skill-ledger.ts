import { z } from 'zod'
import { MAX_SKILL_BUNDLES, MAX_SKILL_PATH_BYTES, MAX_SKILL_RECEIPT_FILES } from '../skills/skill-limits.js'

export const ClusterSkillPathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (Buffer.byteLength(value) > MAX_SKILL_PATH_BYTES || /[\x00-\x1f\x7f\\]/.test(value)) return false
    return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  }, 'path must be a bounded contained relative path')

export const ClusterSkillOwnedRootSchema = z
  .object({
    path: ClusterSkillPathSchema,
    sourceId: z.string().min(1).max(160),
    sourceKind: z.enum(['agent', 'managed', 'dream']),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    files: z
      .array(
        z
          .object({
            path: ClusterSkillPathSchema,
            mode: z.number().int().min(0).max(0o777),
            size: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/)
          })
          .strict()
      )
      .max(MAX_SKILL_RECEIPT_FILES)
  })
  .strict()

export const ClusterSkillLedgerSchema = z
  .object({
    roots: z.array(ClusterSkillOwnedRootSchema).max(MAX_SKILL_BUNDLES),
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
