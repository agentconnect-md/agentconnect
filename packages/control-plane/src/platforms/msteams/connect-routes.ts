// Connecting a Microsoft 365 tenant to the deployment's Teams app from the Console (teams-integration.md §8.3).
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { ErrorDto } from '../../http/dto/index.js'
import { ctxOf, denyViewerWrite, orgOf } from '../../http/rbac.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { integrationPlatformAvailability } from '../../http/daemon-platform-capability.js'
import { installNewBot } from '../../http/install-bot.js'
import { relayHttpBase, relayIngress } from '../../http/relay-ingress.js'
import { agentIconBackgroundColor } from '../../agents/agent-icon.js'
import { AgentId, IntegrationId } from '../../domain/ids.js'
import { BotExternalIdentityTaken } from '../../persistence/errors.js'
import type { AgentRecord } from '../../persistence/ports.js'
import {
  MSTEAMS_RSC_PERMISSIONS,
  msTeamsAppIcons,
  msTeamsAppPackage,
  msTeamsManifest,
  msTeamsPackageId
} from './app-package.js'
import {
  MsTeamsConnectError,
  installMsTeamsApp,
  listMsTeamsTeams,
  mintMsTeamsConnectState,
  msTeamsAuthorizeUrl,
  openMsTeamsTicket,
  publishMsTeamsPackage,
  redeemMsTeamsCode,
  sealMsTeamsTicket,
  verifyMsTeamsConnectState,
  type MsTeamsConnectKeys
} from './connect.js'
import type { MsTeamsPlatformApp } from './deployment-app.js'
import { msTeamsSecrets } from './provider.js'

export interface MsTeamsConnectSeams {
  /** The deployment-owned app; absent ⇒ every route answers that there is none. */
  app?: MsTeamsPlatformApp
  keys: MsTeamsConnectKeys
  /** The Console origin whose `/msteams/connect` page Microsoft redirects to. */
  webAppUrl?: string
  fetch?: typeof fetch
}

/** The Console page the deployment app's registration lists as a Web redirect URI. */
export function msTeamsConnectRedirectUri(webAppUrl: string): string {
  return `${webAppUrl.replace(/\/+$/, '')}/msteams/connect`
}

const TAKEN_MESSAGE =
  'This Microsoft 365 organization is already connected to another AgentConnect organization. Ask its owner to remove the Teams integration first.'
const IN_USE_MESSAGE =
  'This Microsoft 365 organization already connects another agent here. Remove that Teams integration first, or register your own bot for this agent.'

const MsTeamsDeploymentAppDto = z.object({
  appId: z
    .string()
    .nullable()
    .describe('The deployment Teams app’s Entra application ID; null when the deployment has no app to connect to.')
})
const ConnectBody = z.object({ agentId: z.uuid().describe('The agent the Teams app will serve.') })
const ConnectDto = z.object({ authorizeUrl: z.url().describe('Microsoft’s sign-in page to send the browser to.') })
const CallbackBody = z.object({
  code: z.string().min(1).max(4096).describe('The authorization code Microsoft returned to the connect page.'),
  state: z.string().min(1).max(2048).describe('The state Microsoft returned with it.')
})
const CallbackDto = z.object({
  integrationId: z.string(),
  agentId: z.string(),
  teams: z.array(z.object({ id: z.string(), name: z.string() })).describe('The signed-in administrator’s teams.'),
  ticket: z.string().describe('An opaque, short-lived handle for the install step.')
})
const InstallBody = z.object({
  ticket: z.string().min(1).max(16_384),
  teamIds: z.array(z.string().min(1).max(256)).min(1).max(50)
})
const InstallDto = z.object({ installed: z.number().int().describe('How many teams now have the app.') })

function refuse(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  const label = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 502: 'Bad Gateway' }
  return reply
    .code(status)
    .send({ error: label[status as keyof typeof label] ?? 'Error', statusCode: status, code, message })
}

const STATUS_OF: Record<MsTeamsConnectError['code'], number> = {
  MSTEAMS_CONNECT_DENIED: 400,
  MSTEAMS_CONNECT_PERSONAL_ACCOUNT: 400,
  MSTEAMS_CONNECT_NOT_ADMIN: 403,
  MSTEAMS_CONNECT_UNAVAILABLE: 502
}

