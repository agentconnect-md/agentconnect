/**
 * `http/routes/slack-platform-install.ts` (docs/designs/preset-agents.md §5.3) —
 * the PLATFORM-published (distributed) Slack app install: the true "Add to
 * Slack". One deployment-level app (SLACK_PLATFORM_* env) that every org
 * installs into its own workspace via standard OAuth v2. The resulting Bot is
 * always **http + NON-shareable** — Events-API-only because a distributed app has
 * no per-workspace xapp token, and one-agent because a workspace install keeps the
 * classic 1-install cap — and auto-binds to the org's `agentconnect` preset agent
 * (or an explicitly chosen one). A Settings reauthorization instead binds the
 * OAuth state to an existing Bot/workspace and preserves its memberships.
 * Serving several agents from one Slack identity remains the quick-install
 * upgrade (a dedicated app per agent).
 *
 * TWO plugins, mirroring the quick-install funnel's split:
 *  - `slackPlatformInstallRoutes` mounts inside `/orgs/:orgId` (humanAuth +
 *    org-scope): mint a pending-install row whose id doubles as the OAuth
 *    `state` — binding either {org, target agent, user} or {org, expected bot,
 *    user} — and return the authorize URL. A bare share URL cannot carry
 *    tenancy, so installs always start here.
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
import { denyViewerWrite, ctxOf, orgOf } from '../rbac.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { resolveWebAppUrl } from '../../config/env.js'
import { checkSlackBotScopes, SLACK_BOT_SCOPES, slackPlatformOAuthRedirectUri } from '../slack-manifest.js'
import { installNewSlackBot } from '../install-slack.js'
import { BotWorkspaceClaimed } from '../../persistence/errors.js'
import { closePageHtml } from './slack-install.js'
import { relayIngress } from '../relay-ingress.js'
import type { SlackRouteSeams } from '../platform-route-seams.js'
import {
  SlackPlatformInstallStartBody,
  SlackPlatformInstallStartDto,
  SlackPlatformInstallStatusDto,
  ErrorDto
} from '../dto/index.js'

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'

export function slackPlatformInstallRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async function slackPlatformInstallRoutesPlugin(app: FastifyInstance): Promise<void> {
    const platform = slack.platformApp
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
            'Mint a pending install of the platform-published Slack app and return the slack.com authorize URL. A generic install binds the OAuth state to an org, target agent, and user; a Settings reauthorization binds it to an existing bot/workspace and preserves that bot’s current agent memberships. Requires the relay pool (the distributed app is Events-API-only).',
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
        const ingress = relayIngress(deps)
        if (!ingress.ok) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: ingress.message })
        }
        let agentId: AgentId | undefined
        let expectedBotId: BotId | undefined
        if (req.body.botId) {
          // Settings reauthorization: fence the callback to this exact
          // platform-app workspace. No target agent is stored, so a freed bot
          // remains free and an active bot keeps its existing memberships.
          const bot = await deps.repos.bot.get(orgId, BotId(req.body.botId))
          if (!bot) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
          }
          if (bot.platform !== 'slack' || !bot.prebuilt || bot.slackAppId !== platform.appId || !bot.teamId) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'only an installed built-in Slack workspace can be reauthorized'
            })
          }
          expectedBotId = bot.id
        } else {
          // Explicit target, else the org's general preset (the design's default
          // bind target). No placement requirement — http delivery converges later.
          let requestedAgentId = req.body.agentId
          if (!requestedAgentId) {
            const preset = await deps.repos.presetAgent.get(orgId, 'general')
            requestedAgentId = preset?.agentId ?? undefined
          }
          if (!requestedAgentId) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'no target agent: pass agentId (the agentconnect preset is absent in this org)'
            })
          }
          const agent = await deps.repos.agent.get(orgOf(req), AgentId(requestedAgentId))
          if (!agent || !canView(agent, ctxOf(req))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
          }
          if (!canEdit(agent, ctxOf(req))) {
            return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
          }
          agentId = agent.id
        }

        const install = await deps.repos.slackPlatformInstall.create({
          id: randomUUID(),
          orgId,
          ...(agentId ? { agentId } : {}),
          ...(expectedBotId ? { botId: expectedBotId } : {}),
          createdByUserId: req.principal.userId
        })
        const url = new URL(SLACK_AUTHORIZE_URL)
        url.searchParams.set('client_id', platform.clientId)
        // ASK for everything the manifest declares, including the capability scopes: Slack
        // grants exactly what this parameter names, so a scope left out here is one no
        // install ever holds. The health fence stays on the required set — see
        // `checkSlackBotScopes`, which is what decides whether a grant was short.
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
            'Completion signal for the "Add to Slack" round trip: `pending` while the authorize tab is open, then `completed` (the Bot + install are live) or `failed` with a short reason code. A `missing_scopes` failure also lists the required bot scopes the workspace authorization withheld. Returns no tokens.',
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
        return {
          id: row.id,
          status: row.status,
          failureReason: row.failureReason,
          missingScopes: row.missingScopes,
          botId: row.botId
        }
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
export function slackPlatformCallbackRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async function slackPlatformCallbackRoutesPlugin(app: FastifyInstance): Promise<void> {
    const platform = slack.platformApp
    const api = slack.configApi
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

        // Single-use state. The row now SURVIVES the callback (it is the console's
        // completion signal), so "already consumed" is a status check rather than
        // absence — without it a replayed callback would re-run the whole install
        // and advance the credential generation a second time.
        const state = req.query.state
        const row = state ? await deps.repos.slackPlatformInstall.get(state) : null
        // Settle the row with the SAME note the close page shows: it is the
        // console's completion signal (the poll can't infer success from a new
        // integration — a re-authorization need not create one). Safe to call
        // with no pending row (a bare denial, an already-settled replay) — it
        // just renders the page.
        // `missingScopes` rides along on the short-grant refusal below: the poll
        // is the console's only channel here (this tab is a throwaway), so the
        // reason code alone would leave it unable to say WHICH permissions
        // Slack withheld.
        const fail = async (
          note: Parameters<typeof closePageHtml>[0],
          missingScopes?: readonly string[]
        ): Promise<FastifyReply> => {
          if (row?.status === 'pending') {
            await deps.repos.slackPlatformInstall.settle(row.id, {
              status: 'failed',
              failureReason: note,
              ...(missingScopes ? { missingScopes } : {})
            })
          }
          return back(note)
        }

        // A user denial DOES carry the state (`?error=access_denied&state=…`), so
        // settle the row rather than leaving the console polling a `pending` row
        // until the TTL reaper turns it into a 404 "expired".
        if (req.query.error) return fail('denied')
        if (!req.query.code || !state) return fail('denied')
        if (!row || row.status !== 'pending') return back('expired')

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

        // A Settings refresh puts its expected Bot id in the pending state. Its
        // durable platform-app teamId is the workspace fence: authorizing any
        // other workspace must fail before credentials or memberships change.
        // Unauthenticated callback: no request org context — the pending-install
        // row (minted org-scoped; its id is the OAuth state) carries the tenancy.
        const expectedBot = row.botId ? await deps.repos.bot.get(row.orgId, BotId(row.botId)) : null
        if (
          row.botId &&
          (!expectedBot ||
            expectedBot.platform !== 'slack' ||
            !expectedBot.prebuilt ||
            expectedBot.slackAppId !== platform.appId ||
            !expectedBot.teamId)
        ) {
          req.log.warn({ installId: row.id, botId: row.botId }, 'slack platform reauthorization: invalid bot fence')
          return fail('error')
        }
        if (expectedBot && result.teamId !== expectedBot.teamId) {
          req.log.warn(
            { installId: row.id, botId: expectedBot.id, expectedTeamId: expectedBot.teamId },
            'slack platform reauthorization: different workspace authorized'
          )
          return fail('workspace_mismatch')
        }

        // Unauthenticated callback: no request org context — the pending-install
        // row (minted org-scoped; its id is the OAuth state) carries the tenancy.
        const agent = row.agentId ? await deps.repos.agent.get(row.orgId, row.agentId) : null
        if (row.agentId && !agent) {
          // Target deleted while the tab was open — nothing sane to bind to.
          return fail('error')
        }
        if (!expectedBot && !agent) return fail('error')

        const existing = await deps.repos.bot.getByExternalIdentity('slack', platform.appId, result.teamId)
        if (expectedBot && existing?.id !== expectedBot.id) {
          req.log.warn(
            { installId: row.id, botId: expectedBot.id },
            'slack platform reauthorization: workspace bot changed'
          )
          return fail('workspace_mismatch')
        }
        if (existing && existing.orgId !== row.orgId) {
          // A workspace binds to exactly one org (the demux key is global).
          // Don't leak WHICH org holds it.
          req.log.warn({ installId: row.id, botId: existing.id }, 'slack platform install: workspace already bound')
          return fail('workspace_taken')
        }

        // The quick-install funnel's short-grant fence, applied to the workspace
        // token this authorization just produced. Slack does not reliably apply
        // every scope the authorize URL asked for, and a short grant is silent —
        // it surfaces much later as a scoped call answering `missing_scope` and
        // the session-access check failing closed. LAST of the fences and before
        // the first write, so a more specific refusal (wrong workspace, another
        // org's) still wins and a short grant costs no bot row, no credential
        // rotation, and no membership change. An inconclusive check never blocks
        // (see `checkSlackBotScopes`); an already-installed workspace is the
        // Settings refresh's job, not this callback's.
        const checked = await slack.verifyBot?.(result.botToken)
        const grant = checked?.status === 'ok' ? checkSlackBotScopes(checked.scopes) : { status: 'unknown' as const }
        if (grant.status === 'short') {
          req.log.warn(
            { installId: row.id, missingScopes: grant.missing },
            'slack platform install: workspace granted fewer bot scopes than required'
          )
          return fail('missing_scopes', grant.missing)
        }

        let botId: string
        if (existing) {
          // Re-install into the same org: the Bot row is the durable identity —
          // rotate to the fresh token, clear any uninstall marker, and make sure
          // the target agent has an active install; then reconverge the pool.
          botId = existing.id
          // Same-org re-install (the cross-org claim was refused above), so the
          // pending row's org is this bot's org.
          await deps.repos.bot.setWorkspaceMetadata(row.orgId, existing.id, result.teamId, result.teamName)
          // ONE transition: the fresh token and the generation it belongs to
          // commit together, so no reader (notably restart reconciliation, which
          // does not filter on `revokedAt`) can broadcast the new credential
          // under the old fence and let a delayed uninstall kill it. Also clears
          // the revocation marker, and serializes against a concurrent revoke on
          // the bot row. MUST precede the syncBot below (§5.3 lifecycle).
          const revision = await deps.repos.botCredential.install(
            existing.orgId,
            BotId(existing.id),
            { botToken: result.botToken, appToken: null, signingSecret: platform.signingSecret },
            new Date(),
            // A row-level Settings reinstall has no target agent. Restore only
            // memberships tagged with the revoked credential generation; if the
            // user deliberately freed the bot, those rows were deleted and
            // nothing is reattached.
            { restoreRevokedMemberships: !!expectedBot }
          )
          req.log.info({ botId: existing.id, revision }, 'slack platform re-install: credential generation advanced')
          // The granted set behind the short-grant fence above describes the
          // credential that just landed; record it for capability reads. An
          // absent header keeps the last known set (silence is not knowledge).
          if (checked?.status === 'ok' && checked.scopes?.length) {
            await deps.repos.bot.setGrantedScopes(existing.orgId, BotId(existing.id), checked.scopes)
          }
          if (agent) {
            // Generic install/re-install only: membership admission is ATOMIC
            // with the bot row. A bot-bound Settings reauthorization has no
            // agent target and deliberately preserves the current set instead.
            const admission = await deps.repos.integration.addBotMembership({
              id: IntegrationId(randomUUID()),
              orgId: OrgId(row.orgId),
              agentId: agent.id,
              botId: existing.id,
              platform: 'slack',
              name: existing.name,
              ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {})
            })
            if (admission.outcome === 'revoked') {
              // Exotic: the workspace uninstalled again between this callback's
              // fresh credential install and the admission — the revoke won the
              // row lock and flipped every install, so admitting now would mint a
              // live membership on the dead credential.
              req.log.warn(
                { installId: row.id, botId: existing.id, targetAgentId: agent.id },
                'slack platform re-install: bot revoked mid-callback'
              )
              await deps.httpBot.syncBot(existing.id)
              return fail('error')
            }
            if (admission.outcome === 'not_shareable') {
              // A generic re-install aimed at a different agent must not widen a
              // non-shareable workspace bot. The credential still rotated, so
              // its existing binding keeps working.
              req.log.warn(
                { installId: row.id, botId: existing.id, targetAgentId: agent.id },
                'slack platform re-install: workspace already bound to another agent'
              )
              await deps.httpBot.syncBot(existing.id)
              return fail('agent_taken')
            }
          }
          await deps.httpBot.syncBot(existing.id)
        } else {
          if (!agent || expectedBot) return fail('error')
          let created: Awaited<ReturnType<typeof installNewSlackBot>>
          try {
            created = await installNewSlackBot(deps, req.log, {
              orgId: OrgId(row.orgId),
              agent,
              name: result.teamName ? `AgentConnect (${result.teamName})` : 'AgentConnect',
              botToken: result.botToken,
              // Always http (a distributed app is Events-API-only — there is no
              // per-workspace xapp token for Socket Mode) and always NON-shareable:
              // one workspace install backs exactly one agent, keeping the classic
              // 1-install cap. Widening a workspace to several agents is the
              // quick-install upgrade path (its own Slack app), not this one.
              transport: 'http',
              shareable: false,
              prebuilt: true,
              slackAppId: platform.appId,
              teamId: result.teamId,
              workspaceId: result.teamId,
              ...(result.teamName ? { workspaceName: result.teamName } : {}),
              ...(result.botUserId ? { botUserId: result.botUserId } : {}),
              ...(checked?.status === 'ok' && checked.scopes?.length ? { grantedScopes: checked.scopes } : {}),
              signingSecret: platform.signingSecret,
              ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {})
            })
          } catch (err) {
            // The install tail's generic workspace-claim fence
            // (ingress-tenant-fence.md §5). This funnel's own identity pre-check
            // covers platform-app rows; the tail additionally catches a
            // workspace some org connected through a DIFFERENT funnel with this
            // same app id. Callback UX, not JSON: same closing page as the
            // pre-check's refusal.
            if (err instanceof BotWorkspaceClaimed) return fail('workspace_taken')
            throw err
          }
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
