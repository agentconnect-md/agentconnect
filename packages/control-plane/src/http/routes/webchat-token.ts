/**
 * `http/routes/webchat-token.ts` — mints the short-lived browser webchat token
 * (shared-bot-relay.md §10, milestone A4).
 *
 *   POST /orgs/:orgId/agents/:agentId/webchat/token → { token, relayUrl, conversationId }
 *
 * The console calls this (authenticated as the human, org-scoped) BEFORE dialing the
 * relay pool: the CP checks the caller can view the agent, registers or verifies the
 * conversation's owner, then mints a token bound to
 * {userId, user, agentId, orgId, conversationId}. The browser dials `relayUrl` with that
 * token; the relay verifies it via `rc/verify(webchat-token)` and bridges to the agent's
 * daemon. This is the ONLY authentication the relay path needs — the CP never sees content.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { originKindOf, WEBCHAT_MULTI_AGENT_FEATURE } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, SessionId, type OrgId } from '../../domain/ids.js'
import type { ResolvableAgent } from '../../orchestrator/placementResolver.js'
import { canContinueSession, canView } from '../../authorization/policy.js'
import { makeSessionAccessResolver } from '../session-access.js'
import { resolveContinuationHost } from '../session-continuation.js'
import { ctxOf, orgOf } from '../rbac.js'
import { ErrorDto } from '../dto/index.js'
import { resolveProfilePictureUrl } from '../../icons/icon-store.js'
import { Tag } from '../plugins/openapi.js'

const Params = z.object({ orgId: z.string(), agentId: z.string().uuid() })
const Body = z.object({
  // Resume an existing conversation; omitted ⇒ the CP mints a fresh id.
  conversationId: z.string().uuid().optional()
})
const WebchatTokenDto = z.object({
  token: z.string(),
  relayUrl: z.string(),
  conversationId: z.string()
})

const ConversationParams = z.object({ orgId: z.string() })
const AddAgentParams = z.object({ orgId: z.string(), conversationId: z.string().uuid() })
const AddAgentBody = z.object({ agentId: z.string().uuid() })
const ConversationParticipantsDto = z.object({
  participants: z.array(z.object({ agentId: z.string(), primary: z.boolean().optional() }))
})
const WEBCHAT_ROSTER_CAP = 8
// Exactly one of the two: `agentIds` creates (roster fixed at creation, first
// entry = primary, webchat-multi-agents.md §3.1), `conversationId` resumes.
const ConversationBody = z
  .object({
    conversationId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).min(1).max(8).optional()
  })
  .refine((b) => (b.conversationId === undefined) !== (b.agentIds === undefined), {
    message: 'provide exactly one of conversationId (resume) or agentIds (create)'
  })

export function webchatTokenRoutes(deps: HttpDeps) {
  return async function webchatTokenRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const sessionAccess = makeSessionAccessResolver(deps)

    /** The identity the token attests. The handle is the transcript author line AND the name
     *  the daemon puts in a session worktree's branch, so the profile's full name wins over
     *  the sign-in address (`dev/jane-doe/…`, not `dev/jane-example-com/…`); the avatar is
     *  what a platform mirror of a console turn posts under. */
    const authorIdentity = async (
      userId: string,
      email: string | undefined
    ): Promise<{ user: string; userPicture?: string }> => {
      const profile = await deps.repos.user.getProfile(userId)
      const picture = profile
        ? resolveProfilePictureUrl(userId, profile.picture, profile.profilePictureUpdatedAt, deps.iconStore)
        : null
      // Only a fetchable https URL is worth carrying — the wire schema rejects anything else.
      const userPicture = picture && picture.length <= 2_048 && /^https:\/\//.test(picture) ? picture : undefined
      return { user: profile?.displayName?.trim() || email || userId, ...(userPicture ? { userPicture } : {}) }
    }

    /** The first roster agent whose serving daemon does not advertise multi-agent webchat, or
     *  undefined when every one of them does. The daemon comes from the resolver — the same
     *  answer `rc/verify` will reach — because a pool agent's row names no machine at all. */
    const firstWithoutMultiAgent = async (roster: readonly ResolvableAgent[]): Promise<string | undefined> => {
      for (const agent of roster) {
        const daemonId = await deps.placementResolver.dispatchDaemon(agent)
        const daemon = daemonId ? deps.daemonConns.get(daemonId) : undefined
        if (!daemon?.capabilities?.features?.includes(WEBCHAT_MULTI_AGENT_FEATURE)) return agent.id
      }
      return undefined
    }

    /** Mint-time fence (webchat-multi-agents.md §10.2): a resume requires the
     *  owner to currently `canView` EVERY participant, not only the primary —
     *  losing access to one restricted member revokes the whole conversation,
     *  since the minted token exposes and targets the full roster. */
    const allParticipantsViewable = async (
      conversationId: string,
      orgId: OrgId,
      ctx: ReturnType<typeof ctxOf>
    ): Promise<boolean> => {
      const roster = await deps.repos.webchatConversation.participants(orgId, conversationId)
      for (const p of roster) {
        const member = await deps.repos.agent.get(orgId, p.agentId)
        if (!member || !canView(member, ctx)) return false
      }
      return true
    }

    /** Who may RESUME a conversation: its owner always; anyone else under the same `session.continue` policy an
     *  integration-origin session gets — EVERY participant's current session visible to them and a non-viewer
     *  role, private sessions owner-only. A participant with no session yet (before the first turn, or a peer a
     *  targeted turn skipped) has nothing to judge, and the socket would let the caller target it into a session
     *  that is default-private to the owner — so any missing slot keeps the conversation the owner's. Unknown
     *  and foreign ids read as null, exactly like a refusal. */
    const resumableBy = async (
      req: Parameters<typeof ctxOf>[0] & { principal?: { userId: string } },
      conversationId: string
    ): Promise<{ primaryAgentId: AgentId } | null> => {
      const binding = await deps.repos.webchatConversation.resumeBinding(conversationId, orgOf(req))
      if (!binding) return null
      const resumable = { primaryAgentId: binding.primaryAgentId }
      if (binding.ownerUserId === req.principal!.userId) return resumable
      const ids = binding.currentSessionIds.filter((id): id is SessionId => id !== null)
      if (ids.length === 0 || ids.length !== binding.currentSessionIds.length) return null
      const sessions = await Promise.all(ids.map((id) => deps.repos.session.get(orgOf(req), id)))
      const rows = sessions.filter((s) => s !== null)
      if (rows.length !== sessions.length) return null
      const access = await sessionAccess.forSessions(req, rows)
      const ctx = ctxOf(req)
      return rows.every((s) => canContinueSession(s, ctx, access.identitySet, access.externalAccess)) ? resumable : null
    }

    r.post(
      '/agents/:agentId/webchat/token',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Agents],
          summary: 'Mint a webchat token',
          description:
            'Mints a short-lived token the browser presents to the relay pool to start or resume a playground webchat session with this agent. A resume is allowed for the conversation owner, and for any non-viewer member who may continue every session it currently stands on (org-visible sessions; private ones stay owner-only).',
          operationId: 'mintWebchatToken',
          params: Params,
          body: Body,
          response: { 200: WebchatTokenDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const relayUrl = deps.config.PUBLIC_RELAY_URL
        if (!relayUrl) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'webchat relay pool not configured' })
        }
        // Cross-org id OR a restricted agent the caller can't see both read as absent.
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        const userId = req.principal!.userId
        const conversationId = req.body.conversationId?.toLowerCase() ?? randomUUID()
        const binding = { conversationId, userId, agentId: agent.id, orgId: agent.orgId }
        if (req.body.conversationId) {
          // The asserted agent must be the conversation's primary on this per-agent path.
          const resumable = await resumableBy(req, conversationId)
          if (
            resumable?.primaryAgentId !== agent.id ||
            !(await allParticipantsViewable(conversationId, agent.orgId, ctxOf(req)))
          ) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'conversation not found' })
          }
        } else {
          await deps.repos.webchatConversation.create(binding)
        }
        const token = await deps.webchatTokens.mint({
          userId,
          ...(await authorIdentity(userId, req.principal!.email)),
          agentId: agent.id,
          orgId: agent.orgId,
          conversationId
        })
        return reply.send({ token, relayUrl, conversationId })
      }
    )

    // Session-targeted mint (webchat-cross-integration-continuation.md §6.2):
    // adopt an existing chat-origin session so the console composer can send a
    // human turn into it. The token claims stay standard — the target is
    // resolved server-side at verify time, never claimed by the browser.
    r.post(
      '/sessions/:sessionId/webchat/token',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Sessions],
          summary: 'Mint a session-continuation webchat token',
          description:
            'Mints a short-lived token the browser presents to the relay pool to continue an existing chat-origin session from the console composer. Requires continuation authorization, un-purged content, a daemon that can still serve the session content (its recorder, or a live member of the shared store it was written to), and continuation-capable daemon and relay pool.',
          operationId: 'mintWebchatSessionToken',
          params: z.object({ orgId: z.string(), sessionId: z.string() }),
          response: { 200: WebchatTokenDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const relayUrl = deps.config.PUBLIC_RELAY_URL
        if (!relayUrl) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'webchat relay pool not configured' })
        }
        const refuse = (code: 403 | 404 | 409 | 503, message: string) =>
          reply.code(code).send({
            error:
              code === 403
                ? 'Forbidden'
                : code === 404
                  ? 'Not Found'
                  : code === 409
                    ? 'Conflict'
                    : 'Service Unavailable',
            statusCode: code,
            message
          })
        const s = await deps.repos.session.get(orgOf(req), SessionId(req.params.sessionId))
        if (!s) return refuse(404, 'session not found')
        const ctx = ctxOf(req)
        const access = await sessionAccess.forSessions(req, [s])
        if (!canContinueSession(s, ctx, access.identitySet, access.externalAccess)) {
          return refuse(403, 'not authorized to continue this session')
        }
        if (s.contentPurgedAt) return refuse(409, 'session content was purged')
        if (originKindOf(s.platform ?? '') !== 'chat') return refuse(409, 'only chat sessions can be continued')
        const agent = await deps.repos.agent.get(orgOf(req), s.agentId)
        if (!agent || !canView(agent, ctx)) return refuse(404, 'session not found')
        const host = await resolveContinuationHost(deps, s, agent)
        if (!host.ok) {
          return refuse(
            409,
            host.reason === 'agent_moved'
              ? 'the agent moved since this session ran'
              : host.reason === 'daemon_offline'
                ? 'the session host is offline'
                : 'session continuation is not available yet'
          )
        }
        const userId = req.principal!.userId
        const { conversationId } = await deps.repos.webchatConversation.upsertSessionTargeted(
          { orgId: agent.orgId, agentId: agent.id, userId },
          s.id
        )
        const token = await deps.webchatTokens.mint({
          userId,
          ...(await authorIdentity(userId, req.principal!.email)),
          agentId: agent.id,
          orgId: agent.orgId,
          conversationId,
          ...(s.visibility === 'private' && s.ownerIdentity ? { privateSessionOwnerIdentity: s.ownerIdentity } : {})
        })
        return reply.send({ token, relayUrl, conversationId })
      }
    )

    // Conversation-scoped mint (webchat-multi-agents.md §6.2): creates a
    // conversation with its full roster in one call, or resumes an existing one
    // by id alone. The token claims stay primary-shaped — the relay resolves the
    // roster at verification time from the durable participant rows.
    r.post(
      '/webchat/conversations/token',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Agents],
          summary: 'Mint a conversation webchat token',
          description:
            'Mints a short-lived token the browser presents to the relay pool. Pass `agentIds` (first entry is the primary) to create a conversation — the roster is fixed at creation — or `conversationId` to resume one — as its owner, or as any non-viewer member who may continue every session it currently stands on (org-visible sessions; private ones stay owner-only). Creating with more than one agent requires every selected agent to be placed on a daemon that supports multi-agent webchat.',
          operationId: 'mintWebchatConversationToken',
          params: ConversationParams,
          body: ConversationBody,
          response: { 200: WebchatTokenDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const relayUrl = deps.config.PUBLIC_RELAY_URL
        if (!relayUrl) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'webchat relay pool not configured' })
        }
        const userId = req.principal!.userId
        const orgId = req.orgCtx!.orgId

        if (req.body.conversationId) {
          const conversationId = req.body.conversationId.toLowerCase()
          const resumable = await resumableBy(req, conversationId)
          if (!resumable) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'conversation not found' })
          }
          // EVERY participant must still be viewable — the minted token exposes
          // and targets the full roster, so losing access to one restricted
          // member revokes resume for the whole conversation.
          const primary = await deps.repos.agent.get(orgOf(req), resumable.primaryAgentId)
          if (
            !primary ||
            primary.orgId !== orgId ||
            !canView(primary, ctxOf(req)) ||
            !(await allParticipantsViewable(conversationId, orgId, ctxOf(req)))
          ) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'conversation not found' })
          }
          const token = await deps.webchatTokens.mint({
            userId,
            ...(await authorIdentity(userId, req.principal!.email)),
            agentId: primary.id,
            orgId,
            conversationId
          })
          return reply.send({ token, relayUrl, conversationId })
        }

        const agentIds = [...new Set(req.body.agentIds!)]
        const agents = []
        for (const id of agentIds) {
          const agent = await deps.repos.agent.get(orgOf(req), AgentId(id))
          if (!agent || !canView(agent, ctxOf(req))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
          }
          agents.push(agent)
        }
        if (agents.length > 1) {
          // Capability gate at creation (webchat-multi-agents.md §6.3): every
          // selected agent's daemon must advertise multi-agent webchat support.
          const ungated = await firstWithoutMultiAgent(agents)
          if (ungated) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: `agent ${ungated} is not on a daemon that supports multi-agent conversations`
            })
          }
        }
        const conversationId = randomUUID()
        const [primary, ...members] = agents
        await deps.repos.webchatConversation.create(
          { conversationId, userId, agentId: primary!.id, orgId },
          members.map((a) => a.id)
        )
        const token = await deps.webchatTokens.mint({
          userId,
          ...(await authorIdentity(userId, req.principal!.email)),
          agentId: primary!.id,
          orgId,
          conversationId
        })
        return reply.send({ token, relayUrl, conversationId })
      }
    )

    // Mid-conversation join (webchat-multi-agents.md §3.1): the owner may ADD a
    // participant to an existing conversation; removal stays unsupported. The
    // browser refreshes the relay's cached roster by simply reconnecting — a
    // fresh mint + rc/verify returns the grown roster, so no relay protocol is
    // involved. Growing past one participant suspends the delegated admin MCP
    // via the live per-request authority check (§10.3).
    r.post(
      '/webchat/conversations/:conversationId/agents',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Agents],
          summary: 'Add an agent to a webchat conversation',
          description:
            'Adds a participant agent to a conversation owned by the authenticated user (mid-conversation join). The agent must be viewable and placed on a daemon that supports multi-agent webchat — as must every existing participant. Idempotent for an agent already in the roster.',
          operationId: 'addWebchatConversationAgent',
          params: AddAgentParams,
          body: AddAgentBody,
          response: { 200: ConversationParticipantsDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const userId = req.principal!.userId
        const orgId = req.orgCtx!.orgId
        const conversationId = req.params.conversationId.toLowerCase()
        const owned = await deps.repos.webchatConversation.ownedBy(conversationId, orgId, userId)
        if (!owned) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'conversation not found' })
        }
        // A session-targeted conversation has exactly one participant — no
        // roster growth (webchat-cross-integration-continuation.md §6.2).
        const target = await deps.repos.webchatConversation.target(conversationId)
        if (target?.targetSessionId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'a session continuation has a fixed participant' })
        }
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        const roster = await deps.repos.webchatConversation.participants(orgId, conversationId)
        const respond = async () => {
          const updated = await deps.repos.webchatConversation.participants(orgId, conversationId)
          return reply.send({
            participants: updated.map((p) => ({
              agentId: p.agentId,
              ...(p.role === 'primary' ? { primary: true } : {})
            }))
          })
        }
        if (roster.some((p) => p.agentId === agent.id)) return respond()
        if (roster.length >= WEBCHAT_ROSTER_CAP) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'conversation is full' })
        }
        // Every participant of a multi-agent conversation — the new agent AND
        // the existing roster — must sit on a capability-advertising daemon
        // (webchat-multi-agents.md §6.3, enforced at each growth point).
        const rosterAgents = [agent]
        for (const p of roster) {
          const existing = await deps.repos.agent.get(orgOf(req), p.agentId)
          if (existing) rosterAgents.push(existing)
        }
        const ungated = await firstWithoutMultiAgent(rosterAgents)
        if (ungated) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: `agent ${ungated} is not on a daemon that supports multi-agent conversations`
          })
        }
        await deps.repos.webchatConversation.addParticipant(orgId, conversationId, agent.id, userId)
        return respond()
      }
    )
  }
}
