// A webchat conversation's own approval requests (product-conventions.md, What people can do in chat): its owner answers them where the agent lets people in chat approve, its editors always, and its owner their own join confirmations at any level; proxied to the owning daemon, nothing kept here.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  CONVERSATION_PERMISSION_REQUESTS_FEATURE,
  isSubsessionCoordinate,
  PERMISSION_REQUEST_NOT_IN_CONVERSATION
} from '@agentconnect.md/protocol'
import { canEdit, canView, canViewSession, ownsSession } from '../../authorization/policy.js'
import { chatApprovalsAllowed } from '../../domain/chat-actions.js'
import { ProtocolError } from '../../domain/errors.js'
import { SessionId, type DaemonId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import type { AgentRecord, SessionMetaRecord } from '../../persistence/ports.js'
import { ConnectionClosed } from '../../ws/registry.js'
import type { HttpDeps } from '../deps.js'
import {
  AgentPermissionDecisionBody,
  AgentPermissionRequestPageDto,
  ErrorDto,
  toPermissionRequestDto
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, orgOf } from '../rbac.js'
import { makeSessionAccessResolver } from '../session-access.js'

const ConversationParam = z.object({ sessionId: z.string().min(1).max(512) })
const DecisionParam = ConversationParam.extend({ requestId: z.string().uuid() })

type Failure = { status: 403 | 404 | 409 | 503; error: string; message: string; code?: string }

const send = (reply: FastifyReply, f: Failure) =>
  reply
    .code(f.status)
    .send({ error: f.error, statusCode: f.status, message: f.message, ...(f.code ? { code: f.code } : {}) })
const notFound = (message: string): Failure => ({ status: 404, error: 'Not Found', message })
const OFFLINE: Failure = {
  status: 503,
  error: 'Service Unavailable',
  message: 'agent has no live daemon',
  code: 'DAEMON_OFFLINE'
}

/** A daemon that could not be reached answers 503; anything else is the Control Plane's to report. */
function daemonFailure(err: unknown): Failure | null {
  if (err instanceof NoConnection || err instanceof ConnectionClosed) return OFFLINE
  if (err instanceof Error && err.message === 'connection closed') return OFFLINE
  if (err instanceof ProtocolError) {
    return { status: 503, error: 'Service Unavailable', message: `daemon rejected the request: ${err.message}` }
  }
  return null
}

export function sessionPermissionRequestRoutes(deps: HttpDeps) {
  return async function sessionPermissionRequestRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const access = makeSessionAccessResolver(deps)

    // A webchat conversation the caller may view: every request for its agent's editors and, where people in chat may approve, its owner; its owner's own join confirmations at any level.
    const admit = async (
      req: FastifyRequest,
      reply: FastifyReply
    ): Promise<{ row: SessionMetaRecord; agent: AgentRecord; daemonId: DaemonId; joinsOnly: boolean } | null> => {
      const row = await deps.repos.session.get(orgOf(req), SessionId((req.params as { sessionId: string }).sessionId))
      // Background work's page is read-only: its requests are answered in the conversation that started it.
      if (!row || row.platform !== 'webchat' || isSubsessionCoordinate(row.thread)) {
        await send(reply, notFound('conversation not found'))
        return null
      }
      const ctx = ctxOf(req)
      const audience = await access.forSessions(req, [row])
      const agent = await deps.repos.agent.get(orgOf(req), row.agentId)
      if (!canViewSession(row, ctx, audience.identitySet, audience.externalAccess) || !agent || !canView(agent, ctx)) {
        await send(reply, notFound('conversation not found'))
        return null
      }
      // An owner who is not an editor is a viewer: webchat lets anyone who can see the agent talk to it.
      const owner = ownsSession(row, audience.identitySet)
      const everything = canEdit(agent, ctx) || (owner && chatApprovalsAllowed(agent))
      if (!everything && !owner) {
        await send(reply, {
          status: 403,
          error: 'Forbidden',
          message: chatApprovalsAllowed(agent)
            ? 'only an Agent editor or the conversation’s owner can answer its requests'
            : 'only an Agent editor can answer this agent’s requests'
        })
        return null
      }
      const daemonId = await deps.placementResolver.servingDaemon(agent)
      if (!daemonId) {
        await send(reply, OFFLINE)
        return null
      }
      const daemon = await deps.registry.getAvailable(orgOf(req), daemonId)
      if (!daemon?.capabilities.features.includes(CONVERSATION_PERMISSION_REQUESTS_FEATURE)) {
        await send(reply, {
          status: 409,
          error: 'Conflict',
          message: 'this agent version cannot answer a conversation’s requests on its page; upgrade its daemon',
          code: 'DAEMON_FEATURE_MISSING'
        })
        return null
      }
      return { row, agent, daemonId, joinsOnly: !everything }
    }

    // The conversation's requests from its daemon; a caller admitted for join confirmations sees only those that ask them.
    const listed = async (
      admitted: { row: SessionMetaRecord; agent: AgentRecord; daemonId: DaemonId; joinsOnly: boolean },
      userId: string
    ) => {
      const sessionId = String(admitted.row.id)
      const page = await deps.control.agentPermissionRequests(admitted.daemonId, {
        agentId: admitted.agent.id,
        limit: 100,
        conversation: { sessionId }
      })
      // A daemon answers for the conversation asked about only; anything else is dropped rather than shown.
      return page.requests.filter(
        (r) =>
          (r.sessionId === sessionId || r.parentSessionId === sessionId) &&
          (!admitted.joinsOnly || (r.kind === 'join' && r.joinAskers?.includes(userId) === true))
      )
    }

    r.get(
      '/sessions/:sessionId/permission-requests',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'List a webchat conversation’s approval requests',
          description:
            'Proxies the owning daemon’s bounded, secret-masked approval requests of one webchat conversation and of the tasks it started, pending ones first. Callers who can edit the agent may read them, and so may the conversation’s owner while the agent lets people in chat approve tool calls (`chatActions` `approve` or `settings`); at any level the owner reads the join confirmations (`kind: join`) that ask them. The conversation must be one the caller may view. Answers 409 `DAEMON_FEATURE_MISSING` when the agent’s daemon cannot narrow its requests to one conversation. Nothing is stored by this call.',
          operationId: 'listSessionPermissionRequests',
          params: ConversationParam,
          response: { 200: AgentPermissionRequestPageDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply)
        if (!admitted) return reply
        try {
          return { requests: (await listed(admitted, ctxOf(req).userId)).map(toPermissionRequestDto) }
        } catch (err) {
          const failure = daemonFailure(err)
          if (!failure) throw err
          return send(reply, failure)
        }
      }
    )

    r.post(
      '/sessions/:sessionId/permission-requests/:requestId/decision',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Decide a webchat conversation’s approval request',
          description:
            'Allows or denies one pending runtime request of a webchat conversation or of a task it started, optionally by one of the options it offers, exactly as an Agent editor’s decision would. Callers who can edit the agent may decide, and so may the conversation’s owner while the agent lets people in chat approve tool calls (`chatActions` `approve` or `settings`); at any level the owner answers a join confirmation (`kind: join`) that asks them. The decider is recorded. Whichever surface answers first decides it: one no longer pending answers 409, and a request of another conversation answers 404. Answers 409 `DAEMON_FEATURE_MISSING` when the agent’s daemon cannot bind a decision to one conversation.',
          operationId: 'decideSessionPermissionRequest',
          params: DecisionParam,
          body: AgentPermissionDecisionBody,
          response: {
            200: z.object({ ok: z.literal(true) }),
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply)
        if (!admitted) return reply
        try {
          // Stamped server-side (slack-approval-dm.md §6.2), never client-supplied.
          const me = ctxOf(req)
          // Admitted for join confirmations only: the request must be one that asks them, or it is not theirs to answer.
          if (admitted.joinsOnly && !(await listed(admitted, me.userId)).some((r) => r.id === req.params.requestId)) {
            return send(reply, {
              status: 403,
              error: 'Forbidden',
              message: 'only an Agent editor can answer this agent’s requests'
            })
          }
          const profile = await deps.repos.user.getProfile(me.userId).catch(() => null)
          const decidedByName = profile?.displayName ?? profile?.email ?? undefined
          const ack = await deps.control.agentPermissionDecision(admitted.daemonId, {
            agentId: admitted.agent.id,
            requestId: req.params.requestId,
            decision: req.body.decision,
            ...(req.body.optionId ? { optionId: req.body.optionId } : {}),
            decidedBy: `user:${me.userId}`,
            ...(decidedByName ? { decidedByName } : {}),
            conversation: { sessionId: String(admitted.row.id) }
          })
          if (!ack.ok && ack.reason === PERMISSION_REQUEST_NOT_IN_CONVERSATION) {
            return send(reply, notFound('permission request not found'))
          }
          if (!ack.ok) {
            return send(reply, {
              status: 409,
              error: 'Conflict',
              message: ack.reason ?? 'permission request is no longer pending'
            })
          }
          return { ok: true as const }
        } catch (err) {
          const failure = daemonFailure(err)
          if (!failure) throw err
          return send(reply, failure)
        }
      }
    )
  }
}
