import { z } from 'zod'
import type { HttpDeps } from '../../http/deps.js'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { ErrorDto, IdParam } from '../../http/dto/index.js'
import { denyViewerWrite, orgOf } from '../../http/rbac.js'
import { BotId } from '../../domain/ids.js'
import { integrationToSpec, isGatedAgent } from '../../orchestrator/placement.js'
import { verifyQQBot } from './provider.js'

export function QQCredentialRoutes(deps: HttpDeps): FastifyPluginAsync {
  return async (app) => {
    app.withTypeProvider<ZodTypeProvider>().put(
      '/bots/:id/qq/credentials',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Update QQ bot credentials',
          description: 'Verify and replace the AppSecret for the same QQ bot, preserving its conversations.',
          operationId: 'updateQQBotCredentials',
          params: IdParam,
          body: z.object({ appSecret: z.string().trim().min(1) }),
          response: {
            200: z.object({ ok: z.literal(true) }),
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const bot = await deps.repos.bot.get(orgId, BotId(req.params.id))
        if (!bot || bot.platform !== 'qq' || !bot.externalAppId)
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'QQ bot not found.' })
        const checked = await verifyQQBot({ appId: bot.externalAppId, appSecret: req.body.appSecret })
        if (!checked.ok)
          return reply
            .code(checked.status)
            .send({ error: 'QQ credential check failed', statusCode: checked.status, message: checked.message })
        const material = { appToken: bot.externalAppId, botToken: req.body.appSecret, signingSecret: null }
        await deps.repos.botCredential.install(orgId, bot.id, material, new Date(deps.clock.now()))
        for (const integration of await deps.repos.integration.listForBot(bot.id)) {
          const agent = await deps.repos.agent.get(orgId, integration.agentId)
          if (!agent) continue
          const channels = await deps.repos.integrationChannel.listForIntegration(integration.id)
          const spec = await integrationToSpec(
            deps.platforms,
            integration,
            bot,
            material,
            channels,
            isGatedAgent(agent)
          )
          if (spec)
            await deps.agentDelivery.integrationUpsert(agent, spec, () => {
              req.log.info('QQ credential update will be applied when the agent reconnects')
            })
        }
        return { ok: true as const }
      }
    )
  }
}
