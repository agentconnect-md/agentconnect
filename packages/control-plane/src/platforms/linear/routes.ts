/**
 * The Linear workspace connect funnel and its OAuth callback
 * (docs/designs/linear-integration.md §7.1, §7.4).
 *
 * TWO plugins, the Slack platform-app split:
 *  - `linearConnectRoutes` mounts inside `/orgs/:orgId` (humanAuth + org scope): start a connect
 *    (recording the chosen default agent behind a one-shot `state` nonce), poll it, and restart the
 *    funnel against an already-connected workspace whose token died (§7.4);
 *  - `linearOauthCallbackRoutes` mounts UNAUTHENTICATED at the version root, twice, because the
 *    registered redirect URL leaves the system in the public `/v1` form. The exchange runs
 *    server-side with the deployment app's credentials; the browser only ever gets a close page.
 *
 * NO Bot OR INTEGRATION ROW EXISTS BEFORE THE CALLBACK. `IntegrationStatus` has no pending value and
 * an http bot is synchronized the instant it is created, which would drive `projectIntegrationConfig`
 * before any grant existed. So the funnel row is the only pre-connect state, and the callback writes
 * everything at once, in §7.1's order: the grant first (keyed by the connection identity, which is
 * why it can precede the bot), then the shared create tail.
 *
 * Both plugins self-disable without the deployment Linear app or `PUBLIC_CP_URL` — the routes 404
 * and the console's Linear surface stays hidden, the platform-app funnel's feature-flag pattern.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import type { HttpDeps } from '../../http/deps.js'
import { AgentId, BotId, OrgId } from '../../domain/ids.js'
import { denyViewerWrite, ctxOf, orgOf } from '../../http/rbac.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { resolveWebAppUrl } from '../../config/env.js'
import { relayIngress } from '../../http/relay-ingress.js'
import { integrationPlatformAvailability } from '../../http/daemon-platform-capability.js'
import { installNewBot } from '../../http/install-bot.js'
import { deleteBotIdentity, removeIntegrationRow } from '../../http/uninstall.js'
import { BotExternalIdentityTaken, BotWorkspaceClaimed } from '../../persistence/errors.js'
import { ErrorDto, IdParam } from '../../http/dto/index.js'
import type { LinearRouteSeams } from '../../http/platform-route-seams.js'
import { buildLinearWorkspaceInstall } from './provider.js'

/** The callback's public path — the value baked into the deployment app's redirect URL (§7.1). */
export const LINEAR_OAUTH_CALLBACK_PATH = '/integrations/linear/oauth/callback'

export const linearOauthRedirectUri = (publicCpUrl: string): string =>
  `${publicCpUrl.replace(/\/$/, '')}/v1${LINEAR_OAUTH_CALLBACK_PATH}`

const LinearConnectStartBody = z.object({
  /** The workspace's default agent — the member a bare delegation starts a session with. */
  agentId: z.string().uuid()
})

const LinearConnectStartDto = z.object({
  /** The funnel row id, which IS the one-shot OAuth `state`. Poll the status route with it. */
  id: z.string(),
  connectUrl: z.string()
})

const LinearConnectStatusDto = z.object({
  id: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  failureReason: z.string().nullable(),
  botId: z.string().nullable()
})

/** Terminal notes the throwaway callback tab shows, and the codes the status route reports. */
type LinearCallbackNote =
  | 'connected'
  | 'denied'
  | 'expired'
  | 'error'
  | 'workspace_taken'
  | 'wrong_workspace'
  | 'default_agent_required'
  | 'agent_missing'

/** The callback tab is a THROWAWAY: the console keeps polling the funnel row, so this page only has
 *  to say the round trip is over. Nothing from the request is reflected — the note is server-chosen
 *  and the optional link origin comes from config — so there is nothing to escape. */
