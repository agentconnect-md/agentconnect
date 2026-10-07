// Public installation comes before authenticated, workspace-wide organization binding.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AgentId, BotId } from '../../domain/ids.js'
import { resolveWebAppUrl } from '../../config/env.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { BotWorkspaceClaimed, BotExternalIdentityTaken } from '../../persistence/errors.js'
import type { SlackWorkspaceInstallRecord } from '../../persistence/ports.js'
import type { HttpDeps } from '../deps.js'
import type { SlackRouteSeams } from '../platform-route-seams.js'
import type { SlackOAuthResult } from '../slack-config-api.js'
import { SLACK_BOT_SCOPES, slackPlatformOAuthRedirectUri } from '../slack-manifest.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'
import { relayIngress } from '../relay-ingress.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'

export const SLACK_INSTALL_COOKIE = 'ac_slack_install'

export function standaloneSlackStateMatches(req: FastifyRequest, state: string): boolean {
  return req.headers.cookie?.split(';').some((cookie) => cookie.trim() === `${SLACK_INSTALL_COOKIE}=${state}`) === true
}

export async function finishSlackWorkspaceInstall(
  deps: HttpDeps,
  slack: SlackRouteSeams,
  result: SlackOAuthResult,
  grantedScopes: string[]
): Promise<string> {
  const platform = slack.platformApp!
  const existing = await deps.repos.bot.getByExternalIdentity('slack', platform.appId, result.teamId!)
  if (existing) {
    await deps.repos.botCredential.install(
      existing.orgId,
      existing.id,
      {
        botToken: result.botToken,
        appToken: null,
        signingSecret: platform.signingSecret
      },
      new Date(),
      { restoreRevokedMemberships: true }
    )
    await deps.repos.bot.setWorkspaceMetadata(existing.orgId, existing.id, result.teamId!, result.teamName)
    if (grantedScopes.length) await deps.repos.bot.setGrantedScopes(existing.orgId, existing.id, grantedScopes)
    await deps.httpBot.syncBot(existing.id)
    return `https://slack.com/app_redirect?app=${encodeURIComponent(platform.appId)}&team=${encodeURIComponent(result.teamId!)}`
  }
  if (!result.botUserId || !result.installerUserId) throw new Error('Slack did not identify the installing user')
  const row = await deps.repos.slackWorkspaceInstall.put({
    appId: platform.appId,
    teamId: result.teamId!,
    teamName: result.teamName,
    botUserId: result.botUserId,
    installerUserId: result.installerUserId,
    botToken: result.botToken,
    grantedScopes
  })
  await deps.httpBot.syncBot(row.id)
  return `${resolveWebAppUrl(deps.config)!.replace(/\/+$/, '')}/slack/connect?installation=${row.id}`
}

async function ownWorkspace(
  deps: HttpDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  id: string
): Promise<SlackWorkspaceInstallRecord | undefined> {
  const row = await deps.repos.slackWorkspaceInstall.get(id)
  if (!row) {
    reply.code(404).send({
      error: 'Not Found',
      statusCode: 404,
      message:
        'This installation is no longer waiting for a connection. Open the app in Slack to see its current status.'
    })
    return
  }
  const subject = req.oidcSubject ?? (req.principal ? await deps.repos.user.getOidcSubject(req.principal.userId) : null)
  const identity = subject ? await deps.logtoIdentity?.slackIdentityFor(subject) : null
  if (!identity || identity.teamId !== row.teamId || identity.userId !== row.installerUserId) {
    reply.code(403).send({
      error: 'Forbidden',
      statusCode: 403,
      message:
        'Use the Slack account that installed this app. You can link that Slack account from your AgentConnect profile.'
    })
    return
  }
  return row
}

export function slackWorkspacePublicRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async (app: FastifyInstance): Promise<void> => {
    const platform = slack.platformApp
    const webUrl = resolveWebAppUrl(deps.config)
    const cpUrl = deps.config.PUBLIC_CP_URL
    if (!platform || !slack.configApi || !cpUrl || !webUrl?.startsWith('https://')) return
    const r = app.withTypeProvider<ZodTypeProvider>()
    r.get(
      '/integrations/slack/install',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Install Slack before connecting an organization',
          description:
            'Start workspace OAuth without an AgentConnect account, organization, or agent. After authorization the installer can connect the workspace from App Home.',
          operationId: 'installSlackWorkspace',
          response: { 409: ErrorDto }
        }
      },
      async (_req, reply) => {
        const ingress = relayIngress(deps)
        if (!ingress.ok) return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: ingress.message })
        const row = await deps.repos.slackPlatformInstall.create({ id: randomUUID() })
        const url = new URL('https://slack.com/oauth/v2/authorize')
        url.searchParams.set('client_id', platform.clientId)
        url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','))
        url.searchParams.set('state', row.id)
        url.searchParams.set('redirect_uri', slackPlatformOAuthRedirectUri(cpUrl))
        return reply
          .header('Cache-Control', 'no-store')
          .header(
            'Set-Cookie',
            `${SLACK_INSTALL_COOKIE}=${row.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`
          )
          .redirect(url.toString())
      }
    )
    r.get(
      '/integrations/slack/workspace-install/:id',
      {
        preValidation: app.humanAuth,
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Read a Slack workspace awaiting connection',
          description:
            'Return workspace setup metadata only to the Slack user who authorized this installation. Credentials are never returned.',
          operationId: 'getSlackWorkspaceInstall',
          params: z.object({ id: z.string().uuid() }),
          response: {
            200: z.object({ workspaceName: z.string(), slackUrl: z.string().url() }),
            403: ErrorDto,
            404: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const row = await ownWorkspace(deps, req, reply, req.params.id)
        if (row)
          return {
            workspaceName: row.teamName ?? 'Slack workspace',
            slackUrl: `https://slack.com/app_redirect?app=${encodeURIComponent(row.appId)}&team=${encodeURIComponent(row.teamId)}`
          }
      }
    )
  }
}

export function slackWorkspaceClaimRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async (app: FastifyInstance): Promise<void> => {
    const platform = slack.platformApp
    if (!platform) return
    app.withTypeProvider<ZodTypeProvider>().post(
      '/integrations/slack/workspace-install/:id/connect',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Connect an installed Slack workspace',
          description:
            'Bind the installer’s Slack workspace to one editable agent in this organization, using its existing authorization. This does not enable multi-agent sharing.',
          operationId: 'connectSlackWorkspace',
          params: z.object({ id: z.string().uuid() }),
          body: z.object({ agentId: z.string().uuid() }),
          response: { 200: z.object({ botId: z.string().uuid() }), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const row = await ownWorkspace(deps, req, reply, req.params.id)
        if (!row) return
        if (row.appId !== platform.appId)
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'Install the current Slack app and try again.' })
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req)))
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req)))
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        try {
          const botId = await deps.repos.slackWorkspaceInstall.claim({
            id: row.id,
            revision: row.credentialRevision,
            orgId: orgOf(req),
            agentId: agent.id,
            userId: req.principal!.userId,
            signingSecret: platform.signingSecret
          })
          if (botId) {
            await deps.httpBot.syncBot(BotId(botId))
            return { botId }
          }
        } catch (error) {
          if (!(error instanceof BotWorkspaceClaimed || error instanceof BotExternalIdentityTaken)) throw error
        }
        return reply.code(409).send({
          error: 'Conflict',
          statusCode: 409,
          message: 'This installation changed or was already connected. Open the app in Slack and try again.'
        })
      }
    )
  }
}
