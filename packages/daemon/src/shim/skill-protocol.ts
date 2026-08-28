import { z } from 'zod'
import { createHash } from 'node:crypto'

export const MAX_CLUSTER_SKILL_SOURCES = 64
// A Git source is a whole collection repo; these mirror GIT_SKILL_SOURCE_SNAPSHOT_LIMITS, and the
// manifest reaches the pod in `manifest` pages so the count is no longer bound to one frame.
export const MAX_CLUSTER_SKILL_FILES = 16_384
export const MAX_CLUSTER_SKILL_FILE_BYTES = 16 * 1024 * 1024
export const MAX_CLUSTER_SKILL_TOTAL_BYTES = 1024 * 1024 * 1024
export const MAX_CLUSTER_SKILL_MANIFEST_PAGE = 512
export const MAX_CLUSTER_SKILL_CHUNK_BYTES = 128 * 1024
export const MAX_CLUSTER_SKILL_SELECTIONS = 256
export const MAX_CLUSTER_SKILL_CONTROL_BYTES = 220 * 1024

/** What `cluster-skills-v1` admits — a daemon takes over a running pod, so it may be older than us.
 *  That image has no `manifest` op, so its whole file list must still fit one `begin` frame. */
export const LEGACY_MAX_CLUSTER_SKILL_FILES = 256
export const LEGACY_MAX_CLUSTER_SKILL_TOTAL_BYTES = 32 * 1024 * 1024

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const DecimalTermSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .max(40)
const RelativeSkillPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (value.includes('\0') || value.startsWith('/') || value.startsWith('\\')) return false
    const parts = value.replaceAll('\\', '/').split('/')
    return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  }, 'path must be a contained relative path')

export const ClusterSkillAuthoritySchema = z
  .object({
    groupId: z.string().min(1).max(80),
    term: DecimalTermSchema,
    daemonId: z.string().min(1).max(80),
    agentId: z.string().min(1).max(80),
    workspaceIncarnation: z.string().min(1).max(160),
    shimGeneration: z.number().int().nonnegative()
  })
  .strict()

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
    authority: ClusterSkillAuthoritySchema,
    skillsAgentId: z.string().min(1).max(80),
    files: z.array(ClusterSkillFileSchema).max(MAX_CLUSTER_SKILL_MANIFEST_PAGE),
    /** More `manifest` pages follow before upload. Absent ⇒ a legacy single-frame manifest. */
    moreFiles: z.boolean().optional()
  })
  .strict()
  .superRefine((value, ctx) => assertManifestPage(value, value.files, ctx, 'begin manifest'))

export const ClusterSkillManifestSchema = z
  .object({
    op: z.literal('manifest'),
    operationId: z.string().uuid(),
    handle: z.string().min(16).max(128),
    files: z.array(ClusterSkillFileSchema).min(1).max(MAX_CLUSTER_SKILL_MANIFEST_PAGE),
    moreFiles: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => assertManifestPage(value, value.files, ctx, 'manifest page'))

/** One page's own admission. The cross-page totals — file count, byte sum, source count and
 *  duplicate paths — are the receiver's to enforce, since no single page can see them. */
function assertManifestPage(
  value: unknown,
  files: Array<z.infer<typeof ClusterSkillFileSchema>>,
  ctx: z.RefinementCtx,
  label: string
): void {
  const seen = new Set<string>()
  for (const file of files) {
    const identity = `${file.sourceId}\0${file.path}`
    if (seen.has(identity)) ctx.addIssue({ code: 'custom', message: 'duplicate snapshot file' })
    seen.add(identity)
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CLUSTER_SKILL_CONTROL_BYTES) {
    ctx.addIssue({ code: 'custom', message: `${label} exceeds frame-safe limit` })
  }
}

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

export const ClusterSkillPriorRootSchema = z
  .object({
    path: RelativeSkillPathSchema,
    sourceId: z.string().min(1).max(160),
    sourceKind: z.enum(['agent', 'managed', 'dream']),
    digest: Sha256Schema,
    files: z
      .array(
        z
          .object({
            path: RelativeSkillPathSchema,
            mode: z.number().int().min(0).max(0o777),
            size: z.number().int().nonnegative(),
            sha256: Sha256Schema
          })
          .strict()
      )
      .max(64)
  })
  .strict()

export const ClusterSkillReconcileSchema = z
  .object({
    op: z.literal('reconcile'),
    operationId: z.string().uuid(),
    handle: z.string().min(16).max(128),
    authority: ClusterSkillAuthoritySchema,
    priorRoots: z.array(ClusterSkillPriorRootSchema).max(256),
    replayKey: z.string().regex(/^[a-f0-9]{64}$/),
    allowDesiredAdoption: z.boolean(),
    sources: z.array(ClusterSkillSourceSchema).max(MAX_CLUSTER_SKILL_SOURCES)
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>()
    for (const source of value.sources) {
      if (ids.has(source.sourceId)) ctx.addIssue({ code: 'custom', message: 'duplicate reconcile source' })
      ids.add(source.sourceId)
    }
    const receiptFiles = value.priorRoots.reduce((total, root) => total + root.files.length, 0)
    if (receiptFiles > MAX_CLUSTER_SKILL_FILES) ctx.addIssue({ code: 'custom', message: 'prior receipt exceeds limit' })
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CLUSTER_SKILL_CONTROL_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'reconcile request exceeds frame-safe limit' })
    }
  })

