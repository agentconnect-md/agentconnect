// A WeCom smart bot's Secret replacement: stored and pushed without a subscribe, which would evict the bot's live connection.
import type { FastifyInstance } from 'fastify'
import { WECOM_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { BotDto, ErrorDto, IdParam } from '../../http/dto/index.js'
import { denyViewerWrite, orgOf } from '../../http/rbac.js'
import { toBotDto } from '../../http/routes/bots.js'
import { pushBotConfig } from '../../http/bot-config-push.js'
import { BotId } from '../../domain/ids.js'
import { WeComCreateCredentials } from './provider.js'

const ReplaceWeComSecretBody = WeComCreateCredentials.pick({ secret: true })

export function weComCredentialRoutes(deps: HttpDeps) {
  return async function weComCredentialRoutesPlugin(app: FastifyInstance): Promise<void> {
    app.withTypeProvider<ZodTypeProvider>().put(
      '/bots/:id/wecom/credentials',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Bots],
          summary: 'Replace a WeCom smart bot secret',
          description:
            'Store a new long-connection Secret for this WeCom smart bot in place of the current one and push it to every serving daemon. WeCom allows one connection per bot and a check would evict the running one, so the Control Plane does not test the Secret here; the daemon reports whether it connects. The BotID stays the bot’s identity; the secret is write-only.',
          operationId: 'replaceWeComBotSecret',
          params: IdParam,
          body: ReplaceWeComSecretBody,
          response: { 200: BotDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot || bot.platform !== WECOM_PLATFORM || !bot.externalAppId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'WeCom bot not found.' })
        }
        const material = { botToken: req.body.secret, appToken: bot.externalAppId, signingSecret: null }
        await deps.repos.botCredential.install(bot.orgId, bot.id, material, new Date(deps.clock.now()))
        const updated = (await deps.repos.bot.get(bot.orgId, bot.id)) ?? bot
        await pushBotConfig(deps, req.log, updated)
        return toBotDto(updated, deps.platforms)
      }
    )
  }
}
