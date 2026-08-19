import { z } from 'zod'
import type { SessionContext } from './context.js'
import { coercedIntWithDefault, optionalString, parseArgs, requiredString } from './args.js'
import type { KnowledgeSearchOk, OrgSkillsOk } from '@agentconnect.md/protocol'

/** The shared `tags` filter: absent, or an array of strings. */
const tags = z.array(z.string('tags must be an array of strings'), 'tags must be an array of strings').optional()

/** `findKnowledge` arguments. `limit` keeps its historical `Number()` coercion and default. */
export const FIND_KNOWLEDGE_ARGS = z.object({
  query: requiredString('query')
    .transform((query) => query.trim())
    .refine((query) => query.length > 0, 'query must not be blank'),
  limit: coercedIntWithDefault(1, 10, 5, 'limit must be an integer from 1 to 10'),
  tags
})

/** `listKnowledge` arguments — the query-less browse form of {@link FIND_KNOWLEDGE_ARGS}. */
export const LIST_KNOWLEDGE_ARGS = z.object({
  limit: coercedIntWithDefault(1, 20, 10, 'limit must be an integer from 1 to 20'),
  tags
})

/** `listOrgSkills` arguments: `query` present ⇒ filter, absent ⇒ list. */
export const LIST_ORG_SKILLS_ARGS = z.object({
  query: optionalString('query').transform((query) => query?.trim()),
  limit: coercedIntWithDefault(1, 50, 20, 'limit must be an integer from 1 to 50')
})

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

export async function findKnowledge(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: KnowledgeDeps
): Promise<unknown> {
  if (!deps.findKnowledge) throw new Error('organization knowledge is not available in this session')
  const { query, limit, tags } = parseArgs(FIND_KNOWLEDGE_ARGS, args)
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
  const { limit, tags } = parseArgs(LIST_KNOWLEDGE_ARGS, args)
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
  const { query, limit } = parseArgs(LIST_ORG_SKILLS_ARGS, args)
  const result = await deps.orgSkills({
    requesterAgentId: ctx.agentId,
    ...(query ? { query } : {}),
    limit
  })
  return { items: result.items }
}
