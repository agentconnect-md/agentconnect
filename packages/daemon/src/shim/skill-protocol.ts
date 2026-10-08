import { z } from 'zod'
import { createHash } from 'node:crypto'
import { ClusterSkillOwnedRootSchema, ClusterSkillPathSchema } from '../store/cluster-skill-ledger.js'
import { MAX_SKILL_BUNDLES } from '../skills/skill-limits.js'
import { bundleUriProblem, isValidBranchRef, isValidFullRef } from '../workspace/git-command-policy.js'

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
export const MAX_SKILL_GIT_URL_LENGTH = 2048
export const MAX_SKILL_GET_URL_LENGTH = 8192

/** Advertised by a shim that clones Git skill Sources itself; the daemon's grant for it is `skills-git`. */
export const SKILL_GIT_IN_POD_FEATURE = 'skill-git-in-pod-v1' as const

/** What `cluster-skills-v1` admits — a daemon takes over a running pod, so it may be older than us.
 *  That image has no `manifest` op, so its whole file list must still fit one `begin` frame. */
export const LEGACY_MAX_CLUSTER_SKILL_FILES = 256
export const LEGACY_MAX_CLUSTER_SKILL_TOTAL_BYTES = 32 * 1024 * 1024

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const DecimalTermSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .max(40)
const RelativeSkillPathSchema = ClusterSkillPathSchema

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
    sha256: Sha256Schema,
    executable: z.boolean().optional()
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

const SelectionsSchema = z.array(z.string().min(1).max(128)).max(MAX_CLUSTER_SKILL_SELECTIONS)
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/, { message: 'must be a full lowercase SHA-1' })

/** A source the daemon acquired and uploaded file by file. */
export const ClusterSkillUploadedSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    sourceKind: z.enum(['agent', 'managed', 'dream']),
    selections: SelectionsSchema
  })
  .strict()

// An https clone address with a host, no userinfo, query or fragment, and nothing Git could read as an option.
const SkillGitUrlSchema = z
  .string()
  .max(MAX_SKILL_GIT_URL_LENGTH)
  .refine((value) => {
    if (!/^https:\/\/[\x21-\x7e]+$/.test(value) || value.includes('\\')) return false
    try {
      const url = new URL(value)
      return url.hostname !== '' && url.username === '' && url.password === '' && !url.search && !url.hash
    } catch {
      return false
    }
  }, 'must be an https clone URL without userinfo, query or fragment')

// The resolved full ref a tracked Source follows; a bare name or `HEAD` is resolved by the daemon first.
const SkillGitRefSchema = z
  .string()
  .refine(
    (value) => isValidBranchRef(value) || isValidFullRef(value, 'refs/tags/'),
    'must be a full refs/heads/* or refs/tags/* name'
  )

// A contained relative directory; no component Git could read as an option or that names repository metadata.
const SkillGitSubDirSchema = ClusterSkillPathSchema.refine(
  (value) => value.split('/').every((part) => !part.startsWith('-') && part.toLowerCase() !== '.git'),
  'subdirectory must not name an option or .git'
)

/** A Git Source the shim clones itself (source-cache.md §8); `ref` is absent only for a pinned SHA. */
export const GitSkillPlanSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    sourceKind: z.literal('git'),
    url: SkillGitUrlSchema,
    ref: SkillGitRefSchema.optional(),
    // Every P2 Source is daemon-resolved, so the commit to install is always named.
    plannedCommit: CommitSchema,
    subDir: SkillGitSubDirSchema.optional(),
    selections: SelectionsSchema,
    // Resolution failed on an installed Source: keep its installed roots at `plannedCommit` rather than fail it.
    keepInstalled: z.boolean().optional(),
    // A presigned GET of the Source's own access class, passed as `--bundle-uri`; dropped when the plan is over budget.
    getUrl: z
      .string()
      .max(MAX_SKILL_GET_URL_LENGTH)
      .superRefine((value, ctx) => {
        const problem = bundleUriProblem(value)
        if (problem) ctx.addIssue({ code: 'custom', message: `getUrl ${problem}` })
      })
      .optional()
  })
  .strict()
  .refine((value) => !(value.keepInstalled && value.getUrl), 'a keepInstalled entry carries no getUrl')

