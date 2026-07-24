/**
 * `http/routes/webchat-token.ts` — mints the short-lived browser webchat token
 * (shared-bot-relay.md §10, milestone A4).
 *
 *   POST /orgs/:orgId/agents/:agentId/webchat/token → { token, relayUrl, conversationId }
 *
 * The console calls this (authenticated as the human, org-scoped) BEFORE dialing the
 * relay pool: the CP checks the caller can view the agent, then mints a token bound to
 * {userId, user, agentId, orgId}. The browser dials `relayUrl` with that token; the
 * relay verifies it via `rc/verify(webchat-token)` and bridges to the agent's daemon.
 * This is the ONLY authentication the relay path needs — the CP never sees the content.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId } from '../../domain/ids.js'
import { canView } from '../visibility.js'
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
            'Mints a short-lived token the browser presents to the relay pool to start a playground webchat session with this agent. Returns the token, the relay ingress URL, and the conversation id (fresh, or echoed for resume).',
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
        const token = await deps.webchatTokens.mint({
          userId,
          user: req.principal!.email ?? userId,
          agentId: agent.id,
          orgId: agent.orgId
        })
        return reply.send({ token, relayUrl, conversationId: req.body.conversationId ?? randomUUID() })
      }
    )
  }
}