function linearClosePageHtml(note: LinearCallbackNote, consoleUrl?: string): string {
  const ok = note === 'connected'
  const heading = ok ? 'Linear workspace connected' : 'Linear connect didn’t finish'
  const body =
    note === 'connected'
      ? 'You can close this tab — head back to AgentConnect to finish setting up the workspace.'
      : note === 'expired'
        ? 'This connect link expired or was already used. Close this tab and start again in AgentConnect.'
        : note === 'denied'
          ? 'The connect was cancelled. Close this tab and try again in AgentConnect.'
          : note === 'workspace_taken'
            ? 'This Linear workspace is already connected to a different AgentConnect organization. Remove that connection first, then try again.'
            : note === 'wrong_workspace'
              ? 'Linear authorized a different workspace than the one being reconnected. Close this tab and try again, choosing the workspace shown in AgentConnect.'
              : note === 'default_agent_required'
                ? 'This workspace isn’t connected yet, so it needs a default agent. Close this tab and start the connect from AgentConnect.'
                : note === 'agent_missing'
                  ? 'The agent chosen for this workspace no longer exists. Close this tab and start again in AgentConnect.'
                  : 'Something went wrong finishing the connect. Close this tab and try again in AgentConnect.'
  const autoClose = ok ? '<script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script>' : ''
  const link = consoleUrl ? `<p class="lnk"><a href="${consoleUrl}">Return to AgentConnect</a></p>` : ''
  const accent = ok ? '#16a34a' : '#dc2626'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e0f13;color:#e7e9ee;font:400 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.card{max-width:360px;padding:36px 28px;text-align:center}.mark{width:44px;height:44px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:22px;color:#fff;background:${accent};margin-bottom:16px}h1{font-size:16.5px;font-weight:650;margin:0 0 8px}p{margin:0;color:#a4abb8;font-size:13px}.lnk{margin-top:18px}a{color:#8ab4ff;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><div class="card"><div class="mark">${ok ? '✓' : '✕'}</div><h1>${heading}</h1><p>${body}</p>${link}</div>${autoClose}</body></html>`
}

