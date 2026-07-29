/**
 * `http/routes/slack-platform-install.ts` (docs/designs/preset-agents.md §5.3) —
 * the PLATFORM-published (distributed) Slack app install: the true "Add to
 * Slack". One deployment-level app (SLACK_PLATFORM_* env) that every org
 * installs into its own workspace via standard OAuth v2; the resulting Bot is
 * shareable/http and auto-binds to the org's `agentconnect` preset agent (or an
 * explicitly chosen one).
 *
 * TWO plugins, mirroring the quick-install funnel's split:
 *  - `slackPlatformInstallRoutes` mounts inside `/orgs/:orgId` (humanAuth +
 *    org-scope): mint a pending-install row whose id doubles as the OAuth
 *    `state` — binding {org, target agent, user} — and return the authorize URL.
 *    A bare share URL cannot carry tenancy, so installs always start here.
 *  - `slackPlatformCallbackRoutes` mounts at the version root, UNAUTHENTICATED
 *    (Slack redirects the installer's browser). The exchange runs server-side
 *    with the env credentials; the browser gets only a self-closing page.
 *
 * Distributed apps are Events-API-only (a socket-mode xapp is per-app and cannot
 * be demuxed per workspace), so the start route hard-requires the relay pool.
 * The target agent may be UNPLACED: the Bot + Integration rows are created and
 * the relay assignment converges when the agent is placed.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import { denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit } from '../visibility.js'
import { resolveWebAppUrl } from '../../config/env.js'
import { SLACK_BOT_SCOPES, slackPlatformOAuthRedirectUri } from '../slack-manifest.js'
import { installNewSlackBot } from '../install-slack.js'
import { closePageHtml, relayHttpBase } from './slack-install.js'
import {
  SlackPlatformInstallStartBody,
  SlackPlatformInstallStartDto,
  SlackPlatformInstallStatusDto,
  ErrorDto
} from '../dto/index.js'

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'

export function slackPlatformInstallRoutes(deps: HttpDeps) {
  return async function slackPlatformInstallRoutesPlugin(app: FastifyInstance): Promise<void> {
    const platform = deps.slackPlatformApp
    const publicCpUrl = deps.config.PUBLIC_CP_URL
    if (!platform || !publicCpUrl) return // feature off — routes 404, console hides "Add to Slack"
    const redirectUri = slackPlatformOAuthRedirectUri(publicCpUrl)
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/integrations/slack/platform-install',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Start platform Slack app install',
          description:
            'Mint a pending install of the platform-published Slack app — the OAuth `state` binds {org, target agent, user} — and return the slack.com authorize URL to open. The target defaults to the org’s `agentconnect` preset agent. Requires the relay pool (the distributed app is Events-API-only).',
          operationId: 'startSlackPlatformInstall',
          body: SlackPlatformInstallStartBody,
          response: { 201: SlackPlatformInstallStartDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        const orgId = req.orgCtx!.orgId
        // Events-API-only: same relay precondition as an http quick-install.
        if (!relayHttpBase(deps.config.PUBLIC_RELAY_URL) || !deps.sharedBot.hasConnectedRelay()) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'HTTP-mode Slack requires a connected relay (PUBLIC_RELAY_URL + a running relay)'
          })
        }
        // Explicit target, else the org's general preset (the design's default
        // bind target). No placement requirement — http delivery converges later.
        let agentId = req.body.agentId
        if (!agentId) {
          const preset = await deps.repos.presetAgent.get(orgId, 'general')
          agentId = preset?.agentId ?? undefined
        }
        if (!agentId) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'no target agent: pass agentId (the agentconnect preset is absent in this org)'
          })
        }
        const agent = await deps.repos.agent.get(AgentId(agentId))
        if (!agent || agent.orgId !== orgId || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }

        const install = await deps.repos.slackPlatformInstall.create({
          id: randomUUID(),
          orgId,
          agentId: agent.id,
          createdByUserId: req.principal.userId
        })
        const url = new URL(SLACK_AUTHORIZE_URL)
        url.searchParams.set('client_id', platform.clientId)
        url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','))
        url.searchParams.set('state', install.id)
        url.searchParams.set('redirect_uri', redirectUri)
        return reply.code(201).send({ id: install.id, installUrl: url.toString() })
      }
    )

    r.get(
      '/integrations/slack/platform-install/:id',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Poll platform Slack app install',
          description:
            'Completion signal for the "Add to Slack" round trip: `pending` while the authorize tab is open, then `completed` (the Bot + install are live) or `failed` with a short reason code. Returns no tokens.',
          operationId: 'getSlackPlatformInstall',
          params: z.object({ id: z.string() }),
          response: { 200: SlackPlatformInstallStatusDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const row = await deps.repos.slackPlatformInstall.get(req.params.id)
        // Org-scoped read: the id is an unforgeable OAuth state, but this route is
        // still tenant-bound like every other org resource.
        if (!row || row.orgId !== req.orgCtx!.orgId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'install not found' })
        }
        return { id: row.id, status: row.status, failureReason: row.failureReason, botId: row.botId }
      }
    )
  }
}

/**
 * The unauthenticated platform-app OAuth callback. Mounted TWICE by `server.ts`
 * (sibling of `slackOauthCallbackRoutes`): the internal version root (`/api/v1`,
 * where the edge's `/v1` rewrite lands) and the public `/v1` alias — the
 * registered redirect URL uses the public form (SLACK_PLATFORM_OAUTH_CALLBACK_PATH).
 *
 * Unlike the funnel callback this one FINISHES the install server-side: the
 * exchange yields the workspace's bot token + team identity, and (idempotently
 * on the composite (appId, teamId) Bot identity) the Bot + Integration are
 * created — or an uninstalled workspace's Bot is revived with the fresh token.
 * A workspace already bound to a DIFFERENT org is refused (`workspace_taken`).
 */
