// A Mattermost bot's token replacement: verified against the bot's stored serverUrl and user ID, stored, and pushed to serving daemons.
import type { FastifyInstance } from 'fastify'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { BotDto, ErrorDto, IdParam } from '../../http/dto/index.js'
import { denyViewerWrite, orgOf } from '../../http/rbac.js'
import { toBotDto } from '../../http/routes/bots.js'
import { pushBotConfig } from '../../http/bot-config-push.js'
import { BotId } from '../../domain/ids.js'
import { MattermostCreateCredentials, verifyMattermostBot, type MattermostCheckOptions } from './provider.js'

const ReplaceMattermostTokenBody = MattermostCreateCredentials.pick({ botToken: true })

export function mattermostCredentialRoutes(
  deps: HttpDeps,
  fetchImpl?: typeof fetch,
  checkOpts?: Pick<MattermostCheckOptions, 'allowPrivateNetwork' | 'allowlist'>
) {
  return async function mattermostCredentialRoutesPlugin(app: FastifyInstance): Promise<void> {
    app.withTypeProvider<ZodTypeProvider>().put(
      '/bots/:id/mattermost/credentials',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Bots],
          summary: 'Replace a Mattermost bot token',
          description:
            'Verify a new Bot Account token or Personal Access Token against the bot’s stored Mattermost server URL and bot user ID, then store it in place of the current token and push it to every serving daemon. The server URL and bot user ID stay the bot’s identity; the token is write-only.',
          operationId: 'replaceMattermostBotToken',
          params: IdParam,
          body: ReplaceMattermostTokenBody,
          response: { 200: BotDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        const serverUrl = typeof bot?.platformConfig?.serverUrl === 'string' ? bot.platformConfig.serverUrl : null
        const expectedBotUserId =
          (typeof bot?.platformConfig?.botUserId === 'string' ? bot.platformConfig.botUserId : null) ??
          bot?.botUserId ??
          (bot?.externalTenantId && bot.externalTenantId !== '-' ? bot.externalTenantId : null)
        if (!bot || bot.platform !== MATTERMOST_PLATFORM || !serverUrl || !expectedBotUserId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'Mattermost bot not found.' })
        }

        const checked = await verifyMattermostBot(
          { serverUrl, botToken: req.body.botToken },
          {
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
            ...(checkOpts?.allowPrivateNetwork !== undefined
              ? { allowPrivateNetwork: checkOpts.allowPrivateNetwork }
              : {}),
            ...(checkOpts?.allowlist ? { allowlist: checkOpts.allowlist } : {})
          }
        )
        if (!checked.ok) {
          return reply.code(checked.status).send({
            error: 'Mattermost credential check failed',
            statusCode: checked.status,
            ...(checked.code ? { code: checked.code } : {}),
            message: checked.message
          })
        }
        if (checked.identity.botUserId !== expectedBotUserId) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            code: 'MATTERMOST_BOT_MISMATCH',
            message: 'This token belongs to a different Mattermost user than the installed bot.'
          })
        }

        const nextUsername = checked.identity.platformConfig?.botUsername
        if (nextUsername && nextUsername !== bot.platformConfig?.botUsername) {
          await deps.repos.bot.mergeBotIdentity(bot.orgId, bot.id, () => ({
            platformConfig: { botUsername: nextUsername }
          }))
        }

        const material = { botToken: req.body.botToken, appToken: null, signingSecret: null }
        await deps.repos.botCredential.install(bot.orgId, bot.id, material, new Date(deps.clock.now()), {
          restoreRevokedMemberships: true
        })
        const updated = (await deps.repos.bot.get(bot.orgId, bot.id)) ?? bot
        await pushBotConfig(deps, req.log, updated)
        return toBotDto(updated, deps.platforms)
      }
    )
  }
}
