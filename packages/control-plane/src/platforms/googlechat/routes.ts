// The deployment app's public identity, a per-agent Chat app's key rotation, and the agent a claimed customer lands on (google-chat-integration.md §3, §10.5).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import type { HttpDeps } from '../../http/deps.js'
import type { GoogleChatRouteSeams } from '../../http/platform-route-seams.js'
import { AgentId, BotId } from '../../domain/ids.js'
import { denyViewerWrite, ctxOf, orgOf } from '../../http/rbac.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { integrationPlatformAvailability } from '../../http/daemon-platform-capability.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { BotDto, ErrorDto, IdParam } from '../../http/dto/index.js'
import { toBotDto } from '../../http/routes/bots.js'
import { buildGoogleChatInstall, resolveGoogleChatApp } from './provider.js'

/** A per-agent Chat app's replacement key (write-only). */
const ReplaceGoogleChatKeyBody = z.object({ serviceAccountKey: z.string().trim().min(1).max(20_000) })

/** The deployment-owned app as the console may see it: public identity only, never the key. */
const GoogleChatDeploymentAppDto = z.object({
  projectNumber: z
    .string()
    .nullable()
    .describe(
      'The deployment app’s Google Cloud project number, which is also its Google Workspace Marketplace app ID; null when the deployment has no Google Chat app an organization can connect.'
    )
})

/** The 409 copy when a pasted key would replace the deployment-owned app's, which the Setup Server holds. */
export const GOOGLE_CHAT_DEPLOYMENT_KEY_MESSAGE =
  'The deployment’s Google Chat app takes its key from the Setup Server; update it there and restart AgentConnect.'

/** Why a claimed customer cannot land on an agent: its status and the operator-facing sentence. */
export interface GoogleChatInstallTargetRefusal {
  status: 403 | 404 | 409
  message: string
}

/** The agent a claimed customer lands on, the preset unless named, once the caller may edit it and its daemon runs Google Chat. */
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

/** `GET /integrations/googlechat/app`: the deployment app's project number, from which the console derives its Marketplace listing. */
export function googleChatAppRoutes(googleChat: Pick<GoogleChatRouteSeams, 'app'>) {
  return async function googleChatAppRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/integrations/googlechat/app',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Get the deployment Google Chat app',
          description:
            'The Google Chat app configured in the Setup Server, by its public identity: the Google Cloud project number, which is also its Google Workspace Marketplace app ID, or null when the deployment has none or its console cannot serve the claim page (it is not https). An organization installs that app from its Marketplace listing and then connects itself from Google Chat (`POST /integrations/googlechat/claim`). Never returns the app’s key.',
          operationId: 'getGoogleChatDeploymentApp',
          response: { 200: GoogleChatDeploymentAppDto, 401: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        return { projectNumber: googleChat.app?.projectNumber ?? null }
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
            error: googleChatErrorLabel(resolved.status),
            statusCode: resolved.status,
            ...(resolved.code ? { code: resolved.code } : {}),
            message: resolved.message
          })
        }
        const { secrets } = buildGoogleChatInstall(resolved)
        await deps.repos.botCredential.install(bot.orgId, bot.id, secrets, new Date(deps.clock.now()))
        await deps.httpBot.syncBot(bot.id)
        return toBotDto((await deps.repos.bot.get(bot.orgId, bot.id)) ?? bot, deps.platforms)
      }
    )
  }
}
