import { z } from 'zod'

/** Organization Knowledge wire contracts (organization-knowledge.md). */

export const OrganizationArtifactKind = z.enum(['knowledge', 'skill'])
export type OrganizationArtifactKind = z.infer<typeof OrganizationArtifactKind>

export const OrganizationSuggestionOperation = z.enum(['create', 'update'])
export type OrganizationSuggestionOperation = z.infer<typeof OrganizationSuggestionOperation>

export const OrganizationSuggestionState = z.enum(['proposed', 'accepted', 'rejected'])
export type OrganizationSuggestionState = z.infer<typeof OrganizationSuggestionState>

/** Pending suggestion JSON is pulled in bounded chunks so even the largest
 * accepted skill candidate remains below the control wire's 256 KiB frame cap. */
export const MAX_ORGANIZATION_SUGGESTION_BODY_BYTES = 4 * 1024 * 1024
export const ORGANIZATION_SUGGESTION_CHUNK_BYTES = 128 * 1024

export const SkillBundleTextFile = z
  .object({
    path: z.string().min(1).max(256),
    /** UTF-8 text by default; base64 permits binary assets in a complete Agent
     * Skills directory bundle without embedding raw binary in JSON. */
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
    content: z.string().max(699_052)
  })
  .strict()
export type SkillBundleTextFile = z.infer<typeof SkillBundleTextFile>

export const OrganizationSuggestionInfo = z
  .object({
    candidateId: z.string().uuid(),
    kind: OrganizationArtifactKind,
    operation: OrganizationSuggestionOperation,
    targetId: z.string().uuid().optional(),
    targetRevision: z.number().int().positive().optional(),
    title: z.string().min(1).max(128),
    summary: z.string().max(1024).optional(),
    tags: z.array(z.string().min(1).max(64)).max(16).optional(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    contentBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    state: OrganizationSuggestionState,
    sessionIds: z.array(z.string().min(1).max(256)).min(1).max(100),
    createdAt: z.string().datetime()
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasTarget = value.targetId !== undefined || value.targetRevision !== undefined
    if ((value.operation === 'update') !== hasTarget || (hasTarget && (!value.targetId || !value.targetRevision))) {
      ctx.addIssue({
        code: 'custom',
        message: 'update suggestions require both targetId and targetRevision; create suggestions require neither'
      })
    }
  })
export type OrganizationSuggestionInfo = z.infer<typeof OrganizationSuggestionInfo>

/** D→C: replace/upsert this daemon's bounded local suggestion inventory. */
export const OrganizationSuggestionsSyncReq = z
  .object({
    suggestions: z
      .array(
        OrganizationSuggestionInfo.extend({
          sourceAgentId: z.string().uuid(),
          dreamId: z.string().min(1).max(128)
        }).strict()
      )
      .max(256)
  })
  .strict()
export type OrganizationSuggestionsSyncReq = z.infer<typeof OrganizationSuggestionsSyncReq>

export const OrganizationSuggestionDecision = z
  .object({
    sourceAgentId: z.string().uuid(),
    dreamId: z.string().min(1).max(128),
    candidateId: z.string().uuid(),
    state: z.enum(['accepted', 'rejected'])
  })
  .strict()
export type OrganizationSuggestionDecision = z.infer<typeof OrganizationSuggestionDecision>

export const OrganizationSuggestionsSyncOk = z
  .object({ decisions: z.array(OrganizationSuggestionDecision).max(256) })
  .strict()
export type OrganizationSuggestionsSyncOk = z.infer<typeof OrganizationSuggestionsSyncOk>

export const KnowledgeSearchReq = z
  .object({
    requesterAgentId: z.string().uuid(),
    query: z.string().trim().min(1).max(4096),
    limit: z.number().int().min(1).max(10).default(5),
    maxBytes: z.number().int().min(1).max(32_768).default(8192),
    tags: z.array(z.string().trim().min(1).max(64)).max(10).optional()
  })
  .strict()
export type KnowledgeSearchReq = z.infer<typeof KnowledgeSearchReq>

export const KnowledgeSearchItem = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    summary: z.string().nullable(),
    tags: z.array(z.string()),
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
    content: z.string(),
    truncated: z.boolean()
  })
  .strict()
