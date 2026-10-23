// A DingTalk app's Client Secret rotation (dingtalk-integration.md §2): the same token exchange as a new install, then a push to every serving daemon.
import type { FastifyInstance } from 'fastify'
import { DINGTALK_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { BotDto, ErrorDto, IdParam } from '../../http/dto/index.js'
import { denyViewerWrite, orgOf } from '../../http/rbac.js'
import { toBotDto } from '../../http/routes/bots.js'
import { pushBotConfig } from '../../http/bot-config-push.js'
import { BotId } from '../../domain/ids.js'
import { DingTalkCreateCredentials, dingTalkEditionOf, verifyDingTalkApp } from './provider.js'

const ReplaceDingTalkSecretBody = DingTalkCreateCredentials.pick({ clientSecret: true })

export function dingTalkCredentialRoutes(deps: HttpDeps, fetchImpl: typeof fetch = fetch) {
  return async function dingTalkCredentialRoutesPlugin(app: FastifyInstance): Promise<void> {
    app.withTypeProvider<ZodTypeProvider>().put(
      '/bots/:id/dingtalk/credentials',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Replace a DingTalk app secret',
          description:
            'Check a new Client Secret for this bot’s DingTalk app with the same token exchange a new install runs, then store it in place of the current one and push it to every serving daemon. The Client ID stays the bot’s identity; the secret is write-only.',
          operationId: 'replaceDingTalkBotSecret',
          params: IdParam,
          body: ReplaceDingTalkSecretBody,
          response: { 200: BotDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot || bot.platform !== DINGTALK_PLATFORM || !bot.externalAppId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'DingTalk bot not found.' })
        }
        const credentials = {
          clientId: bot.externalAppId,
          clientSecret: req.body.clientSecret,
          edition: dingTalkEditionOf(bot)
        }
        const checked = await verifyDingTalkApp(credentials, fetchImpl)
        if (!checked.ok) {
          return reply.code(checked.status).send({
            error: 'DingTalk credential check failed',
            statusCode: checked.status,
            ...(checked.code ? { code: checked.code } : {}),
            message: checked.message
          })
        }
        const material = { botToken: credentials.clientSecret, appToken: credentials.clientId, signingSecret: null }
        await deps.repos.botCredential.install(bot.orgId, bot.id, material, new Date(deps.clock.now()))
        const updated = (await deps.repos.bot.get(bot.orgId, bot.id)) ?? bot
        await pushBotConfig(deps, req.log, updated)
        return toBotDto(updated, deps.platforms)
      }
    )
  }
}