export function linearConnectRoutes(deps: HttpDeps, linear: LinearRouteSeams) {
  return async function linearConnectRoutesPlugin(app: FastifyInstance): Promise<void> {
    const platform = linear.app
    const publicCpUrl = deps.config.PUBLIC_CP_URL
    if (!platform || !publicCpUrl) return // feature off — routes 404, console hides "Connect Linear"
    const redirectUri = linearOauthRedirectUri(publicCpUrl)
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/integrations/linear/connect',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Start a Linear workspace connect',
          description:
            'Mint a one-shot OAuth state bound to this organization, the caller, and the workspace’s chosen default agent, then return the linear.app authorize URL. No bot or integration exists until the callback completes. Requires the relay pool: Linear delivers only over HTTP callbacks.',
          operationId: 'startLinearConnect',
          body: LinearConnectStartBody,
          response: { 201: LinearConnectStartDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        const orgId = req.orgCtx!.orgId
        // Linear offers no dial-out transport, so a Linear bot exists only on `http` (§4.2) — core's
        // relay-availability 409, at funnel start, before the browser leaves for linear.app.
        const ingress = relayIngress(deps)
        if (!ingress.ok) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: ingress.message })
        }
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // The pre-install gate §4.2 names: the agent's daemon is the authority for whether the
        // Linear adapter can actually run, so ask it before sending anyone through OAuth.
        const installDaemonId = await deps.placementResolver.servingDaemon(agent)
        if (!installDaemonId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent must be placed on a daemon first' })
        }
        const availability = await integrationPlatformAvailability(deps, {
          daemonId: installDaemonId,
          orgId,
          viewer: ctxOf(req),
          platform: 'linear'
        })
        if (availability === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (availability === 'unsupported') {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'daemon does not support linear integrations' })
        }

        const install = await deps.repos.linearInstallState.create({
          id: randomUUID(),
          orgId,
          defaultAgentId: agent.id,
          createdByUserId: req.principal.userId
        })
        return reply.code(201).send({
          id: install.id,
          connectUrl: linear.api.authorizeUrl({ clientId: platform.clientId, redirectUri, state: install.id })
        })
      }
    )

    r.get(
      '/integrations/linear/connect/:id',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Poll a Linear workspace connect',
          description:
            'Completion signal for the authorize round trip: `pending` while the tab is open, then `completed` (the workspace bot is live, and its id is returned) or `failed` with a short reason code. Returns no tokens.',
          operationId: 'getLinearConnect',
          params: IdParam,
          response: { 200: LinearConnectStatusDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        // `peek`, never `consume`: polling a status must not redeem the nonce the tab still holds.
        const row = await deps.repos.linearInstallState.peek(req.params.id)
        // Org-scoped read: the id is an unforgeable OAuth state, but this stays a tenant resource.
        if (!row || row.orgId !== req.orgCtx!.orgId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connect not found' })
        }
        return { id: row.id, status: row.status, failureReason: row.failureReason, botId: row.botId }
      }
    )

    r.post(
      '/bots/:id/linear/reconnect',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Reconnect a Linear workspace',
          description:
            'Restart the OAuth funnel against an already-connected workspace whose grant died (refresh rejected, the deployment app’s secret rotated, or the workspace revoked the app upstream). The callback replaces the stored grant in place; the bot, its members, and its default agent are untouched.',
          operationId: 'reconnectLinearWorkspace',
          params: IdParam,
          response: { 201: LinearConnectStartDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
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
        const bot = await deps.repos.bot.get(orgId, BotId(req.params.id))
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        // The callback resolves the target by the D6 identity, so an incomplete one has nothing to
        // reconnect — and a row from another deployment app is not this app's to re-authorize.
        if (bot.platform !== 'linear' || bot.externalAppId !== platform.clientId || !bot.externalTenantId) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'only a connected Linear workspace can be reconnected'
          })
        }
        // No default agent — the workspace already has one, so this funnel can never mint a bot —
        // and the target bot, so the callback can refuse any workspace but this one.
        const install = await deps.repos.linearInstallState.create({
          id: randomUUID(),
          orgId,
          expectedBotId: bot.id,
          createdByUserId: req.principal.userId
        })
        return reply.code(201).send({
          id: install.id,
          connectUrl: linear.api.authorizeUrl({ clientId: platform.clientId, redirectUri, state: install.id })
        })
      }
    )

    /**
     * Disconnect a workspace for the whole organization (§7.4) — every member install and
     * then the bot, as ONE call.
     *
     * It exists because the console cannot do this piecewise. `GET /integrations` is
     * VISIBILITY-FILTERED, so a member on a restricted agent outside the caller's audience
     * is invisible to it: a client loop would remove what it can see, and the bot delete
     * behind it would 409 on the member it never knew about — leaving the workspace half
     * unlinked after the operator confirmed a full disconnect. The authoritative member set
     * is `listForBot` under the bot's own org fence, and only the server holds it.
     *
     * NO per-agent `canEdit`, deliberately — that is the same filter in another costume.
     * Disconnecting is an act on the org's bot identity, gated exactly as `DELETE /bots/:id`
     * is: a non-viewer member of the owning organization. A member the caller may not edit
     * is precisely the one that must still go, or the refusal above comes back.
     */
    r.post(
      '/bots/:id/linear/disconnect',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Disconnect a Linear workspace',
          description:
            'Remove a connected Linear workspace for the whole organization: every agent’s membership of it, then the bot identity itself, whose deletion revokes the upstream grant. Atomic from the caller’s side — a partial teardown is reported as a conflict naming what is still linked, never as success.',
          operationId: 'disconnectLinearWorkspace',
          params: IdParam,
          response: { 204: z.null(), 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = req.orgCtx!.orgId
        const bot = await deps.repos.bot.get(orgId, BotId(req.params.id))
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        // Same identity fence the reconnect arm uses: a row from another deployment app is
        // not this app's to tear down, and only a completed connect has a grant to revoke.
        if (bot.platform !== 'linear' || bot.externalAppId !== platform.clientId || !bot.externalTenantId) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'only a connected Linear workspace can be disconnected'
          })
        }
        // The AUTHORITATIVE member set — org-fenced through the bot, never viewer-filtered.
        const installs = await deps.repos.integration.listForBot(bot.id)
        const memberAgentIds = [...new Set(installs.map((install) => install.agentId))]
        // Every member joins the lease: removing an install while its agent is being moved
        // is the same race the per-integration route fences, once per member here.
        const release = deps.agentMutations.tryBeginMutation(memberAgentIds)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the disconnect' })
        }
        try {
          // Bot-scoped, so it runs once around the loop rather than once per member.
          await deps.httpBot.prepareIntegrationRemoval(bot.id)
          for (const install of installs) {
            const agent = await deps.repos.agent.get(OrgId(bot.orgId), install.agentId)
            try {
              await removeIntegrationRow(deps, req.log, { orgId, integration: install, agent: agent ?? null })
            } catch (err) {
              // No silent partial success: re-read what is actually left and say so, so the
              // operator retries a disconnect rather than believing one happened.
              req.log.error({ err, botId: bot.id, integrationId: install.id }, 'linear disconnect: removal failed')
              const left = await deps.repos.integration.listForBot(bot.id)
              await deps.httpBot.syncBot(bot.id)
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: `disconnect stopped partway: ${left.length} of ${installs.length} agents are still linked to this workspace — retry the disconnect`
              })
            }
          }
          // Zero members now, so this releases the workspace from the relay pool.
          await deps.httpBot.syncBot(bot.id)
          // The shared identity teardown — the same one `DELETE /bots/:id` spends, so the
          // upstream grant revoke (§7.4 `onBotDelete`) fires on both paths.
          await deleteBotIdentity(deps, req.log, orgId, bot)
          return reply.code(204).send(null)
        } finally {
          release()
        }
      }
    )
  }
}

