// The Activity view of an assistant-mode agent (assistant-mode.md §1.7, §5.11): bounded reads and two edits proxied to the owning daemon, nothing kept here.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  ASSISTANT_ACTIVITY_DRAFTS_MAX,
  ASSISTANT_ACTIVITY_FEATURE,
  ASSISTANT_ACTIVITY_ITEMS_MAX,
  ASSISTANT_ACTIVITY_SUBSESSIONS_MAX,
  AssistantActivityDraft,
  AssistantActivityErrorReason,
  AssistantActivityGrant,
  AssistantActivityItem,
  AssistantActivityItemDetail,
  AssistantActivitySubsessionState,
  type AssistantActivityReadReq,
  type AssistantActivityReadResult,
  type AssistantActivityWriteReq
} from '@agentconnect.md/protocol'
import { canEdit, canView, canViewSession } from '../../authorization/policy.js'
import { ProtocolError } from '../../domain/errors.js'
import { AgentId, SessionId, type DaemonId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import type { AgentRecord, SessionMetaRecord } from '../../persistence/ports.js'
import { ConnectionClosed } from '../../ws/registry.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'
import { makeSessionAccessResolver } from '../session-access.js'

const IdParam = z.object({ id: z.string().uuid() })
const ItemParam = IdParam.extend({ itemId: z.string().min(1).max(512) })
const GrantParam = IdParam.extend({ grantId: z.string().regex(/^[0-9a-f]{32}$/) })

const ItemsPageDto = z.object({ items: z.array(AssistantActivityItem), truncated: z.boolean() })
const DraftsPageDto = z.object({ drafts: z.array(AssistantActivityDraft), truncated: z.boolean() })
const GrantsPageDto = z.object({ grants: z.array(AssistantActivityGrant), truncated: z.boolean() })
const SubsessionDto = z.object({
  /** The sub-session's id, present only when the caller may open it. */
  sessionId: z.string().nullable(),
  title: z.string().nullable(),
  state: AssistantActivitySubsessionState,
  startedAt: z.string(),
  /** The caller may see this sub-session's conversation; otherwise only its state and start are shown. */
  visible: z.boolean(),
  /** The conversation that opened it, when the caller may see it. */
  parent: z
    .object({
      sessionId: z.string(),
      title: z.string().nullable(),
      platform: z.string().nullable(),
      channelName: z.string().nullable()
    })
    .nullable()
})
const SubsessionsPageDto = z.object({ subsessions: z.array(SubsessionDto), truncated: z.boolean() })
const OkDto = z.object({ ok: z.literal(true) })

type Failure = { status: 404 | 409 | 503; error: string; message: string; code: string }

const send = (reply: FastifyReply, f: Failure) =>
  reply.code(f.status).send({ error: f.error, statusCode: f.status, message: f.message, code: f.code })
const notFound = (message: string): Failure => ({ status: 404, error: 'Not Found', message, code: 'NOT_FOUND' })
const MODE_OFF: Failure = {
  status: 409,
  error: 'Conflict',
  message: 'the agent is not in assistant mode',
  code: 'ASSISTANT_MODE_OFF'
}

/** A daemon refusal or an unreachable daemon as a status the console can act on; null ⇒ rethrow. */
export function assistantActivityFailure(err: unknown): Failure | null {
  if (err instanceof ProtocolError && err.code === 'BAD_PAYLOAD') {
    const reason = AssistantActivityErrorReason.safeParse(err.details?.reason)
    if (reason.success && reason.data === 'assistant-mode-off') return MODE_OFF
    if (reason.success && reason.data === 'unknown-agent') return notFound('agent not found on its daemon')
  }
  if (
    err instanceof NoConnection ||
    err instanceof ConnectionClosed ||
    (err instanceof Error && err.message === 'connection closed')
  )
    return { status: 503, error: 'Service Unavailable', message: 'owning daemon is offline', code: 'DAEMON_OFFLINE' }
  if (err instanceof ProtocolError)
    return {
      status: 503,
      error: 'Service Unavailable',
      message: `daemon rejected the request: ${err.message}`,
      code: 'DAEMON_REJECTED'
    }
  return null
}

export function agentAssistantActivityRoutes(deps: HttpDeps) {
  return async function agentAssistantActivityRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const access = makeSessionAccessResolver(deps)

    // Visible agent → editor (when asked) → assistant mode → serving daemon with the feature; the reply is sent on refusal.
    const admit = async (
      req: FastifyRequest,
      reply: FastifyReply,
      editorOnly: boolean
    ): Promise<{ agent: AgentRecord; daemonId: DaemonId } | null> => {
      const agent = await deps.repos.agent.get(orgOf(req), AgentId((req.params as { id: string }).id))
      if (!agent || !canView(agent, ctxOf(req))) {
        await send(reply, notFound('agent not found'))
        return null
      }
      if (editorOnly) {
        if (denyViewerWrite(req, reply)) return null
        if (!canEdit(agent, ctxOf(req))) {
          await reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
          return null
        }
      }
      if (agent.assistantMode?.enabled !== true) {
        await send(reply, MODE_OFF)
        return null
      }
      const daemonId = await deps.placementResolver.servingDaemon(agent)
      if (!daemonId) {
        await send(reply, {
          status: 503,
          error: 'Service Unavailable',
          message: 'agent has no live daemon',
          code: 'DAEMON_OFFLINE'
        })
        return null
      }
      const daemon = await deps.registry.getAvailable(orgOf(req), daemonId)
      if (!daemon?.capabilities.features.includes(ASSISTANT_ACTIVITY_FEATURE)) {
        await reply.code(409).send({
          error: 'Conflict',
          statusCode: 409,
          message: 'this agent version cannot show its activity; upgrade its daemon',
          code: 'DAEMON_FEATURE_MISSING'
        })
        return null
      }
      return { agent, daemonId }
    }

    const readSection = async <O extends AssistantActivityReadReq['operation']>(
      reply: FastifyReply,
      daemonId: string,
      req: Extract<AssistantActivityReadReq, { operation: O }>
    ): Promise<Extract<AssistantActivityReadResult, { operation: O }> | null> => {
      try {
        return (await deps.control.assistantActivityRead(daemonId, req)) as Extract<
          AssistantActivityReadResult,
          { operation: O }
        >
      } catch (err) {
        const failure = assistantActivityFailure(err)
        if (!failure) throw err
        await send(reply, failure)
        return null
      }
    }

    const writeEdit = async (reply: FastifyReply, daemonId: string, req: AssistantActivityWriteReq) => {
      try {
        return await deps.control.assistantActivityWrite(daemonId, req)
      } catch (err) {
        const failure = assistantActivityFailure(err)
        if (!failure) throw err
        await send(reply, failure)
        return null
      }
    }

    r.get(
      '/agents/:id/assistant/items',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an assistant-mode agent’s items',
          description: `Reads the items in the agent’s ledger from its daemon: \`section=open\` (the default) lists active and waiting items, \`closed\` lists done and dropped ones, most recently updated first, at most ${ASSISTANT_ACTIVITY_ITEMS_MAX}. Each item carries its title, status, what counts as done, when the agent noted it should check next, where it was asked and the places its followers follow it from — never who follows it or what was said. Anyone who can view the agent may read it; nothing is stored by this call.`,
          operationId: 'listAssistantItems',
          params: IdParam,
          querystring: z.object({
            section: z.enum(['open', 'closed']).default('open'),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(ASSISTANT_ACTIVITY_ITEMS_MAX)
              .default(ASSISTANT_ACTIVITY_ITEMS_MAX)
          }),
          response: { 200: ItemsPageDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, false)
        if (!admitted) return reply
        const page = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'items',
          section: req.query.section,
          limit: req.query.limit
        })
        return page ? { items: page.items, truncated: page.truncated } : reply
      }
    )

    r.get(
      '/agents/:id/assistant/items/:itemId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get an assistant-mode agent’s item',
          description:
            'Reads one ledger item with its team-visible summary and its newest observations, newest first. Anyone who can view the agent may read it.',
          operationId: 'getAssistantItem',
          params: ItemParam,
          response: { 200: AssistantActivityItemDetail, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, false)
        if (!admitted) return reply
        const answer = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'item',
          itemId: req.params.itemId
        })
        if (!answer) return reply
        return answer.item ?? send(reply, notFound('item not found'))
      }
    )

    r.delete(
      '/agents/:id/assistant/items/:itemId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Delete an assistant-mode agent’s item',
          description:
            'Removes one item from the agent’s ledger; the agent stops following it and its followers are no longer reported to. Only callers who can edit the agent may delete an item.',
          operationId: 'deleteAssistantItem',
          params: ItemParam,
          response: { 200: OkDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, true)
        if (!admitted) return reply
        const answer = await writeEdit(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'delete-item',
          itemId: req.params.itemId
        })
        if (!answer) return reply
        return answer.found ? { ok: true as const } : send(reply, notFound('item not found'))
      }
    )

    r.get(
      '/agents/:id/assistant/subsessions',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an assistant-mode agent’s sub-sessions',
          description: `Lists the background sub-sessions the agent opened, running ones first and then the most recent, at most ${ASSISTANT_ACTIVITY_SUBSESSIONS_MAX}. Anyone who can view the agent sees each one’s state and start; its title, its session and the conversation that opened it are included only where the caller may view that conversation.`,
          operationId: 'listAssistantSubsessions',
          params: IdParam,
          response: { 200: SubsessionsPageDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, false)
        if (!admitted) return reply
        const page = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'subsessions',
          limit: ASSISTANT_ACTIVITY_SUBSESSIONS_MAX
        })
        if (!page) return reply
        // The agent's own session rows only, so a daemon can never name another agent's conversation here.
        const ids = [
          ...new Set(page.subsessions.flatMap((s) => [s.parentSessionId, ...(s.sessionId ? [s.sessionId] : [])]))
        ]
        const rows = (await Promise.all(ids.map((id) => deps.repos.session.get(orgOf(req), SessionId(id))))).filter(
          (row): row is SessionMetaRecord => row !== null && row.agentId === admitted.agent.id
        )
        const audience = await access.forSessions(req, rows)
        const viewable = new Map(
          rows
            .filter((row) => canViewSession(row, ctxOf(req), audience.identitySet, audience.externalAccess))
            .map((row) => [String(row.id), row])
        )
        return {
          subsessions: page.subsessions.map((s) => {
            const child = s.sessionId ? viewable.get(s.sessionId) : undefined
            const parent = viewable.get(s.parentSessionId)
            // A sub-session takes its parent's audience; until its own row exists the parent decides.
            const visible = s.sessionId && rows.some((row) => String(row.id) === s.sessionId) ? !!child : !!parent
            return {
              sessionId: child ? String(child.id) : null,
              title: child?.title ?? null,
              state: s.state,
              startedAt: s.createdAt,
              visible,
              parent: parent
                ? {
                    sessionId: String(parent.id),
                    title: parent.title,
                    platform: parent.platform,
                    channelName: parent.channelName
                  }
                : null
            }
          }),
          truncated: page.truncated
        }
      }
    )

    r.get(
      '/agents/:id/assistant/drafts',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an assistant-mode agent’s pending drafts',
          description: `Lists the posts waiting for an internal member’s approval, the soonest to lapse first, at most ${ASSISTANT_ACTIVITY_DRAFTS_MAX}: where each would post, its exact text, who is asked to approve it and when it expires. Approval stays on the card; this read changes nothing. Only callers who can edit the agent may read it.`,
          operationId: 'listAssistantDrafts',
          params: IdParam,
          response: { 200: DraftsPageDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, true)
        if (!admitted) return reply
        const page = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'drafts',
          limit: ASSISTANT_ACTIVITY_DRAFTS_MAX
        })
        return page ? { drafts: page.drafts, truncated: page.truncated } : reply
      }
    )

    r.get(
      '/agents/:id/assistant/grants',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an assistant-mode agent’s post grants',
          description:
            'Lists the "always allow from here to there" grants that let the agent post from one conversation to another without asking, newest first. Only callers who can edit the agent may read them.',
          operationId: 'listAssistantPostGrants',
          params: IdParam,
          response: { 200: GrantsPageDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, true)
        if (!admitted) return reply
        const page = await readSection(reply, admitted.daemonId, { agentId: admitted.agent.id, operation: 'grants' })
        return page ? { grants: page.grants, truncated: page.truncated } : reply
      }
    )

    r.delete(
      '/agents/:id/assistant/grants/:grantId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Revoke an assistant-mode agent’s post grant',
          description:
            'Revokes one "always allow from here to there" grant; the next post along that route waits for approval again. Only callers who can edit the agent may revoke a grant.',
          operationId: 'revokeAssistantPostGrant',
          params: GrantParam,
          response: { 200: OkDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, true)
        if (!admitted) return reply
        const answer = await writeEdit(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'revoke-grant',
          grantId: req.params.grantId
        })
        if (!answer) return reply
        return answer.found ? { ok: true as const } : send(reply, notFound('grant not found'))
      }
    )
  }
}