export const ClusterSkillSourceSchema = z.union([ClusterSkillUploadedSourceSchema, GitSkillPlanSchema])

export const ClusterSkillPriorRootSchema = ClusterSkillOwnedRootSchema

export const ClusterSkillReconcileSchema = z
  .object({
    op: z.literal('reconcile'),
    operationId: z.string().uuid(),
    handle: z.string().min(16).max(128),
    authority: ClusterSkillAuthoritySchema,
    priorRoots: z.array(ClusterSkillPriorRootSchema).max(MAX_SKILL_BUNDLES),
    priorRootCount: z.number().int().min(0).max(MAX_SKILL_BUNDLES).optional(),
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
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CLUSTER_SKILL_CONTROL_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'reconcile request exceeds frame-safe limit' })
    }
  })

export const ClusterSkillVerifySchema = z
  .object({
    op: z.literal('verify'),
    roots: z.array(ClusterSkillPriorRootSchema).max(MAX_SKILL_BUNDLES)
  })
  .strict()
  .superRefine(assertSkillControlSize)

export const ClusterSkillPriorSchema = z
  .object({
    op: z.literal('prior'),
    operationId: z.string().uuid(),
    handle: z.string().min(16).max(128),
    offset: z.number().int().min(0).max(MAX_SKILL_BUNDLES),
    roots: z.array(ClusterSkillPriorRootSchema).min(1).max(MAX_SKILL_BUNDLES)
  })
  .strict()
  .superRefine(assertSkillControlSize)

export const ClusterSkillReceiptSchema = z
  .object({
    op: z.literal('receipt'),
    operationId: z.string().uuid(),
    handle: z.string().min(16).max(128),
    offset: z.number().int().min(0).max(MAX_SKILL_BUNDLES)
  })
  .strict()

export const ClusterSkillRequestSchema = z.discriminatedUnion('op', [
  ClusterSkillBeginSchema,
  ClusterSkillManifestSchema,
  ClusterSkillUploadSchema,
  ClusterSkillReconcileSchema,
  ClusterSkillVerifySchema,
  ClusterSkillPriorSchema,
  ClusterSkillReceiptSchema
])

export const ClusterSkillPriorReplySchema = z
  .object({ received: z.number().int().min(0).max(MAX_SKILL_BUNDLES) })
  .strict()

export const ClusterSkillBeginReplySchema = z.object({ handle: z.string().min(16).max(128) }).strict()
export const ClusterSkillManifestReplySchema = z
  .object({ declared: z.number().int().nonnegative().max(MAX_CLUSTER_SKILL_FILES) })
  .strict()
export const ClusterSkillUploadReplySchema = z
  .object({ received: z.number().int().nonnegative().max(MAX_CLUSTER_SKILL_FILE_BYTES), complete: z.boolean() })
  .strict()
/** Why a Source was skipped (source-cache.md §11): an enumerated code, never Git's or the CLI's raw output. */
export const SkillSkipCodeSchema = z.enum([
  'resolution_failed',
  'access_denied',
  'ref_moved',
  'commit_unavailable',
  'sha_fetch_refused',
  'fetch_failed',
  'limits_exceeded',
  'cli_failed'
])
/** A source the shim could not install this run: its prior roots stay untouched and the run counts as failed, so the next preparation retries. */
export const ClusterSkillSkippedSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    // Free text stays for daemons that predate `code`.
    reason: z.string().min(1).max(1024),
    code: SkillSkipCodeSchema.optional()
  })
  .strict()
/** What the shim installed from one Git plan Source: the commit it checked out and the skill leaves it found. */
export const GitSkillSourceResultSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    resolvedCommit: CommitSchema,
    leaves: z.array(z.string().min(1).max(128)).max(MAX_CLUSTER_SKILL_SELECTIONS)
  })
  .strict()