export function linearOauthCallbackRoutes(deps: HttpDeps, linear: LinearRouteSeams) {
  return async function linearOauthCallbackRoutesPlugin(app: FastifyInstance): Promise<void> {
    const platform = linear.app
    const publicCpUrl = deps.config.PUBLIC_CP_URL
    if (!platform || !publicCpUrl) return
    const redirectUri = linearOauthRedirectUri(publicCpUrl)
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      LINEAR_OAUTH_CALLBACK_PATH,
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
        const back = (note: LinearCallbackNote): FastifyReply =>
          reply.type('text/html').send(linearClosePageHtml(note, consoleUrl))

        // A denial or a malformed redirect leaves the nonce unclaimed — nothing to settle, and the
        // operator can retry from the same console tab.
        const state = req.query.state
        if (req.query.error || !req.query.code || !state) return back('denied')
        // The callback carries no org: the unforgeable state we minted IS the authority here, and
        // every read below uses the row's own org (org-scoped-data-layer.md §4). CLAIM it before
        // spending the code — an unknown, replayed or already-claimed nonce stops right here.
        const row = await deps.repos.linearInstallState.consume(state)
        if (!row) return back('expired')
        // From here the row is ours alone, so every exit settles it: the tab is a throwaway and the
        // console has no other way to learn a tail refusal happened.
        const fail = async (note: LinearCallbackNote): Promise<FastifyReply> => {
          await deps.repos.linearInstallState.settle(row.id, { status: 'failed', failureReason: note })
          return back(note)
        }

        const exchanged = await linear.tokens.exchangeCode({ code: req.query.code, redirectUri })
        if (!exchanged.ok) {
          req.log.warn({ connectId: row.id, error: exchanged.error }, 'linear oauth exchange failed')
          return fail('error')
        }
        const viewer = await linear.tokens.viewer(exchanged.result.accessToken)
        if (!viewer.ok) {
          req.log.warn({ connectId: row.id, error: viewer.error }, 'linear viewer query failed')
          return fail('error')
        }
        const organizationId = viewer.result.organizationId
        const identity = { orgId: row.orgId, clientId: platform.clientId, organizationId }

        // A RECONNECT is aimed at ONE workspace (§7.4), so the granted workspace must be that one —
        // checked BEFORE step 1, because writing first would rotate the grant of whatever workspace
        // was actually authorized. Without this the nonce means "any workspace of this org": an
        // operator repairing A who authorizes already-connected B would refresh B, be told it
        // succeeded, and leave A exactly as dead as before.
        if (row.expectedBotId) {
          const expected = await deps.repos.bot.get(OrgId(row.orgId), BotId(row.expectedBotId))
          if (!expected || expected.externalTenantId !== organizationId) {
            req.log.warn({ connectId: row.id, botId: row.expectedBotId }, 'linear reconnect: different workspace')
            return fail('wrong_workspace')
          }
        }

        // §7.1 STEP 1 — the grant, before anything references it. Idempotent, and the §7.4 reconnect
        // arm is this exact upsert. Keying by the connection identity is what makes the ordering
        // possible at all: the create tail below mints the bot id internally.
        await linear.tokens.put(identity, exchanged.result)

        const existing = await deps.repos.bot.getByExternalIdentity('linear', platform.clientId, organizationId)
        if (existing && existing.orgId === row.orgId) {
          // RECONNECT. The reason this is a credential INSTALL and not just a re-push: the usual way
          // a workspace ends up needing one is the `OAuthApp revoked` doorbell (§6.1, §7.4), and
          // `revokeBot` stamps `Bot.revokedAt` and flips every membership to revoked. `agentIds` is
          // active-only, so a bare `syncBot` would see an empty member set and UNASSIGN the bot
          // while this callback reported success — and leaving `credentialRevision` untouched would
          // let a delayed revoke report for the grant just replaced pass the fence and kill the new
          // one. The shared writer does all three as one transaction (the Slack platform-app
          // re-install's seam): store the credential, advance the generation, and restore exactly
          // the memberships that were revoked WITH the generation being replaced.
          const revision = await deps.repos.botCredential.install(
            OrgId(row.orgId),
            BotId(existing.id),
            { botToken: platform.clientSecret, appToken: null, signingSecret: platform.signingSecret },
            new Date(),
            { restoreRevokedMemberships: true }
          )
          req.log.info({ connectId: row.id, botId: existing.id, revision }, 'linear reconnect: credential restored')
          // Only now re-push: the assign carries the new revision, and every member's `agent.json`
          // picks up the fresh token.
          await deps.httpBot.syncBot(existing.id)
          await deps.repos.linearInstallState.settle(row.id, { status: 'completed', botId: existing.id })
          return back('connected')
        }
        if (existing) {
          // A workspace binds to exactly one organization (the D6 identity is global). Don't leak
          // WHICH one holds it; the token row just written is inert and the sweeper collects it.
          req.log.warn({ connectId: row.id, botId: existing.id }, 'linear connect: workspace already connected')
          return fail('workspace_taken')
        }

        // A first connect needs the default agent the funnel start recorded — a reconnect nonce
        // carries none, so it can never mint a bot for a workspace it was not aimed at.
        if (!row.defaultAgentId) return fail('default_agent_required')
        const agent = await deps.repos.agent.get(row.orgId, row.defaultAgentId)
        if (!agent) return fail('agent_missing')

        // §7.1 STEP 2 — the shared create tail, unchanged: bot row (D6 identity + `shareable: true`
        // structurally), the deployment credentials in its secret row, the default agent's
        // Integration active from birth, and the tail's own `syncBot` broadcast.
        try {
          const install = buildLinearWorkspaceInstall(platform, {
            workspaceId: organizationId,
            workspaceName: viewer.result.organizationName ?? undefined,
            botUserId: viewer.result.appUserId
          })
          const { bot } = await installNewBot(deps, req.log, {
            ...install,
            orgId: OrgId(row.orgId),
            agent,
            platform: 'linear',
            name: viewer.result.organizationName ?? 'Linear workspace',
            transport: 'http',
            ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {})
          })
          await deps.repos.linearInstallState.settle(row.id, { status: 'completed', botId: bot.id })
          return back('connected')
        } catch (err) {
          // Both identity fences land here as a refusal AFTER step 1 wrote the grant: the row is
          // inert (no bot references it), the next connect for this workspace overwrites it, and
          // the orphan sweeper is the backstop if none comes.
          if (err instanceof BotWorkspaceClaimed || err instanceof BotExternalIdentityTaken) {
            req.log.warn({ connectId: row.id, organizationId }, 'linear connect: workspace claimed elsewhere')
            return fail('workspace_taken')
          }
          throw err
        }
      }
    )
  }
}