export type KnowledgeSearchItem = z.infer<typeof KnowledgeSearchItem>

export const KnowledgeSearchOk = z.object({ items: z.array(KnowledgeSearchItem).max(10) }).strict()
export type KnowledgeSearchOk = z.infer<typeof KnowledgeSearchOk>

// List (query-less) recent org knowledge the requester's org can see — the
// "browse what already exists" companion to knowledge/search, so a dreamer can
// enumerate existing knowledge before proposing new. Reuses KnowledgeSearchOk.
export const KnowledgeListReq = z
  .object({
    requesterAgentId: z.string().uuid(),
    limit: z.number().int().min(1).max(20).default(10),
    maxBytes: z.number().int().min(1).max(32_768).default(8192),
    tags: z.array(z.string().trim().min(1).max(64)).max(10).optional()
  })
  .strict()
export type KnowledgeListReq = z.infer<typeof KnowledgeListReq>

// List or search accepted organization skills (managed skill bundles) the
// requester's org can see. `query` present ⇒ filter by name/description; absent
// ⇒ list recent. Metadata only (no bundle bytes), so a dreamer can enumerate
// existing skills and choose update-vs-create.
export const OrgSkillsReq = z
  .object({
    requesterAgentId: z.string().uuid(),
    query: z.string().trim().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(50).default(20)
  })
  .strict()
export type OrgSkillsReq = z.infer<typeof OrgSkillsReq>

export const OrgSkillItem = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime()
  })
  .strict()
export type OrgSkillItem = z.infer<typeof OrgSkillItem>

export const OrgSkillsOk = z.object({ items: z.array(OrgSkillItem).max(50) }).strict()
export type OrgSkillsOk = z.infer<typeof OrgSkillsOk>

export const OrganizationSuggestionReadReq = z
  .object({
    sourceAgentId: z.string().uuid(),
    dreamId: z.string().min(1).max(128),
    candidateId: z.string().uuid(),
    kind: OrganizationArtifactKind,
    offset: z.number().int().nonnegative().max(MAX_ORGANIZATION_SUGGESTION_BODY_BYTES).default(0),
    limit: z
      .number()
      .int()
      .positive()
      .max(ORGANIZATION_SUGGESTION_CHUNK_BYTES)
      .default(ORGANIZATION_SUGGESTION_CHUNK_BYTES)
  })
  .strict()
export type OrganizationSuggestionReadReq = z.infer<typeof OrganizationSuggestionReadReq>

export const OrganizationKnowledgeCandidateContent = z
  .object({
    kind: z.literal('knowledge'),
    content: z.string().max(262_144),
    summary: z.string().max(1024).optional(),
    tags: z.array(z.string().min(1).max(64)).max(16).optional()
  })
  .strict()

export const OrganizationSkillCandidateContent = z
  .object({
    kind: z.literal('skill'),
    files: z.array(SkillBundleTextFile).min(1).max(64)
  })
  .strict()

export const OrganizationSuggestionContentBody = z.discriminatedUnion('kind', [
  OrganizationKnowledgeCandidateContent,
  OrganizationSkillCandidateContent
])
export type OrganizationSuggestionContentBody = z.infer<typeof OrganizationSuggestionContentBody>

/** Canonical bytes covered by suggestion metadata. Knowledge revisions keep
 * their longstanding content digest; a skill candidate covers its complete,
 * path-sorted file tree. Display metadata is independently compared with the
 * centrally indexed row during review. */
