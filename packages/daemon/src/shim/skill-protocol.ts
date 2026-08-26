import { z } from 'zod'

export const MAX_CLUSTER_SKILL_SOURCES = 64
export const MAX_CLUSTER_SKILL_FILES = 4_096
export const MAX_CLUSTER_SKILL_FILE_BYTES = 4 * 1024 * 1024
export const MAX_CLUSTER_SKILL_TOTAL_BYTES = 32 * 1024 * 1024
export const MAX_CLUSTER_SKILL_CHUNK_BYTES = 48 * 1024
export const MAX_CLUSTER_SKILL_SELECTIONS = 256

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const RelativeSkillPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (value.includes('\0') || value.startsWith('/') || value.startsWith('\\')) return false
    const parts = value.replaceAll('\\', '/').split('/')
    return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  }, 'path must be a contained relative path')

export const ClusterSkillFileSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    path: RelativeSkillPathSchema,
    size: z.number().int().nonnegative().max(MAX_CLUSTER_SKILL_FILE_BYTES),
    sha256: Sha256Schema
  })
  .strict()

export const ClusterSkillBeginSchema = z
  .object({
    op: z.literal('begin'),
    operationId: z.string().uuid(),
    workspaceIncarnation: z.string().min(1).max(160),
    skillsAgentId: z.string().min(1).max(80),
    files: z.array(ClusterSkillFileSchema).max(MAX_CLUSTER_SKILL_FILES)
  })
  .strict()
  .superRefine((value, ctx) => {
    const sources = new Set<string>()
    const files = new Set<string>()
    let total = 0
    for (const file of value.files) {
      sources.add(file.sourceId)
      const identity = `${file.sourceId}\0${file.path}`
      if (files.has(identity)) ctx.addIssue({ code: 'custom', message: 'duplicate snapshot file' })
      files.add(identity)
      total += file.size
    }
    if (sources.size > MAX_CLUSTER_SKILL_SOURCES) ctx.addIssue({ code: 'custom', message: 'too many sources' })
    if (total > MAX_CLUSTER_SKILL_TOTAL_BYTES) ctx.addIssue({ code: 'custom', message: 'snapshot bytes exceed limit' })
  })

export const ClusterSkillUploadSchema = z
  .object({
    op: z.literal('upload'),
    operationId: z.string().uuid(),
    handle: z.string().min(16).max(128),
    sourceId: z.string().min(1).max(160),
    path: RelativeSkillPathSchema,
    offset: z.number().int().nonnegative().max(MAX_CLUSTER_SKILL_FILE_BYTES),
    data: z
      .string()
      .max(Math.ceil(MAX_CLUSTER_SKILL_CHUNK_BYTES / 3) * 4)
      .refine((value) => {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
        return Buffer.from(value, 'base64').byteLength <= MAX_CLUSTER_SKILL_CHUNK_BYTES
      }, 'invalid or oversized base64 chunk'),
    final: z.boolean()
  })
  .strict()

export const ClusterSkillSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    sourceKind: z.enum(['agent', 'managed', 'dream']),
    selections: z.array(z.string().min(1).max(128)).max(MAX_CLUSTER_SKILL_SELECTIONS)
  })
  .strict()

export const ClusterSkillReconcileSchema = z
  .object({
    op: z.literal('reconcile'),
    operationId: z.string().uuid(),
    handle: z.string().min(16).max(128),
    sources: z.array(ClusterSkillSourceSchema).max(MAX_CLUSTER_SKILL_SOURCES)
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>()
    for (const source of value.sources) {
      if (ids.has(source.sourceId)) ctx.addIssue({ code: 'custom', message: 'duplicate reconcile source' })
      ids.add(source.sourceId)
    }
  })

export const ClusterSkillRequestSchema = z.discriminatedUnion('op', [
  ClusterSkillBeginSchema,
  ClusterSkillUploadSchema,
  ClusterSkillReconcileSchema
])

export const ClusterSkillBeginReplySchema = z.object({ handle: z.string().min(16).max(128) }).strict()
export const ClusterSkillUploadReplySchema = z
  .object({ received: z.number().int().nonnegative().max(MAX_CLUSTER_SKILL_FILE_BYTES), complete: z.boolean() })
  .strict()
export const ClusterSkillReconcileReplySchema = z
  .object({
    roots: z
      .array(
        z
          .object({
            path: RelativeSkillPathSchema,
            sourceId: z.string().min(1).max(160),
            sourceKind: z.enum(['agent', 'managed', 'dream']),
            digest: Sha256Schema,
            files: z
              .array(
                z
                  .object({ path: RelativeSkillPathSchema, size: z.number().int().nonnegative(), sha256: Sha256Schema })
                  .strict()
              )
              .max(1024)
          })
          .strict()
      )
      .max(512),
    conflicts: z.array(RelativeSkillPathSchema).max(512)
  })
  .strict()

export type ClusterSkillBegin = z.infer<typeof ClusterSkillBeginSchema>
export type ClusterSkillFile = z.infer<typeof ClusterSkillFileSchema>
export type ClusterSkillUpload = z.infer<typeof ClusterSkillUploadSchema>
export type ClusterSkillReconcile = z.infer<typeof ClusterSkillReconcileSchema>
export type ClusterSkillRequest = z.infer<typeof ClusterSkillRequestSchema>
export type ClusterSkillBeginReply = z.infer<typeof ClusterSkillBeginReplySchema>
export type ClusterSkillUploadReply = z.infer<typeof ClusterSkillUploadReplySchema>
export type ClusterSkillReconcileReply = z.infer<typeof ClusterSkillReconcileReplySchema>
