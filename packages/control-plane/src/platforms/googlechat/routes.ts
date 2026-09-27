// Installs the deployment-owned Google Chat app on an agent, the preset `agentconnect` agent by default (google-chat-integration.md §3).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import type { HttpDeps } from '../../http/deps.js'
import type { GoogleChatRouteSeams } from '../../http/platform-route-seams.js'
import { AgentId } from '../../domain/ids.js'
import { denyViewerWrite, ctxOf, orgOf } from '../../http/rbac.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { relayIngress } from '../../http/relay-ingress.js'
import { integrationPlatformAvailability } from '../../http/daemon-platform-capability.js'
import { installNewBot } from '../../http/install-bot.js'
import { BotExternalIdentityTaken } from '../../persistence/errors.js'
import { TENANTLESS_SENTINEL } from '../../persistence/ports.js'
import { ErrorDto, IntegrationDto } from '../../http/dto/index.js'
import { GOOGLE_CHAT_APP_TAKEN_MESSAGE, buildGoogleChatInstall, validateGoogleChatApp } from './provider.js'

const GoogleChatPlatformInstallBody = z.object({
  /** The agent to connect; omitted ⇒ the organization's preset `agentconnect` agent. */
  agentId: z.string().uuid().optional()
})

export function googleChatPlatformInstallRoutes(deps: HttpDeps, googleChat: GoogleChatRouteSeams) {
  return async function googleChatPlatformInstallRoutesPlugin(app: FastifyInstance): Promise<void> {
    // No deployment-owned app ⇒ the route 404s and only per-agent apps remain.
    const platform = googleChat.app
    if (!platform) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/integrations/googlechat/platform-install',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Install the deployment Google Chat app',
          description:
            'Connect the Google Chat app configured in the Setup Server to an agent, the organization’s preset agent unless `agentId` names another. Validates the stored service-account key with one Chat API read and creates the bot and its integration; no key is pasted and none is returned. Requires the relay pool, because Google Chat delivers events only over HTTPS.',
          operationId: 'installGoogleChatPlatformApp',
          body: GoogleChatPlatformInstallBody,
          response: {
            201: IntegrationDto,
            400: ErrorDto,
            401: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        const orgId = req.orgCtx!.orgId
        const ingress = relayIngress(deps)
        if (!ingress.ok) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: ingress.message })
        }

        const agentId = req.body.agentId ?? (await deps.repos.presetAgent.get(orgId, 'general'))?.agentId
        if (!agentId) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'no target agent: pass agentId (the agentconnect preset is absent in this organization)'
          })
        }
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // An unplaced agent is allowed, as for the Slack app; a placed one must be served by a daemon that runs Google Chat.
        const servingDaemonId = await deps.placementResolver.servingDaemon(agent)
        if (servingDaemonId) {
          const availability = await integrationPlatformAvailability(deps, {
            daemonId: servingDaemonId,
            orgId,
            viewer: ctxOf(req),
            platform: GOOGLE_CHAT_PLATFORM
          })
          if (availability === 'not_found') {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
          }
          if (availability === 'unsupported') {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: `daemon does not support ${GOOGLE_CHAT_PLATFORM} integrations`
            })
          }
        }

        // One bot per Chat app, across organizations; checked before spending a Google round trip.
        if (
          await deps.repos.bot.getByExternalIdentity(GOOGLE_CHAT_PLATFORM, platform.projectNumber, TENANTLESS_SENTINEL)
        ) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: GOOGLE_CHAT_APP_TAKEN_MESSAGE })
        }
        const validated = await validateGoogleChatApp(platform, googleChat.fetch)
        if (!validated.ok) {
          return reply.code(validated.status).send({
            error: validated.status === 400 ? 'Bad Request' : 'Service Unavailable',
            statusCode: validated.status,
            ...(validated.code ? { code: validated.code } : {}),
            message: validated.message
          })
        }

        try {
          const { integration } = await installNewBot(deps, req.log, {
            ...buildGoogleChatInstall(platform),
            orgId,
            agent,
            platform: GOOGLE_CHAT_PLATFORM,
            name: validated.identity.name ?? agent.name,
            transport: 'http',
            prebuilt: true,
            createdByUserId: req.principal.userId
          })
          return reply.code(201).send({
            id: integration.id,
            name: integration.name,
            platform: integration.platform,
            agentId: integration.agentId,
            botId: integration.botId,
            status: integration.status,
            createdAt: integration.createdAt.toISOString(),
            channels: []
          })
        } catch (err) {
          // The composite unique fired between the pre-check and the insert.
          if (err instanceof BotExternalIdentityTaken) {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: GOOGLE_CHAT_APP_TAKEN_MESSAGE })
          }
          throw err
        }
      }
    )
  }
}
