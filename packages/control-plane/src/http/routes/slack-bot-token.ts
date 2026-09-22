// `POST /bots/:id/slack/token` — replace a custom Slack app's bot token in place, restoring what a revocation took.
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { SlackRouteSeams } from '../platform-route-seams.js'
import { BotId } from '../../domain/ids.js'
import { denyViewerWrite, orgOf } from '../rbac.js'
import { BotDto, ErrorDto, IdParam, ReplaceSlackBotTokenBody } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { pushBotConfig } from '../bot-config-push.js'
import { toBotDto } from './bots.js'

export function slackBotTokenRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async function slackBotTokenRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/bots/:id/slack/token',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Replace a Slack bot token',
          description:
            "Verify a new Bot User OAuth Token for a custom Slack app against Slack, require the same app and workspace, then store it in place of the current token. The bot's other credentials are kept. Integrations revoked with the previous token are restored with their ids, conversation settings and schedule targets, and every serving daemon receives the new token. Built-in apps reconnect by reinstalling instead.",
          operationId: 'replaceSlackBotToken',
          params: IdParam,
          body: ReplaceSlackBotTokenBody,
          response: { 200: BotDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        // Org-fenced read: another org's bot reads as absent, like a bot with no Slack token.
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot || bot.platform !== 'slack') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'Slack bot not found' })
        }
        if (bot.prebuilt) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'the built-in Slack app gets a new token by reinstalling it in Slack'
          })
        }
        const secret = await deps.repos.botSecret.get(bot.orgId, bot.id)
        if (!secret) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'Slack app credentials are unavailable' })
        }

        const checked = slack.verifyBot
          ? await slack.verifyBot(req.body.botToken)
          : ({ status: 'unreachable' } as const)
        if (checked.status === 'invalid') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: `Slack rejected this bot token: ${checked.error}`,
            code: checked.error
          })
        }
        // An unconfirmed identity must not replace a credential, so an unreachable Slack refuses instead of guessing.
        if (checked.status === 'unreachable') {
          return reply.code(502).send({
            error: 'Bad Gateway',
            statusCode: 502,
            message: 'Couldn’t reach Slack to check this token. Try again.'
          })
        }
        // The refresh route's app_mismatch criterion, extended to the workspace the bot was installed in.
        const appMismatch = !!bot.slackAppId && !!checked.appId && checked.appId !== bot.slackAppId
        const workspaceMismatch = !!bot.workspaceId && !!checked.teamId && checked.teamId !== bot.workspaceId
        if (appMismatch || workspaceMismatch) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'this token belongs to a different Slack app or workspace than this bot'
          })
        }

        // One transition: the new token, the generation bump, the cleared revocation and the restored memberships commit together.
        const revision = await deps.repos.botCredential.install(
          bot.orgId,
          bot.id,
          { ...secret, botToken: req.body.botToken },
          new Date(deps.clock.now()),
          { restoreRevokedMemberships: true }
        )
        req.log.info({ botId: bot.id, revision }, 'slack bot token replaced: credential generation advanced')
        // The granted set describes the credential that just landed; an absent header keeps the last known set.
        if (checked.scopes?.length) await deps.repos.bot.setGrantedScopes(bot.orgId, bot.id, checked.scopes)

        const updated = await deps.repos.bot.get(bot.orgId, bot.id)
        if (!updated) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'Slack bot not found' })
        }
        await pushBotConfig(deps, req.log, updated)
        return toBotDto(updated)
      }
    )
  }
}
