import type { SessionContext } from './context.js'
import { optionalString, requireString } from './validate.js'
import type { KnowledgeSearchOk, OrgSkillsOk } from '@agentconnect.md/protocol'

/** The organization-knowledge deps. All optional: a daemon whose CP does not advertise the
 *  feature carries no seam, and each tool then fails closed with its own message. */
export interface KnowledgeDeps {
  /** Owner-approved organization knowledge search; requester identity is bound
   * from the trusted session context. */
  findKnowledge?: (req: {
    requesterAgentId: string
    query: string
    limit: number
    maxBytes: number
    tags?: string[]
  }) => Promise<KnowledgeSearchOk>
  /** Browse recent org knowledge (query-less); requester identity bound from the
   * trusted session context. */
  listKnowledge?: (req: {
    requesterAgentId: string
    limit: number
    maxBytes: number
    tags?: string[]
  }) => Promise<KnowledgeSearchOk>
  /** List or search accepted org skills (metadata only); requester identity bound
   * from the trusted session context. `query` present ⇒ filter, absent ⇒ list. */
  orgSkills?: (req: { requesterAgentId: string; query?: string; limit: number }) => Promise<OrgSkillsOk>
}

/** The shared `tags` filter shape: absent, or an array of strings. */
function parseTags(args: Record<string, unknown>): string[] | undefined {
  const rawTags = args.tags
  if (rawTags !== undefined && (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== 'string'))) {
    throw new Error('tags must be an array of strings')
  }
  return rawTags as string[] | undefined
}

export async function findKnowledge(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: KnowledgeDeps
): Promise<unknown> {
  if (!deps.findKnowledge) throw new Error('organization knowledge is not available in this session')
  const query = requireString(args, 'query').trim()
  if (!query) throw new Error('query must not be blank')
  const rawLimit = args.limit
  const limit = rawLimit === undefined ? 5 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be an integer from 1 to 10')
  const tags = parseTags(args)
  const result = await deps.findKnowledge({
    requesterAgentId: ctx.agentId,
    query,
    limit,
    maxBytes: 8192,
    ...(tags?.length ? { tags } : {})
  })
  return { items: result.items }
}

export async function listKnowledge(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: KnowledgeDeps
): Promise<unknown> {
  if (!deps.listKnowledge) throw new Error('organization knowledge is not available in this session')
  const rawLimit = args.limit
  const limit = rawLimit === undefined ? 10 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20')
  const tags = parseTags(args)
  const result = await deps.listKnowledge({
    requesterAgentId: ctx.agentId,
    limit,
    maxBytes: 8192,
    ...(tags?.length ? { tags } : {})
  })
  return { items: result.items }
}

export async function listOrgSkills(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: KnowledgeDeps
): Promise<unknown> {
  if (!deps.orgSkills) throw new Error('organization skills are not available in this session')
  const query = optionalString(args, 'query')?.trim()
  const rawLimit = args.limit
  const limit = rawLimit === undefined ? 20 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50')
  const result = await deps.orgSkills({
    requesterAgentId: ctx.agentId,
    ...(query ? { query } : {}),
    limit
  })
  return { items: result.items }
}