/** A Git plan clone the shim kept for the daemon's asynchronous write-back (source-cache.md §9). */
export const SkillWriteBackCandidateSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    branch: z.string().refine(isValidBranchRef, 'must be a full refs/heads/* name'),
    commit: CommitSchema,
    handle: z.uuid()
  })
  .strict()
export const ClusterSkillReconcileResultSchema = z
  .object({
    roots: z.array(ClusterSkillPriorRootSchema).max(MAX_SKILL_BUNDLES),
    conflicts: z.array(RelativeSkillPathSchema).max(MAX_SKILL_BUNDLES),
    skipped: z.array(ClusterSkillSkippedSourceSchema).max(MAX_CLUSTER_SKILL_SOURCES).optional(),
    // Present only in the reply to a Git plan reconcile; an older daemon's strict schema refuses them.
    gitSources: z.array(GitSkillSourceResultSchema).max(MAX_CLUSTER_SKILL_SOURCES).optional(),
    writeBackCandidates: z.array(SkillWriteBackCandidateSchema).max(MAX_CLUSTER_SKILL_SOURCES).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const leaves = (value.gitSources ?? []).reduce((total, source) => total + source.leaves.length, 0)
    if (leaves > MAX_CLUSTER_SKILL_SELECTIONS) ctx.addIssue({ code: 'custom', message: 'too many Git skill leaves' })
    const paths = new Set<string>()
    for (const root of value.roots) {
      if (paths.has(root.path)) ctx.addIssue({ code: 'custom', message: 'duplicate result root' })
      paths.add(root.path)
      if (createHash('sha256').update(JSON.stringify(root.files)).digest('hex') !== root.digest) {
        ctx.addIssue({ code: 'custom', message: 'result root digest does not match its receipt' })
      }
    }
  })

export const ClusterSkillReconcileReplySchema = ClusterSkillReconcileResultSchema.superRefine(assertSkillControlSize)
export const ClusterSkillReceiptPageSchema = ClusterSkillReconcileResultSchema.safeExtend({
  nextOffset: z.number().int().min(1).max(MAX_SKILL_BUNDLES).optional()
}).superRefine(assertSkillControlSize)

function assertSkillControlSize(value: unknown, ctx: z.RefinementCtx): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CLUSTER_SKILL_CONTROL_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'skill control message exceeds frame-safe limit' })
  }
}

// A receipt root stays whole; its own file and path limits guarantee it fits in one page.
export function skillControlPages<T>(
  rows: T[],
  maxRows = MAX_CLUSTER_SKILL_MANIFEST_PAGE,
  overheadBytes = 2048
): T[][] {
  const budget = MAX_CLUSTER_SKILL_CONTROL_BYTES - overheadBytes
  const pages: T[][] = [[]]
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1
    if (size > budget) throw new Error('skill control row exceeds frame-safe limit')
    if (pages.at(-1)!.length > 0 && (pages.at(-1)!.length >= maxRows || bytes + size > budget)) {
      pages.push([])
      bytes = 0
    }
    pages.at(-1)!.push(row)
    bytes += size
  }
  return pages
}

export function skillReceiptPage(result: ClusterSkillReconcileReply, offset: number): ClusterSkillReceiptPage {
  if (offset > result.roots.length) throw new Error('skill receipt offset exceeds result')
  // Everything but the roots rides on every page like `conflicts`, so a paged reply cannot lose it.
  const extras = skillReplyExtras(result)
  const overhead = Buffer.byteLength(
    JSON.stringify({ roots: [], conflicts: result.conflicts, ...extras, nextOffset: MAX_SKILL_BUNDLES })
  )
  const roots = skillControlPages(result.roots.slice(offset), MAX_SKILL_BUNDLES, overhead)[0]!
  const nextOffset = offset + roots.length
  return ClusterSkillReceiptPageSchema.parse({
    roots,
    conflicts: result.conflicts,
    ...extras,
    ...(nextOffset < result.roots.length ? { nextOffset } : {})
  })
}

