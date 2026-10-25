/**
 * One-click Lark/Feishu self-built app registration.
 *
 * The provider gives the Console a deeplink. Its device cursor and provisional
 * credentials are encrypted in Postgres so any Control Plane replica can
 * continue the poll and install; neither endpoint returns App Secret.
 */
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { resolveAgentIconUrl } from '../../agents/agent-icon.js'
import { denyViewerWrite, ctxOf, orgOf } from '../rbac.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { integrationPlatformAvailability, noInstallDaemonMessage } from '../daemon-platform-capability.js'
import {
  FeishuRegistrationConflictError,
  FeishuRegistrationRetryError,
  FeishuRegistrationSetupError
} from '../feishu-registration.js'
import { installNewFeishuBot } from '../install-feishu.js'
import { feishuEventsRequestUrl, type ConfigureFeishuHttpAppInput } from '../feishu-app-config.js'
import { relayIngress } from '../relay-ingress.js'
import type { FeishuRouteSeams } from '../platform-route-seams.js'
import {
  ErrorDto,
  FeishuAppRegistrationStartBody,
  FeishuAppRegistrationStartDto,
  FeishuAppRegistrationStatusDto,
  IdParam
} from '../dto/index.js'

export function feishuRegistrationRoutes(deps: HttpDeps, feishu: FeishuRouteSeams) {
  return async function feishuRegistrationRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const orgIdOf = (req: { orgCtx?: { orgId: OrgId } }) => req.orgCtx!.orgId

    r.post(
      '/integrations/feishu/app',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Start Lark / Feishu app registration',
          description:
            'Create an AgentConnect-ready Lark/Feishu self-built app through the official device authorization flow. Returns only the authorization deeplink; credentials are installed server-side after approval.',
          operationId: 'startFeishuAppRegistration',
          body: FeishuAppRegistrationStartBody,
          response: {
            201: FeishuAppRegistrationStartDto,
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
        const orgId = orgIdOf(req)
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // A pool agent names no machine; the capability probe asks its serving member, else a live one.
        const installDaemonId = await deps.placementResolver.installDaemon(agent)
        if (!installDaemonId) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: noInstallDaemonMessage(agent) })
        }
        const availability = await integrationPlatformAvailability(deps, {
          daemonId: installDaemonId,
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
        const transport = req.body.transport
        const ingress = transport === 'http' ? relayIngress(deps) : null
        if (ingress && !ingress.ok) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: ingress.message })
        }
        const tenant = await feishu.tenantGuard.loginAppStatus(req.body.region).catch(() => 'unavailable' as const)
        if (tenant === 'not_configured') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            code: 'FEISHU_LOGIN_APP_NOT_CONFIGURED',
            message: 'Configure the matching Lark/Feishu Login App on this deployment before creating Bot Apps.'
          })
        }
        if (tenant === 'unavailable') {
          return reply.code(503).send({
            error: 'Service Unavailable',
            statusCode: 503,
            code: 'FEISHU_LOGIN_APP_UNAVAILABLE',
            message:
              'Could not verify this deployment’s Lark/Feishu Login App organization. Ask the deployment administrator to check its credentials, app status and published Obtain tenant information permission.'
          })
        }
        try {
          const started = await feishu.registrations.start({
            orgId,
            agentId: targetAgentId,
            fallbackRegion: req.body.region,
            transport,
            appName,
            ...(avatarUrl ? { avatarUrl } : {}),
            ...(providedName ? { requestedName: providedName } : {}),
            createdByUserId
          })
          return reply.code(201).send({
            id: started.id,
            authorizationUrl: started.authorizationUrl,
            expiresAt: started.expiresAt.toISOString(),
            transport: started.transport
          })
        } catch (error) {
          if (error instanceof FeishuRegistrationConflictError) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: error.message
            })
          }
          req.log.warn(
            { provider: 'feishu', region: req.body.region, stage: 'app_registration' },
            'feishu setup unavailable'
          )
          return reply.code(503).send({
            error: 'Service Unavailable',
            statusCode: 503,
            code: 'FEISHU_SETUP_UNAVAILABLE',
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
          summary: 'Poll Lark / Feishu app registration',
          description:
            'Read one Lark/Feishu device-registration session until it completes or fails. Credentials are never returned.',
          operationId: 'getFeishuAppRegistration',
          params: IdParam,
          response: { 200: FeishuAppRegistrationStatusDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const orgId = orgIdOf(req)
        const session = await feishu.registrations.get(req.params.id, orgId, async (registration) => {
          const tenant = await feishu.tenantGuard.checkApp(
            registration.appId,
            registration.appSecret,
            registration.region
          )
          if (tenant === 'invalid_credentials') throw new FeishuRegistrationSetupError('invalid_credentials')
          if (tenant === 'org_mismatch') throw new FeishuRegistrationSetupError('org_mismatch')
          if (tenant === 'unavailable' || tenant === 'login_unavailable') {
            throw new Error('Lark/Feishu App organization is temporarily unavailable')
          }
          if (tenant !== 'ok' && tenant !== 'not_required') throw new FeishuRegistrationSetupError('setup_failed')

          const check = feishu.verifyBot
            ? await feishu.verifyBot(registration.appId, registration.appSecret, registration.region)
            : null
          if (check?.status === 'invalid') {
            throw new FeishuRegistrationSetupError('invalid_credentials')
          }
          if (registration.transport === 'http') {
            if (check?.status !== 'ok') {
              throw new Error('Lark/Feishu bot identity is temporarily unavailable')
            }
            if (!check.openId) throw new FeishuRegistrationSetupError('setup_failed')
          }

          // Authorization can outlive the original placement. Take the mutation
          // side of the move fence, then resolve both placement and capability
          // under it so a concurrent move cannot omit this new integration.
          const release = deps.agentMutations.tryBeginMutation(registration.agentId)
          if (!release) throw new FeishuRegistrationRetryError()
          let httpAppConfig: ConfigureFeishuHttpAppInput | undefined
          try {
            const current = await deps.repos.agent.get(orgOf(req), registration.agentId)
            if (!current || !canView(current, ctxOf(req)) || !canEdit(current, ctxOf(req))) {
              throw new FeishuRegistrationSetupError('agent_unavailable')
            }
            // Resolved under the lease exactly as the start leg resolved it: a pool agent names no machine.
            const finalizeDaemonId = await deps.placementResolver.installDaemon(current)
            if (!finalizeDaemonId) throw new FeishuRegistrationSetupError('agent_unavailable')
            const availability = await integrationPlatformAvailability(deps, {
              daemonId: finalizeDaemonId,
              orgId: registration.orgId,
              viewer: ctxOf(req),
              platform: 'feishu'
            })
            if (availability !== 'available') {
              throw new FeishuRegistrationSetupError('agent_unavailable')
            }
            const name = registration.requestedName || (check?.status === 'ok' ? check.name : null) || current.name
            let relayBase: string | null = null
            if (registration.transport === 'http') {
              const ingress = relayIngress(deps)
              if (!ingress.ok) throw new FeishuRegistrationRetryError()
              relayBase = ingress.base
            }
            const existingSecret =
              registration.transport === 'http'
                ? await deps.repos.botSecret.get(registration.orgId, registration.botId)
                : null
            const verificationToken =
              existingSecret?.verificationToken && existingSecret.verificationToken.length <= 32
                ? existingSecret.verificationToken
                : randomBytes(16).toString('hex')
            const encryptKey = existingSecret?.encryptKey || randomBytes(16).toString('hex')
            await installNewFeishuBot(deps, app.log, {
              orgId: registration.orgId,
              agent: current,
              botId: registration.botId,
              integrationId: registration.integrationId,
              name,
              appId: registration.appId,
              appSecret: registration.appSecret,
              region: registration.region,
              loginBound: tenant === 'ok',
              transport: registration.transport,
              ...(check?.status === 'ok' && check.openId ? { botUserId: check.openId } : {}),
              ...(registration.transport === 'http' ? { verificationToken, encryptKey } : {}),
              createdByUserId: registration.createdByUserId
            })
            if (registration.transport === 'http') {
              httpAppConfig = {
                appId: registration.appId,
                appSecret: registration.appSecret,
                region: registration.region,
                requestUrl: feishuEventsRequestUrl(relayBase!),
                verificationToken,
                encryptKey
              }
            }
          } finally {
            release()
          }
          // Provider configuration is independent of placement. Keep this network
          // round-trip outside the agent move fence; a failure leaves the durable
          // authorized registration retryable with the same callback credentials.
          if (httpAppConfig) await feishu.configureHttpApp(httpAppConfig)
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
