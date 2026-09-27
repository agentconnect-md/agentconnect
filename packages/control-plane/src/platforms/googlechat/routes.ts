// Installs the deployment-owned Google Chat app on an agent, the preset `agentconnect` agent by default (google-chat-integration.md §3).
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import type { HttpDeps } from '../../http/deps.js'
import type { GoogleChatRouteSeams } from '../../http/platform-route-seams.js'
import { AgentId, BotId } from '../../domain/ids.js'
import { denyViewerWrite, ctxOf, orgOf } from '../../http/rbac.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { relayIngress } from '../../http/relay-ingress.js'
import { integrationPlatformAvailability } from '../../http/daemon-platform-capability.js'
import { installNewBot } from '../../http/install-bot.js'
import { BotExternalIdentityTaken } from '../../persistence/errors.js'
import { TENANTLESS_SENTINEL, type AgentRecord, type BotSecretMaterial } from '../../persistence/ports.js'
import { BotDto, ErrorDto, IdParam, IntegrationDto } from '../../http/dto/index.js'
import { toDto as toIntegrationDto } from '../../http/routes/integrations.js'
import { toBotDto } from '../../http/routes/bots.js'
import {
  GOOGLE_CHAT_APP_TAKEN_MESSAGE,
  buildGoogleChatInstall,
  googleChatRowKind,
  resolveGoogleChatApp
} from './provider.js'
import { googleChatTenantOf } from './tenant.js'

/** The 409 copy when the deployment's project ID no longer matches the installed bot of the same project number. */
export const GOOGLE_CHAT_PROJECT_CHANGED_MESSAGE =
  'The deployment’s Google Chat app now names a different project than the installed bot; a different project needs a new installation.'

const GoogleChatPlatformInstallBody = z.object({
  /** The agent to connect; omitted ⇒ the organization's preset `agentconnect` agent. */
  agentId: z.string().uuid().optional()
})

/** Whether the console may offer the deployment-owned app: it is configured and a relay can receive its events. */
const GoogleChatPlatformInstallAvailabilityDto = z.object({ available: z.boolean() })

/** A per-agent Chat app's replacement key (write-only). */
const ReplaceGoogleChatKeyBody = z.object({ serviceAccountKey: z.string().trim().min(1).max(20_000) })

/** The 409 copy when a pasted key would replace the deployment-owned app's, which the Setup Server holds. */
export const GOOGLE_CHAT_DEPLOYMENT_KEY_MESSAGE =
  'The deployment’s Google Chat app takes its key from the Setup Server; update it there, then install the app again.'

/** Why the deployment app cannot land on an agent: its status and the operator-facing sentence. */
export interface GoogleChatInstallTargetRefusal {
  status: 403 | 404 | 409
  message: string
}

/** The agent the deployment app lands on, the preset unless named, once the caller may edit it and its daemon runs Google Chat. */
export async function googleChatInstallTarget(
  deps: HttpDeps,
  req: FastifyRequest,
  agentId?: string
): Promise<{ agent: AgentRecord } | GoogleChatInstallTargetRefusal> {
  const orgId = orgOf(req)
  const targetId = agentId ?? (await deps.repos.presetAgent.get(orgId, 'general'))?.agentId
  if (!targetId) {
    return {
      status: 409,
      message: 'no target agent: pass agentId (the agentconnect preset is absent in this organization)'
    }
  }
  const agent = await deps.repos.agent.get(orgId, AgentId(targetId))
  if (!agent || !canView(agent, ctxOf(req))) return { status: 404, message: 'agent not found' }
  if (!canEdit(agent, ctxOf(req))) return { status: 403, message: 'cannot edit this agent' }
  // An unplaced agent is allowed, as for the Slack app; a placed one must be served by a daemon that runs Google Chat.
  const servingDaemonId = await deps.placementResolver.servingDaemon(agent)
  if (servingDaemonId) {
    const availability = await integrationPlatformAvailability(deps, {
      daemonId: servingDaemonId,
      orgId,
      viewer: ctxOf(req),
      platform: GOOGLE_CHAT_PLATFORM
    })
    if (availability === 'not_found') return { status: 404, message: 'daemon not found' }
    if (availability === 'unsupported') {
      return { status: 409, message: `daemon does not support ${GOOGLE_CHAT_PLATFORM} integrations` }
    }
  }
  return { agent }
}

