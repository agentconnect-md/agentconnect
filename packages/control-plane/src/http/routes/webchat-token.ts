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
import { WEBCHAT_MULTI_AGENT_FEATURE } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId } from '../../domain/ids.js'
import { canView } from '../../authorization/policy.js'
import { ctxOf } from '../rbac.js'
import { ErrorDto } from '../dto/index.js'
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

    r.post(
      '/agents/:agentId/webchat/token',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Agents],
          summary: 'Mint a webchat token',
          description:
            'Mints a short-lived token the browser presents to the relay pool to start or resume a playground webchat session with this agent. A resume is allowed only for a conversation already owned by the authenticated user.',
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
        const agent = await deps.repos.agent.get(AgentId(req.params.agentId))
        if (!agent || agent.orgId !== req.orgCtx!.orgId || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        const userId = req.principal!.userId
        const conversationId = req.body.conversationId?.toLowerCase() ?? randomUUID()
        const binding = { conversationId, userId, agentId: agent.id, orgId: agent.orgId }
        if (req.body.conversationId) {
          if (!(await deps.repos.webchatConversation.owns(binding))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'conversation not found' })
          }
        } else {
          await deps.repos.webchatConversation.create(binding)
        }
        const token = await deps.webchatTokens.mint({
          userId,
          user: req.principal!.email ?? userId,
          agentId: agent.id,
          orgId: agent.orgId,
          conversationId
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
            'Mints a short-lived token the browser presents to the relay pool. Pass `agentIds` (first entry is the primary) to create a conversation — the roster is fixed at creation — or `conversationId` to resume one owned by the authenticated user. Creating with more than one agent requires every selected agent to be placed on a daemon that supports multi-agent webchat.',
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
          const owned = await deps.repos.webchatConversation.ownedBy(conversationId, orgId, userId)
          if (!owned) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'conversation not found' })
          }
          // The primary must still be viewable — losing access to a restricted
          // agent revokes resume, exactly like the legacy per-agent path.
          const primary = await deps.repos.agent.get(owned.primaryAgentId)
          if (!primary || primary.orgId !== orgId || !canView(primary, ctxOf(req))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'conversation not found' })
          }
          const token = await deps.webchatTokens.mint({
            userId,
            user: req.principal!.email ?? userId,
            agentId: primary.id,
            orgId,
            conversationId
          })
          return reply.send({ token, relayUrl, conversationId })
        }

        const agentIds = [...new Set(req.body.agentIds!)]
        const agents = []
        for (const id of agentIds) {
          const agent = await deps.repos.agent.get(AgentId(id))
          if (!agent || agent.orgId !== orgId || !canView(agent, ctxOf(req))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
          }
          agents.push(agent)
        }
        if (agents.length > 1) {
          // Capability gate at creation (webchat-multi-agents.md §6.3): every
          // selected agent's daemon must advertise multi-agent webchat support.
          for (const agent of agents) {
            const daemon = agent.daemonId ? deps.daemonConns.get(agent.daemonId) : undefined
            if (!daemon?.capabilities?.features?.includes(WEBCHAT_MULTI_AGENT_FEATURE)) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: `agent ${agent.id} is not on a daemon that supports multi-agent conversations`
              })
            }
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
          user: req.principal!.email ?? userId,
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
        const agent = await deps.repos.agent.get(AgentId(req.body.agentId))
        if (!agent || agent.orgId !== orgId || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        const roster = await deps.repos.webchatConversation.participants(conversationId)
        const respond = async () => {
          const updated = await deps.repos.webchatConversation.participants(conversationId)
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
          const existing = await deps.repos.agent.get(p.agentId)
          if (existing) rosterAgents.push(existing)
        }
        for (const member of rosterAgents) {
          const daemon = member.daemonId ? deps.daemonConns.get(member.daemonId) : undefined
          if (!daemon?.capabilities?.features?.includes(WEBCHAT_MULTI_AGENT_FEATURE)) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: `agent ${member.id} is not on a daemon that supports multi-agent conversations`
            })
          }
        }
        await deps.repos.webchatConversation.addParticipant(conversationId, agent.id, userId)
        return respond()
      }
    )
  }
}
