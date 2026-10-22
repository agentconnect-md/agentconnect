// A Teams bot's client-secret rotation and its app package download (teams-integration.md §2, §5).
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { BotDto, ErrorDto, IdParam } from '../../http/dto/index.js'
import { ctxOf, denyViewerWrite, orgOf } from '../../http/rbac.js'
import { canView } from '../../authorization/policy.js'
import { toBotDto } from '../../http/routes/bots.js'
import { pushBotConfig } from '../../http/bot-config-push.js'
import { relayHttpBase } from '../../http/relay-ingress.js'
import { agentIconBackgroundColor } from '../../agents/agent-icon.js'
import { BotId, IntegrationId } from '../../domain/ids.js'
import { MsTeamsCreateCredentials, msTeamsSecrets, verifyMsTeamsApp } from './provider.js'
import { MSTEAMS_APP_PACKAGE_FILENAME, msTeamsAppIcons, msTeamsAppPackage, msTeamsManifest } from './app-package.js'

const ReplaceMsTeamsSecretBody = MsTeamsCreateCredentials.pick({ clientSecret: true })

const MsTeamsAppPackageBody = {
  description: 'The Teams app package: manifest.json, color.png and outline.png at the archive root.',
  content: { 'application/zip': { schema: z.string().meta({ format: 'binary' }) } }
}

export function msTeamsRoutes(deps: HttpDeps, fetchImpl: typeof fetch = fetch) {
  return async function msTeamsRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.put(
      '/bots/:id/msteams/credentials',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Replace a Teams bot client secret',
          description:
            'Check a new Microsoft Entra client secret for this bot’s app with the same token request a new install runs, then store it in place of the current one and push it to every serving daemon. The app ID and tenant ID stay the bot’s identity; the secret is write-only and never reaches the relay.',
          operationId: 'replaceMsTeamsBotSecret',
          params: IdParam,
          body: ReplaceMsTeamsSecretBody,
          response: { 200: BotDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot || bot.platform !== MSTEAMS_PLATFORM || !bot.externalAppId || !bot.externalTenantId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'Teams bot not found.' })
        }
        const checked = await verifyMsTeamsApp(
          { appId: bot.externalAppId, tenantId: bot.externalTenantId, clientSecret: req.body.clientSecret },
          fetchImpl
        )
        if (!checked.ok) {
          return reply.code(checked.status).send({
            error: 'Teams credential check failed',
            statusCode: checked.status,
            ...(checked.code ? { code: checked.code } : {}),
            message: checked.message
          })
        }
        await deps.repos.botCredential.install(
          bot.orgId,
          bot.id,
          msTeamsSecrets(req.body.clientSecret),
          new Date(deps.clock.now())
        )
        const updated = (await deps.repos.bot.get(bot.orgId, bot.id)) ?? bot
        await pushBotConfig(deps, req.log, updated)
        return toBotDto(updated, deps.platforms)
      }
    )

    r.get(
      '/integrations/:id/msteams/app-package',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Download a Teams app package',
          description:
            'Build the Teams app package for this integration’s bot, to upload in the Teams admin center or as a custom app: a manifest naming the bot’s app ID in personal, team and group chat scopes, the resource-specific consent permissions that deliver channel and group chat messages, and the relay host as its only web domain, with the agent’s name and icon. The manifest ID is derived from the app ID, so a re-download updates the same Teams app; its version grows with each download. 409 MSTEAMS_RELAY_ORIGIN_MISSING when the deployment has no public relay origin.',
          operationId: 'downloadMsTeamsAppPackage',
          params: IdParam,
          response: { 200: MsTeamsAppPackageBody, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const notFound = () =>
          reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'Teams integration not found.' })
        const integration = await deps.repos.integration.get(orgOf(req), IntegrationId(req.params.id))
        if (!integration || integration.platform !== MSTEAMS_PLATFORM) return notFound()
        const agent = await deps.repos.agent.get(orgOf(req), integration.agentId)
        if (!agent || !canView(agent, ctxOf(req))) return notFound()
        const bot = await deps.repos.bot.get(orgOf(req), integration.botId)
        if (!bot?.externalAppId) return notFound()
        const relayBase = relayHttpBase(deps.config.PUBLIC_RELAY_URL)
        if (!relayBase) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            code: 'MSTEAMS_RELAY_ORIGIN_MISSING',
            message: 'This deployment has no public relay origin (PUBLIC_RELAY_URL), so Teams has nowhere to deliver.'
          })
        }
        const manifest = msTeamsManifest({
          appId: bot.externalAppId,
          relayHost: new URL(relayBase).host,
          agentName: agent.displayName ?? agent.name,
          accentColor: agentIconBackgroundColor(agent.icon),
          nowMs: deps.clock.now()
        })
        const icons = await msTeamsAppIcons(agent, deps.iconStore)
        // The typed reply knows only the documented string body; Fastify sends a Buffer raw, past the serializer.
        return (reply as FastifyReply)
          .header('content-type', 'application/zip')
          .header('content-disposition', `attachment; filename="${MSTEAMS_APP_PACKAGE_FILENAME}"`)
          .header('cache-control', 'private, no-store')
          .send(Buffer.from(msTeamsAppPackage(manifest, icons)))
      }
    )
  }
}