// The agent the tenant will serve, once the caller may edit it and its daemon runs Teams.
async function connectTarget(deps: HttpDeps, req: FastifyRequest, agentId: string): Promise<AgentRecord | string> {
  const agent = await deps.repos.agent.get(orgOf(req), AgentId(agentId))
  if (!agent || !canView(agent, ctxOf(req))) return 'agent not found'
  if (!canEdit(agent, ctxOf(req))) return 'cannot edit this agent'
  const servingDaemonId = await deps.placementResolver.servingDaemon(agent)
  if (servingDaemonId) {
    const availability = await integrationPlatformAvailability(deps, {
      daemonId: servingDaemonId,
      orgId: orgOf(req),
      viewer: ctxOf(req),
      platform: MSTEAMS_PLATFORM
    })
    if (availability === 'not_found') return 'daemon not found'
    if (availability === 'unsupported') return `daemon does not support ${MSTEAMS_PLATFORM} integrations`
  }
  return agent
}

export function msTeamsConnectRoutes(deps: HttpDeps, seams: MsTeamsConnectSeams) {
  const fetchImpl: typeof fetch = (input, init) => (seams.fetch ?? fetch)(input, init)
  const usable = () => (seams.app && seams.webAppUrl ? { app: seams.app, webAppUrl: seams.webAppUrl } : undefined)
  return async function msTeamsConnectRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/integrations/msteams/app',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Read the deployment Teams app',
          description:
            'The public identity of the Teams app this deployment operates, which an organization connects its Microsoft 365 tenant to instead of registering its own bot. Never returns its secret.',
          operationId: 'getMsTeamsDeploymentApp',
          response: { 200: MsTeamsDeploymentAppDto }
        }
      },
      async () => ({ appId: usable()?.app.appId ?? null })
    )

    r.post(
      '/integrations/msteams/connect',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Start connecting a Microsoft 365 tenant',
          description:
            'Answer Microsoft’s sign-in URL for the deployment Teams app. An administrator of the tenant signs in and consents to publishing the app to the organization catalog, listing their teams, and installing the app with its resource-specific permissions; Microsoft then returns to the Console’s connect page. The state is signed for this organization, agent and caller and expires in ten minutes.',
          operationId: 'startMsTeamsConnect',
          body: ConnectBody,
          response: { 200: ConnectDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const live = usable()
        if (!live || !req.principal)
          return refuse(reply, 404, 'MSTEAMS_CONNECT_UNAVAILABLE', 'This deployment has no Teams app.')
        const target = await connectTarget(deps, req, req.body.agentId)
        if (typeof target === 'string') return refuse(reply, 409, 'MSTEAMS_CONNECT_NO_AGENT', target)
        const state = mintMsTeamsConnectState(
          seams.keys,
          { orgId: orgOf(req), agentId: target.id, userId: req.principal.userId },
          deps.clock
        )
        return {
          authorizeUrl: msTeamsAuthorizeUrl(seams.keys, {
            clientId: live.app.appId,
            redirectUri: msTeamsConnectRedirectUri(live.webAppUrl),
            state
          })
        }
      }
    )

    r.post(
      '/integrations/msteams/connect/callback',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Finish connecting a Microsoft 365 tenant',
          description:
            'Redeem the code Microsoft returned, take the tenant from the ID token, and connect it: a tenant another organization holds answers 409 MSTEAMS_TENANT_TAKEN, and one this organization connects to another agent answers 409 MSTEAMS_TENANT_IN_USE. The tenant’s row is installed on the agent, the app is published to the tenant’s organization catalog, and the administrator’s teams are answered with a short-lived ticket for the install step.',
          operationId: 'finishMsTeamsConnect',
          body: CallbackBody,
          response: { 200: CallbackDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const live = usable()
        if (!live || !req.principal)
          return refuse(reply, 404, 'MSTEAMS_CONNECT_UNAVAILABLE', 'This deployment has no Teams app.')
        const orgId = orgOf(req)
        const state = verifyMsTeamsConnectState(seams.keys, req.body.state, deps.clock)
        if (!state || state.orgId !== orgId || state.userId !== req.principal.userId) {
          return refuse(
            reply,
            400,
            'MSTEAMS_CONNECT_STATE_INVALID',
            'This sign-in has expired. Start connecting again.'
          )
        }
        const target = await connectTarget(deps, req, state.agentId)
        if (typeof target === 'string') return refuse(reply, 409, 'MSTEAMS_CONNECT_NO_AGENT', target)
        const relayBase = relayHttpBase(deps.config.PUBLIC_RELAY_URL)
        const ingress = relayIngress(deps)
        if (!relayBase || !ingress.ok) {
          return refuse(reply, 409, 'MSTEAMS_RELAY_ORIGIN_MISSING', 'This deployment has no public callback endpoint.')
        }
        try {
          const { accessToken, tenantId } = await redeemMsTeamsCode(
            seams.keys,
            {
              clientId: live.app.appId,
              clientSecret: live.app.clientSecret,
              redirectUri: msTeamsConnectRedirectUri(live.webAppUrl),
              code: req.body.code,
              state: req.body.state
            },
            fetchImpl
          )

          // One tenant maps to one organization and, within it, to one agent (§8.2).
          const held = await deps.repos.bot.getByExternalIdentity(MSTEAMS_PLATFORM, live.app.appId, tenantId)
          if (held && held.orgId !== orgId) return refuse(reply, 409, 'MSTEAMS_TENANT_TAKEN', TAKEN_MESSAGE)
          if (held && held.agentIds.length > 0 && !held.agentIds.includes(target.id)) {
            return refuse(reply, 409, 'MSTEAMS_TENANT_IN_USE', IN_USE_MESSAGE)
          }

          // Publishing without review is an administrator's act, so it proves the authority the claim needs before anything is written.
          const manifest = msTeamsManifest({
            appId: live.app.appId,
            relayHost: new URL(relayBase).host,
            agentName: target.displayName ?? target.name,
            accentColor: agentIconBackgroundColor(target.icon),
            nowMs: deps.clock.now()
          })
          const zip = msTeamsAppPackage(manifest, await msTeamsAppIcons(target, deps.iconStore))
          const catalogAppId = await publishMsTeamsPackage(
            fetchImpl,
            accessToken,
            msTeamsPackageId(live.app.appId),
            zip
          )

          let integrationId: string
          if (!held) {
            try {
              const installed = await installNewBot(deps, req.log, {
                bot: {
                  externalAppId: live.app.appId,
                  platformConfig: { tenantId, tokenTenantId: live.app.tenantId }
                },
                secrets: msTeamsSecrets(live.app.clientSecret),
                externalIdentity: {
                  externalAppId: live.app.appId,
                  externalTenantId: tenantId,
                  conflictMessage: TAKEN_MESSAGE
                },
                orgId,
                agent: target,
                platform: MSTEAMS_PLATFORM,
                name: `Microsoft Teams · ${tenantId}`,
                transport: 'http',
                prebuilt: true,
                createdByUserId: req.principal.userId
              })
              integrationId = installed.integration.id
            } catch (err) {
              if (err instanceof BotExternalIdentityTaken)
                return refuse(reply, 409, 'MSTEAMS_TENANT_TAKEN', TAKEN_MESSAGE)
              throw err
            }
          } else {
            const admission = await deps.repos.integration.addBotMembership({
              id: IntegrationId(randomUUID()),
              orgId,
              agentId: target.id,
              botId: held.id,
              platform: MSTEAMS_PLATFORM,
              name: held.name,
              createdByUserId: req.principal.userId
            })
            if (admission.outcome === 'revoked' || admission.outcome === 'not_shareable') {
              return refuse(reply, 409, 'MSTEAMS_TENANT_IN_USE', IN_USE_MESSAGE)
            }
            if (admission.outcome === 'added') {
              await deps.repos.botCredential.install(
                orgId,
                held.id,
                msTeamsSecrets(live.app.clientSecret),
                new Date(deps.clock.now())
              )
              await deps.httpBot.syncBot(held.id)
            }
            integrationId = admission.integration.id
          }

          const teams = await listMsTeamsTeams(fetchImpl, accessToken)
          return {
            integrationId,
            agentId: target.id,
            teams,
            ticket: sealMsTeamsTicket(seams.keys, { accessToken, orgId, integrationId, catalogAppId }, deps.clock)
          }
        } catch (err) {
          if (err instanceof MsTeamsConnectError) return refuse(reply, STATUS_OF[err.code], err.code, err.message)
          throw err
        }
      }
    )

    r.post(
      '/integrations/msteams/connect/install',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Install the Teams app into teams',
          description:
            'Install the connected tenant’s catalog app into each chosen team with the package’s resource-specific permissions, using the ticket the connect step answered. A team that already has the app counts as installed.',
          operationId: 'installMsTeamsApp',
          body: InstallBody,
          response: { 200: InstallDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!usable()) return refuse(reply, 404, 'MSTEAMS_CONNECT_UNAVAILABLE', 'This deployment has no Teams app.')
        const ticket = openMsTeamsTicket(seams.keys, req.body.ticket, deps.clock)
        if (!ticket || ticket.orgId !== orgOf(req)) {
          return refuse(
            reply,
            400,
            'MSTEAMS_CONNECT_STATE_INVALID',
            'This sign-in has expired. Start connecting again.'
          )
        }
        try {
          for (const teamId of req.body.teamIds) {
            await installMsTeamsApp(fetchImpl, ticket.accessToken, {
              teamId,
              catalogAppId: ticket.catalogAppId,
              permissions: MSTEAMS_RSC_PERMISSIONS
            })
          }
        } catch (err) {
          if (err instanceof MsTeamsConnectError) return refuse(reply, STATUS_OF[err.code], err.code, err.message)
          throw err
        }
        return { installed: req.body.teamIds.length }
      }
    )
  }
}