/** Re-stamp the current deployment key on every claimed customer row of the app and re-sync each, the way the anchor is (§10.3). */
export async function restampGoogleChatCustomerRows(
  deps: HttpDeps,
  log: FastifyBaseLogger,
  projectNumber: string,
  secrets: BotSecretMaterial
): Promise<number> {
  const rows = (await deps.repos.bot.listForPlatform(GOOGLE_CHAT_PLATFORM)).filter(
    (bot) => bot.externalAppId === projectNumber && googleChatRowKind(bot) === 'customer'
  )
  for (const row of rows) {
    await deps.repos.botCredential.install(row.orgId, row.id, secrets, new Date())
    await deps.httpBot.syncBot(row.id)
  }
  if (rows.length > 0)
    log.info({ rows: rows.length }, 'google chat: re-stamped the deployment key on the customer rows')
  return rows.length
}

/** The HTTP reason phrase for a refusal status. */
export function googleChatErrorLabel(status: number): string {
  const labels: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    503: 'Service Unavailable'
  }
  return labels[status] ?? 'Error'
}

export function googleChatPlatformInstallRoutes(deps: HttpDeps, googleChat: GoogleChatRouteSeams) {
  return async function googleChatPlatformInstallRoutesPlugin(app: FastifyInstance): Promise<void> {
    const platform = googleChat.app
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/integrations/googlechat/platform-install',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Deployment Google Chat app availability',
          description:
            'Whether the Google Chat app configured in the Setup Server can be installed here: the app is configured and a relay can receive its HTTPS events. The console offers the deployment app only when this is true. Never returns the app’s key or project.',
          operationId: 'getGoogleChatPlatformInstall',
          response: { 200: GoogleChatPlatformInstallAvailabilityDto, 401: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        return { available: !!platform && relayIngress(deps).ok }
      }
    )

    // No deployment-owned app ⇒ the install route 404s and only per-agent apps remain.
    if (!platform) return

    r.post(
      '/integrations/googlechat/platform-install',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Install the deployment Google Chat app',
          description:
            'Connect the Google Chat app configured in the Setup Server to an agent, the organization’s preset agent unless `agentId` names another. Validates the stored service-account key, resolves the project number from the key’s own project through Cloud Resource Manager (a configured number must match it), makes one Chat API read, and creates the bot and its integration keyed by that resolved number (201); no key is pasted and none is returned. Running it again for the agent that already holds the app re-stamps that bot with the current deployment key (200), which is how a rotated key reaches it; an app held by another agent or organization answers 409. Requires the relay pool, because Google Chat delivers events only over HTTPS.',
          operationId: 'installGoogleChatPlatformApp',
          body: GoogleChatPlatformInstallBody,
          response: {
            200: IntegrationDto,
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

        const target = await googleChatInstallTarget(deps, req, req.body.agentId)
        if (!('agent' in target)) {
          return reply
            .code(target.status)
            .send({ error: googleChatErrorLabel(target.status), statusCode: target.status, message: target.message })
        }
        const { agent } = target

        // Validation takes the project from the key's authenticated account and its number from Google; those are the identity.
        const resolved = await resolveGoogleChatApp(platform, googleChat.fetch)
        if (!resolved.ok) {
          return reply.code(resolved.status).send({
            error: resolved.status === 400 ? 'Bad Request' : 'Service Unavailable',
            statusCode: resolved.status,
            ...(resolved.code ? { code: resolved.code } : {}),
            message: resolved.message
          })
        }
        const { projectId, projectNumber } = resolved

        // One bot per Chat app, across organizations; only the agent already holding it may run the install again.
        const existing = await deps.repos.bot.getByExternalIdentity(
          GOOGLE_CHAT_PLATFORM,
          projectNumber,
          TENANTLESS_SENTINEL
        )
        const held =
          existing?.orgId === orgId
            ? (await deps.repos.integration.listForBot(existing.id)).find((install) => install.agentId === agent.id)
            : undefined
        if (existing && !held) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: GOOGLE_CHAT_APP_TAKEN_MESSAGE })
        }
        // The project number is the bot's identity and the project ID its alias, so a different ID is a new installation.
        if (existing && existing.platformConfig?.projectId !== projectId) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            code: 'GOOGLE_CHAT_PROJECT_CHANGED',
            message: GOOGLE_CHAT_PROJECT_CHANGED_MESSAGE
          })
        }
        // With the switch on this row is the anchor, which serves no tenant; off, the probed customer is its own fence (§10.3).
        const own = !platform.multiTenant && resolved.customerId ? { customerId: resolved.customerId } : {}
        const install = buildGoogleChatInstall(resolved, own, 'single')

        if (existing && held) {
          // Re-stamp the current deployment key as a fresh credential generation, then re-push the spec.
          await deps.repos.botCredential.install(orgId, existing.id, install.secrets, new Date())
          if (own.customerId) {
            const customerId = own.customerId
            await deps.repos.bot.mergeBotIdentity(orgId, existing.id, (current) =>
              googleChatTenantOf(current.platformConfig).customerId ? {} : { platformConfig: { customerId } }
            )
          }
          await deps.httpBot.syncBot(existing.id)
          // A rotated deployment key reaches every claimed customer row the same way (§10.3).
          await restampGoogleChatCustomerRows(deps, req.log, projectNumber, install.secrets)
          return reply
            .code(200)
            .send(toIntegrationDto(held, await deps.repos.integrationChannel.listForIntegration(held.id)))
        }

        try {
          const { integration } = await installNewBot(deps, req.log, {
            ...install,
            orgId,
            agent,
            platform: GOOGLE_CHAT_PLATFORM,
            name: `Google Chat · ${projectId}`,
            transport: 'http',
            prebuilt: true,
            createdByUserId: req.principal.userId
          })
          return reply.code(201).send(toIntegrationDto(integration))
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

/** `PUT /bots/:id/googlechat/key`: rotate a per-agent Chat app's service-account key under the create path's validation. */
export function googleChatKeyRoutes(deps: HttpDeps, googleChat: GoogleChatRouteSeams) {
  return async function googleChatKeyRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.put(
      '/bots/:id/googlechat/key',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Replace a Google Chat app key',
          description:
            'Validate a new service-account key for this bot’s Google Chat app exactly as a new install does (the key’s own project, its number from Cloud Resource Manager, one Chat API read), require the same project and number, then store it in place of the current key and push it to every serving daemon. The key is write-only. The deployment-owned app takes its key from the Setup Server instead (409).',
          operationId: 'replaceGoogleChatKey',
          params: IdParam,
          body: ReplaceGoogleChatKeyBody,
          response: { 200: BotDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        const projectId = bot?.platformConfig?.projectId
        if (!bot || bot.platform !== GOOGLE_CHAT_PLATFORM || !bot.externalAppId || typeof projectId !== 'string') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'Google Chat bot not found' })
        }
        if (bot.prebuilt) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: GOOGLE_CHAT_DEPLOYMENT_KEY_MESSAGE })
        }
        // The stored identity is the entered one, so a key from another project or number is refused by validation itself.
        const resolved = await resolveGoogleChatApp(
          { projectId, projectNumber: bot.externalAppId, serviceAccountKey: req.body.serviceAccountKey },
          googleChat.fetch
        )
        if (!resolved.ok) {
          return reply.code(resolved.status).send({
            error: resolved.status === 400 ? 'Bad Request' : 'Service Unavailable',
            statusCode: resolved.status,
            ...(resolved.code ? { code: resolved.code } : {}),
            message: resolved.message
          })
        }
        const { secrets } = buildGoogleChatInstall(resolved)
        await deps.repos.botCredential.install(bot.orgId, bot.id, secrets, new Date(deps.clock.now()))
        await deps.httpBot.syncBot(bot.id)
        return toBotDto((await deps.repos.bot.get(bot.orgId, bot.id)) ?? bot)
      }
    )
  }
}
