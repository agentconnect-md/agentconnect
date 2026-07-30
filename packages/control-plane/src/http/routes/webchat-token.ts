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
  }
}