export const ClusterSkillVerifySchema = z
  .object({
    op: z.literal('verify'),
    roots: z.array(ClusterSkillPriorRootSchema).max(256)
  })
  .strict()

export const ClusterSkillRequestSchema = z.discriminatedUnion('op', [
  ClusterSkillBeginSchema,
  ClusterSkillManifestSchema,
  ClusterSkillUploadSchema,
  ClusterSkillReconcileSchema,
  ClusterSkillVerifySchema
])

export const ClusterSkillBeginReplySchema = z.object({ handle: z.string().min(16).max(128) }).strict()
export const ClusterSkillManifestReplySchema = z
  .object({ declared: z.number().int().nonnegative().max(MAX_CLUSTER_SKILL_FILES) })
  .strict()
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
                  .object({
                    path: RelativeSkillPathSchema,
                    mode: z.number().int().min(0).max(0o777),
                    size: z.number().int().nonnegative(),
                    sha256: Sha256Schema
                  })
                  .strict()
              )
              .max(64)
          })
          .strict()
      )
      .max(256),
    conflicts: z.array(RelativeSkillPathSchema).max(512)
  })
  .strict()
  .superRefine((value, ctx) => {
    const receiptFiles = value.roots.reduce((total, root) => total + root.files.length, 0)
    if (receiptFiles > MAX_CLUSTER_SKILL_FILES)
      ctx.addIssue({ code: 'custom', message: 'result receipt exceeds limit' })
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CLUSTER_SKILL_CONTROL_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'reconcile response exceeds frame-safe limit' })
    }
    const paths = new Set<string>()
    for (const root of value.roots) {
      if (paths.has(root.path)) ctx.addIssue({ code: 'custom', message: 'duplicate result root' })
      paths.add(root.path)
      if (createHash('sha256').update(JSON.stringify(root.files)).digest('hex') !== root.digest) {
        ctx.addIssue({ code: 'custom', message: 'result root digest does not match its receipt' })
      }
    }
  })
export const ClusterSkillVerifyReplySchema = z.object({ intact: z.array(z.boolean()).max(512) }).strict()

export type ClusterSkillBegin = z.infer<typeof ClusterSkillBeginSchema>
export type ClusterSkillManifest = z.infer<typeof ClusterSkillManifestSchema>
export type ClusterSkillManifestReply = z.infer<typeof ClusterSkillManifestReplySchema>
export type ClusterSkillFile = z.infer<typeof ClusterSkillFileSchema>
export type ClusterSkillUpload = z.infer<typeof ClusterSkillUploadSchema>
export type ClusterSkillReconcile = z.infer<typeof ClusterSkillReconcileSchema>
export type ClusterSkillVerify = z.infer<typeof ClusterSkillVerifySchema>
export type ClusterSkillRequest = z.infer<typeof ClusterSkillRequestSchema>
export type ClusterSkillBeginReply = z.infer<typeof ClusterSkillBeginReplySchema>
export type ClusterSkillUploadReply = z.infer<typeof ClusterSkillUploadReplySchema>
export type ClusterSkillReconcileReply = z.infer<typeof ClusterSkillReconcileReplySchema>
export type ClusterSkillVerifyReply = z.infer<typeof ClusterSkillVerifyReplySchema>
