import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { z } from 'zod'
import { canEdit, canView } from '../../authorization/policy.js'
import { IntegrationId } from '../../domain/ids.js'
import { pushBotConfig } from '../../http/bot-config-push.js'
import type { HttpDeps } from '../../http/deps.js'
import { ErrorDto, IdParam } from '../../http/dto/index.js'
import { refreshMutationAgent } from '../../http/mutation-agent.js'
import { Tag } from '../../http/plugins/openapi.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { ctxOf, denyViewerWrite, orgOf } from '../../http/rbac.js'

const ReplySettings = z.object({ websocketRepliesOnly: z.boolean() })
const path = '/integrations/:id/mattermost/reply-settings'
const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'Mattermost integration not found' })

export function registerMattermostReplySettings(app: FastifyInstance, deps: HttpDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const resolve = async (req: FastifyRequest, id: string) => {
    const integration = await deps.repos.integration.get(orgOf(req), IntegrationId(id))
    if (integration?.platform !== MATTERMOST_PLATFORM) return null
    const agent = await deps.repos.agent.get(orgOf(req), integration.agentId)
    return agent && canView(agent, ctxOf(req)) ? { agent, integration } : null
  }
  routes.get(
    path,
    {
      schema: {
        tags: [Tag.Integrations],
        operationId: 'getMattermostReplySettings',
        params: IdParam,
        summary: 'Read a Mattermost integration’s card reply settings',
        description: 'Return the configured reply mode for cards posted by this Mattermost integration.',
        response: { 200: ReplySettings, 404: ErrorDto }
      }
    },
    async (req, reply) => {
      const found = await resolve(req, req.params.id)
      if (!found) return notFound(reply)
      return { websocketRepliesOnly: found.integration.mattermostWebsocketRepliesOnly ?? false }
    }
  )
  routes.put(
    path,
    {
      schema: {
        tags: [Tag.Integrations],
        operationId: 'updateMattermostReplySettings',
        params: IdParam,
        body: ReplySettings,
        summary: 'Set how a Mattermost integration receives card replies',
        description:
          'Enable numbered WebSocket replies for new cards even when a public button callback URL is available. Disabling the option restores automatic selection. Requires edit access to the agent.',
        response: { 200: ReplySettings, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
      }
    },
    async (req, reply) => {
      if (denyViewerWrite(req, reply)) return
      const found = await resolve(req, req.params.id)
      if (!found) return notFound(reply)
      if (!canEdit(found.agent, ctxOf(req)))
        return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
      const conflict = () =>
        reply
          .code(409)
          .send({ error: 'Conflict', statusCode: 409, message: 'agent is changing; retry the integration change' })
      const release = deps.agentMutations.tryBeginMutation(found.agent.id)
      if (!release) return conflict()
      try {
        if (!(await refreshMutationAgent(deps.repos.agent, found.agent))) return conflict()
        const { orgId, id, botId } = found.integration
        const bot = await deps.repos.bot.get(orgId, botId)
        if (
          !bot ||
          !(await deps.repos.integration.setMattermostWebsocketRepliesOnly(orgId, id, req.body.websocketRepliesOnly))
        )
          return notFound(reply)
        await pushBotConfig(deps, req.log, bot)
        return req.body
      } finally {
        release()
      }
    }
  )
}
