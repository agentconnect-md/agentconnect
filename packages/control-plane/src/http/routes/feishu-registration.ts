/**
 * One-click Feishu/Lark self-built app registration.
 *
 * The provider gives the Console a deeplink. Its device cursor and provisional
 * credentials are encrypted in Postgres so any Control Plane replica can
 * continue the poll and install; neither endpoint returns App Secret.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { resolveAgentIconUrl } from '../../agents/agent-icon.js'
import { denyViewerWrite, ctxOf } from '../rbac.js'
import { canEdit, canView } from '../visibility.js'
import { integrationPlatformAvailability } from '../daemon-platform-capability.js'
import {
  FeishuRegistrationConflictError,
  FeishuRegistrationRetryError,
  FeishuRegistrationSetupError
} from '../feishu-registration.js'
import { installNewFeishuBot } from '../install-feishu.js'
import {
  ErrorDto,
  FeishuAppRegistrationStartBody,
  FeishuAppRegistrationStartDto,
  FeishuAppRegistrationStatusDto,
  IdParam
} from '../dto/index.js'

export function feishuRegistrationRoutes(deps: HttpDeps) {
  return async function feishuRegistrationRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const orgIdOf = (req: { orgCtx?: { orgId: OrgId } }) => req.orgCtx!.orgId

    r.post(
      '/integrations/feishu/app',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Start Feishu app registration',
          description:
            'Create an AgentConnect-ready Feishu/Lark self-built app through the official device authorization flow. Returns only the authorization deeplink; credentials are installed server-side after approval.',
          operationId: 'startFeishuAppRegistration',
          body: FeishuAppRegistrationStartBody,
          response: {
            201: FeishuAppRegistrationStartDto,
            400: ErrorDto,
            401: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        const orgId = orgIdOf(req)
        const agent = await deps.repos.agent.get(AgentId(req.body.agentId))
        if (!agent || agent.orgId !== orgId || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        if (!agent.daemonId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent must be placed on a daemon first' })
        }
        const availability = await integrationPlatformAvailability(deps, {
          daemonId: agent.daemonId,
          orgId,
          viewer: ctxOf(req),
          platform: 'feishu'
        })
        if (availability === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (availability === 'unsupported') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'daemon does not support feishu integrations'
          })
        }

        const providedName = req.body.name?.trim()
        const appName = providedName || agent.name
        const avatarUrl = resolveAgentIconUrl(
          agent.id,
          agent.icon,
          {
            ...(deps.config.PUBLIC_CP_URL ? { cp: deps.config.PUBLIC_CP_URL } : {}),
            ...(deps.config.S3_PUBLIC_BASE_URL ? { store: deps.config.S3_PUBLIC_BASE_URL } : {})
          },
          agent.lastModifiedAt.getTime()
        )
        const createdByUserId = req.principal.userId
        const targetAgentId = agent.id
        try {
          const started = await deps.feishuAppRegistration.start({
            orgId,
            agentId: targetAgentId,
            fallbackRegion: req.body.region,
            appName,
            ...(avatarUrl ? { avatarUrl } : {}),
            ...(providedName ? { requestedName: providedName } : {}),
            createdByUserId
          })
          return reply.code(201).send({
            id: started.id,
            authorizationUrl: started.authorizationUrl,
            expiresAt: started.expiresAt.toISOString()
          })
        } catch (error) {
          if (error instanceof FeishuRegistrationConflictError) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: error.message
            })
          }
          return reply.code(502).send({
            error: 'Bad Gateway',
            statusCode: 502,
            message: 'Could not start Feishu app setup. Please try again.'
          })
        }
      }
    )

    r.get(
      '/integrations/feishu/app/:id',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Poll Feishu app registration',
          description:
            'Read one Feishu/Lark device-registration session until it completes or fails. Credentials are never returned.',
          operationId: 'getFeishuAppRegistration',
          params: IdParam,
          response: { 200: FeishuAppRegistrationStatusDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const orgId = orgIdOf(req)
        const session = await deps.feishuAppRegistration.get(req.params.id, orgId, async (registration) => {
          const check = deps.verifyFeishuBot
            ? await deps.verifyFeishuBot(registration.appId, registration.appSecret, registration.region)
            : null
          if (check?.status === 'invalid') {
            throw new FeishuRegistrationSetupError('invalid_credentials')
          }

          // Authorization can outlive the original placement. Take the mutation
          // side of the move fence, then resolve both placement and capability
          // under it so a concurrent move cannot omit this new integration.
          const release = deps.agentMutations.tryBeginMutation(registration.agentId)
          if (!release) throw new FeishuRegistrationRetryError()
          try {
            const current = await deps.repos.agent.get(registration.agentId)
            if (
              !current ||
              current.orgId !== registration.orgId ||
              !current.daemonId ||
              !canView(current, ctxOf(req)) ||
              !canEdit(current, ctxOf(req))
            ) {
              throw new FeishuRegistrationSetupError('agent_unavailable')
            }
            const availability = await integrationPlatformAvailability(deps, {
              daemonId: current.daemonId,
              orgId: registration.orgId,
              viewer: ctxOf(req),
              platform: 'feishu'
            })
            if (availability !== 'available') {
              throw new FeishuRegistrationSetupError('agent_unavailable')
            }
            const name = registration.requestedName || (check?.status === 'ok' ? check.name : null) || current.name
            await installNewFeishuBot(deps, app.log, {
              orgId: registration.orgId,
              agent: current,
              botId: registration.botId,
              integrationId: registration.integrationId,
              name,
              appId: registration.appId,
              appSecret: registration.appSecret,
              region: registration.region,
              createdByUserId: registration.createdByUserId
            })
          } finally {
            release()
          }
        })
        if (!session) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'registration not found' })
        }
        return {
          id: session.id,
          status: session.status,
          failureReason: session.failureReason,
          integrationId: session.integrationId,
          expiresAt: session.expiresAt.toISOString()
        }
      }
    )
  }
}