export function organizationSuggestionCanonical(body: OrganizationSuggestionContentBody): string {
  return body.kind === 'knowledge'
    ? body.content
    : JSON.stringify({
        kind: body.kind,
        // String comparison is locale-independent. `localeCompare` can order the
        // same Unicode paths differently on the daemon and CP hosts, which would
        // make an otherwise identical candidate fail its cross-host digest fence.
        files: [...body.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      })
}

/** Fully assembled application value. It is deliberately not a frame payload;
 * the wire carries {@link OrganizationSuggestionChunk} slices below. */
export const OrganizationSuggestionContent = z
  .object({
    sourceAgentId: z.string().uuid(),
    dreamId: z.string().min(1).max(128),
    candidateId: z.string().uuid(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    exists: z.boolean(),
    body: OrganizationSuggestionContentBody.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.exists !== (value.body !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'body must be present exactly when exists is true' })
    }
  })
export type OrganizationSuggestionContent = z.infer<typeof OrganizationSuggestionContent>

export const OrganizationSuggestionChunk = z
  .object({
    sourceAgentId: z.string().uuid(),
    dreamId: z.string().min(1).max(128),
    candidateId: z.string().uuid(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    exists: z.boolean(),
    size: z.number().int().nonnegative().max(MAX_ORGANIZATION_SUGGESTION_BODY_BYTES),
    offset: z.number().int().nonnegative().max(MAX_ORGANIZATION_SUGGESTION_BODY_BYTES),
    nextOffset: z.number().int().nonnegative().max(MAX_ORGANIZATION_SUGGESTION_BODY_BYTES),
    data: z.string().max(Math.ceil(ORGANIZATION_SUGGESTION_CHUNK_BYTES / 3) * 4),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !value.exists &&
      (value.size !== 0 || value.offset !== 0 || value.nextOffset !== 0 || value.data !== '' || value.truncated)
    ) {
      ctx.addIssue({ code: 'custom', message: 'a missing suggestion chunk must carry an empty zero-length body' })
    }
    if (
      value.exists &&
      (value.offset > value.size ||
        value.nextOffset < value.offset ||
        value.nextOffset > value.size ||
        value.truncated !== value.nextOffset < value.size)
    ) {
      ctx.addIssue({ code: 'custom', message: 'suggestion chunk offsets must be monotonic and bounded by size' })
    }
  })
export type OrganizationSuggestionChunk = z.infer<typeof OrganizationSuggestionChunk>

export const OrganizationSuggestionReviewReq = z
  .object({
    sourceAgentId: z.string().uuid(),
    dreamId: z.string().min(1).max(128),
    candidateId: z.string().uuid(),
    state: z.enum(['accepted', 'rejected'])
  })
  .strict()
export type OrganizationSuggestionReviewReq = z.infer<typeof OrganizationSuggestionReviewReq>

/** D→C: fetch one bounded slice of an immutable accepted `.skill` ZIP. */
export const ManagedSkillReadReq = z
  .object({
    requesterAgentId: z.string().uuid(),
    managedSkillId: z.string().uuid(),
    revision: z.number().int().positive(),
    offset: z.number().int().nonnegative().max(524_288).default(0),
    limit: z.number().int().positive().max(131_072).default(131_072)
  })
  .strict()
export type ManagedSkillReadReq = z.infer<typeof ManagedSkillReadReq>

export const ManagedSkillChunk = z
  .object({
    managedSkillId: z.string().uuid(),
    revision: z.number().int().positive(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    size: z.number().int().positive().max(524_288),
    offset: z.number().int().nonnegative().max(524_288),
    nextOffset: z.number().int().nonnegative().max(524_288),
    data: z.string().max(Math.ceil(131_072 / 3) * 4),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.offset > value.size ||
      value.nextOffset < value.offset ||
      value.nextOffset > value.size ||
      value.truncated !== value.nextOffset < value.size
    ) {
      ctx.addIssue({ code: 'custom', message: 'managed skill chunk offsets must be monotonic and bounded by size' })
    }
  })
export type ManagedSkillChunk = z.infer<typeof ManagedSkillChunk>