/** A reply's optional lists, each only when non-empty, so a shim never sends a field an older daemon refuses. */
export function skillReplyExtras(
  result: Pick<ClusterSkillReconcileReply, 'skipped' | 'gitSources' | 'writeBackCandidates'>
): Pick<ClusterSkillReconcileReply, 'skipped' | 'gitSources' | 'writeBackCandidates'> {
  return {
    ...(result.skipped && result.skipped.length > 0 ? { skipped: result.skipped } : {}),
    ...(result.gitSources && result.gitSources.length > 0 ? { gitSources: result.gitSources } : {}),
    ...(result.writeBackCandidates && result.writeBackCandidates.length > 0
      ? { writeBackCandidates: result.writeBackCandidates }
      : {})
  }
}

/** True when a reconcile carries a Git plan Source, the only request whose reply may use the Git-plan reply fields. */
export function isGitPlanReconcile(request: Pick<ClusterSkillReconcile, 'sources'>): boolean {
  return request.sources.some((source) => source.sourceKind === 'git')
}

/** The reply a shim may send for `request`: without a Git plan it is exactly the pre-`skill-git-in-pod-v1` shape. */
export function skillReplyFor(
  request: Pick<ClusterSkillReconcile, 'sources'>,
  reply: ClusterSkillReconcileReply
): ClusterSkillReconcileReply {
  if (isGitPlanReconcile(request)) return { roots: reply.roots, conflicts: reply.conflicts, ...skillReplyExtras(reply) }
  const skipped = (reply.skipped ?? []).map(({ sourceId, reason }) => ({ sourceId, reason }))
  return { roots: reply.roots, conflicts: reply.conflicts, ...(skipped.length > 0 ? { skipped } : {}) }
}

/** Drop GET URLs, last Source first, until the sent reconcile frame without prior roots fits; those clones run without a bundle. */
export function budgetSkillPlanUrls<T extends Pick<ClusterSkillReconcile, 'sources'>>(
  request: T,
  limit = MAX_CLUSTER_SKILL_CONTROL_BYTES
): T {
  const sources = [...request.sources]
  // Measures the frame reconcile() sends once prior roots page out, with the widest priorRootCount.
  const frame = (): unknown => ({
    op: 'reconcile',
    ...request,
    priorRoots: [],
    priorRootCount: MAX_SKILL_BUNDLES,
    sources
  })
  const measured = (): number => Buffer.byteLength(JSON.stringify(frame()))
  let bytes = measured()
  for (let index = sources.length - 1; index >= 0 && bytes > limit; index--) {
    const source = sources[index]!
    if (source.sourceKind !== 'git' || source.getUrl === undefined) continue
    const withoutUrl = { ...source }
    delete withoutUrl.getUrl
    sources[index] = withoutUrl
    bytes -= Buffer.byteLength(JSON.stringify(source)) - Buffer.byteLength(JSON.stringify(withoutUrl))
  }
  return { ...request, sources }
}

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
export type ClusterSkillReconcileReply = z.infer<typeof ClusterSkillReconcileResultSchema>
export type ClusterSkillSkippedSource = z.infer<typeof ClusterSkillSkippedSourceSchema>
export type ClusterSkillSource = z.infer<typeof ClusterSkillSourceSchema>
export type GitSkillPlan = z.infer<typeof GitSkillPlanSchema>
export type SkillSkipCode = z.infer<typeof SkillSkipCodeSchema>
export type GitSkillSourceResult = z.infer<typeof GitSkillSourceResultSchema>
export type SkillWriteBackCandidate = z.infer<typeof SkillWriteBackCandidateSchema>
export type ClusterSkillPrior = z.infer<typeof ClusterSkillPriorSchema>
export type ClusterSkillPriorReply = z.infer<typeof ClusterSkillPriorReplySchema>
export type ClusterSkillReceipt = z.infer<typeof ClusterSkillReceiptSchema>
export type ClusterSkillReceiptPage = z.infer<typeof ClusterSkillReceiptPageSchema>
export type ClusterSkillVerifyReply = z.infer<typeof ClusterSkillVerifyReplySchema>