export function slackPlatformCallbackRoutes(deps: HttpDeps) {
  return async function slackPlatformCallbackRoutesPlugin(app: FastifyInstance): Promise<void> {
    const platform = deps.slackPlatformApp
    const api = deps.slackConfigApi
    const publicCpUrl = deps.config.PUBLIC_CP_URL
    if (!platform || !api || !publicCpUrl) return
    const redirectUri = slackPlatformOAuthRedirectUri(publicCpUrl)
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/integrations/slack/platform/callback',
      {
        schema: {
          hide: true,
          querystring: z.object({
            code: z.string().optional(),
            state: z.string().optional(),
            error: z.string().optional()
          })
        }
      },
      async (req, reply): Promise<FastifyReply> => {
        const consoleUrl = resolveWebAppUrl(deps.config)
        const back = (note: Parameters<typeof closePageHtml>[0]): FastifyReply =>
          reply.type('text/html').send(closePageHtml(note, consoleUrl))

        if (req.query.error || !req.query.code || !req.query.state) return back('denied')
        const row = await deps.repos.slackPlatformInstall.get(req.query.state)
        // Single-use state. The row now SURVIVES the callback (it is the console's
        // completion signal), so "already consumed" is a status check rather than
        // absence — without it a replayed callback would re-run the whole install
        // and advance the credential generation a second time.
        if (!row || row.status !== 'pending') return back('expired')
        // Settle the row with the SAME note the close page shows: it is the
        // console's completion signal (the poll can't infer success from a new
        // integration — a re-authorization need not create one).
        const fail = async (note: Parameters<typeof closePageHtml>[0]): Promise<FastifyReply> => {
          await deps.repos.slackPlatformInstall.settle(row.id, { status: 'failed', failureReason: note })
          return back(note)
        }

        const exchanged = await api.exchangeOAuth({
          clientId: platform.clientId,
          clientSecret: platform.clientSecret,
          code: req.query.code,
          redirectUri
        })
        if (!exchanged.ok) {
          req.log.warn({ installId: row.id, error: exchanged.error }, 'slack platform oauth exchange failed')
          return fail('error')
        }
        const result = exchanged.result
        // The code must be for OUR distributed app, and the composite demux key
        // needs the workspace id — refuse anything else rather than mint an
        // unroutable (or wrong-app) bot.
        if (result.appId !== platform.appId || !result.teamId) {
          req.log.warn({ installId: row.id, appId: result.appId }, 'slack platform oauth: unexpected app/team')
          return fail('error')
        }

        const agent = await deps.repos.agent.get(row.agentId)
        if (!agent || agent.orgId !== row.orgId) {
          // Target deleted while the tab was open — nothing sane to bind to.
          return fail('error')
        }

        const existing = await deps.repos.bot.getBySlackAppTeam(platform.appId, result.teamId)
        if (existing && existing.orgId !== row.orgId) {
          // A workspace binds to exactly one org (the demux key is global).
          // Don't leak WHICH org holds it.
          req.log.warn({ installId: row.id, botId: existing.id }, 'slack platform install: workspace already bound')
          return fail('workspace_taken')
        }

        let botId: string
        if (existing) {
          // Re-install into the same org: the Bot row is the durable identity —
          // rotate to the fresh token, clear any uninstall marker, and make sure
          // the target agent has an active install; then reconverge the pool.
          botId = existing.id
          await deps.repos.botSecret.put(BotId(existing.id), {
            botToken: result.botToken,
            appToken: null,
            signingSecret: platform.signingSecret
          })
          // Advance the install GENERATION (and clear the revocation marker with
          // it, in one statement). MUST happen before the syncBot below so the
          // pool is re-assigned with the new revision: any `app_uninstalled` from
          // the install this one replaces is now fenced out (§5.3 lifecycle).
          const revision = await deps.repos.bot.bumpCredential(BotId(existing.id), new Date())
          req.log.info({ botId: existing.id, revision }, 'slack platform re-install: credential generation advanced')
          const installs = await deps.repos.integration.listForBot(existing.id)
          if (!installs.some((i) => i.agentId === agent.id)) {
            await deps.repos.integration.create({
              id: IntegrationId(randomUUID()),
              orgId: OrgId(row.orgId),
              agentId: agent.id,
              botId: existing.id,
              platform: 'slack',
              name: existing.name,
              ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {})
            })
          }
          await deps.sharedBot.syncBot(existing.id)
        } else {
          const created = await installNewSlackBot(deps, req.log, {
            orgId: OrgId(row.orgId),
            agent,
            name: result.teamName ? `AgentConnect (${result.teamName})` : 'AgentConnect',
            botToken: result.botToken,
            transport: 'http',
            shareable: true,
            prebuilt: true,
            slackAppId: platform.appId,
            teamId: result.teamId,
            ...(result.botUserId ? { botUserId: result.botUserId } : {}),
            signingSecret: platform.signingSecret,
            ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {})
          })
          botId = created.botId
        }

        // Terminal state, not deletion: the console polls this row to learn the
        // OAuth tab finished. A re-authorization that only rotated the token
        // creates no integration, so row growth cannot be the success test.
        await deps.repos.slackPlatformInstall.settle(row.id, { status: 'completed', botId })
        return back('connected')
      }
    )
  }
}
