/**
 * `http/routes/slack-install.ts` (docs/designs/slack-install-smoothing.md §Tier B) —
 * the config-token AUTO-install funnel that fronts `POST /integrations`.
 *
 * TWO plugins:
 *  - `slackInstallRoutes` mounts inside `/orgs/:orgId` (humanAuth + org-scope):
 *    start (manifest.create → pending row → OAuth install link), poll, and finalize
 *    (validate the pasted app-level token + the OAuth-obtained bot token → mint the
 *    real bot + integration → delete the pending row).
 *  - `slackOauthCallbackRoutes` mounts at the API version root, UNAUTHENTICATED
 *    (Slack redirects a browser here). The unforgeable pending-row id rides the
 *    OAuth `state`; the exchange runs server-side and the bot token is stashed on
 *    the row, NEVER handed to the browser (the redirect carries only a note).
 *
 * The funnel needs a public HTTPS callback (`PUBLIC_CP_URL`) and the Slack config
 * API; absent either, none of these routes register and the console falls back to
 * the manual manifest flow. The owning agent must be placed on a daemon (like
 * `POST /integrations`); the bot token never leaves the CP.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { samePlacementRef } from '../../domain/placement.js'
import { denyViewerWrite, ctxOf, orgOf } from '../rbac.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { resolveWebAppUrl } from '../../config/env.js'
import { buildInstallManifest, checkSlackBotScopes, slackOAuthRedirectUri } from '../slack-manifest.js'
import { agentIconBackgroundColor } from '../../agents/agent-icon.js'
import { installNewSlackBot, slackAppIdFromAppToken } from '../install-slack.js'
import { CONFIG_ACCESS_TTL_MS, configUsable } from '../slack-user-config.js'
import type { SlackRouteSeams } from '../platform-route-seams.js'
import { integrationPlatformAvailability } from '../daemon-platform-capability.js'
import { relayHttpBase, relayIngress } from '../relay-ingress.js'
import {
  SlackAppStartBody,
  SlackAppStartDto,
  SlackAppStatusDto,
  SlackAppFinalizeBody,
  SlackConfigBody,
  SlackConfigDto,
  IntegrationDto,
  ErrorDto,
  SlackInstallErrorDto,
  IdParam
} from '../dto/index.js'

/** Slack error strings from `apps.manifest.create` that mean the config token itself is
 *  invalid/expired (as opposed to a transient error or a rate limit). An ACCESS-ONLY stored
 *  token that hits one of these is dropped so the console re-prompts; other errors keep it. */
const SLACK_CONFIG_AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
  'account_inactive',
  'no_permission',
  'missing_scope'
])

export function slackInstallRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async function slackInstallRoutesPlugin(app: FastifyInstance): Promise<void> {
    const api = slack.configApi
    const publicCpUrl = deps.config.PUBLIC_CP_URL
    if (!api || !publicCpUrl) return // feature off — routes 404, console uses the manual flow
    const redirectUri = slackOAuthRedirectUri(publicCpUrl)
    const r = app.withTypeProvider<ZodTypeProvider>()
    const orgIdOf = (req: { orgCtx?: { orgId: OrgId } }) => req.orgCtx!.orgId

    r.post(
      '/integrations/slack/app',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Start Slack auto-install',
          description:
            "Create a Slack app from a manifest using the ORG's stored App Configuration token (Settings), then return the browser OAuth install link. The stored token is auto-rotated when stale.",
          operationId: 'startSlackAppInstall',
          body: SlackAppStartBody,
          response: {
            201: SlackAppStartDto,
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
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // Delivery is daemon-scoped; refuse until the agent is placed. A pool agent IS placed and
        // names no machine, so the capability probe asks whichever member serves it.
        const installDaemonId = await deps.placementResolver.servingDaemon(agent)
        if (!installDaemonId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent must be placed on a daemon first' })
        }
        const platformAvailability = await integrationPlatformAvailability(deps, {
          daemonId: installDaemonId,
          orgId,
          viewer: ctxOf(req),
          platform: 'slack'
        })
        if (platformAvailability === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (platformAvailability === 'unsupported') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'daemon does not support slack integrations'
          })
        }

        // The CALLER's own config token creates the app (rotated fresh if stale), so
        // the app is owned by them and only they can mint its app-level token.
        // Resolved through the platform's §9 tooling-credential facet — the same
        // instance the registry advertises — so the funnel and the provider can
        // never disagree about which store answers or when a token is stale.
        const config = (await slack.toolingCredentials?.resolveAccessToken(
          orgId,
          req.principal.userId,
          new Date()
        )) ?? { ok: false as const, reason: 'unreachable' as const }
        if (!config.ok) {
          if (config.reason === 'unreachable') {
            return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: 'could not reach Slack' })
          }
          const message =
            config.reason === 'not_configured'
              ? 'You haven’t stored your Slack App Configuration token — add it to enable one-click installs.'
              : config.reason === 'expired'
                ? 'Your Slack App Configuration token expired — re-enter it (add a refresh token to keep it from expiring).'
                : 'Your stored Slack App Configuration token is invalid or expired — re-add it.'
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
        }

        // Transport (slack-http-mode): http ⇒ the CP builds an Events-API manifest and
        // captures the signing secret from apps.manifest.create, so finalize needs no
        // manual paste. http requires a relay Slack itself can POST to.
        const transport = req.body.transport ?? 'socket'
        const ingress = transport === 'http' ? relayIngress(deps) : null
        if (ingress && !ingress.ok) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: ingress.message })
        }
        const httpBase = ingress?.ok ? ingress.base : undefined

        // The CP owns the manifest (chiefly `redirect_urls`): a client-supplied
        // redirect would be an open-redirect / token-theft hole.
        const name = req.body.name?.trim() || agent.name
        // Brand the created app with the agent's icon color (Slack has no API to set
        // the app image itself) — its avatar plate → the manifest background_color.
        const bgColor = agentIconBackgroundColor(agent.icon)
        const manifest = buildInstallManifest(name, redirectUri, {
          ...(httpBase ? { httpRelayBase: httpBase } : {}),
          ...(bgColor ? { backgroundColor: bgColor } : {})
        })
        let created = await api.createApp(config.accessToken, manifest)

        // Slack rejected the config token. resolve() hands back a fresh (unexpired) access
        // token WITHOUT re-validating it, so a refresh-backed config may still hold a
        // bad-but-unexpired token: force one rotation to mint a new token and retry. If the
        // retry still auth-fails — or the token is access-only, with nothing to rotate — the
        // config can't work, so drop it and the console re-prompts. Non-auth errors (rate
        // limit, etc.) and transient unreachable keep the row.
        if (!created.ok && SLACK_CONFIG_AUTH_ERRORS.has(created.error)) {
          const stored = await deps.repos.slackUserConfig.get(orgId, req.principal.userId)
          if (stored?.refreshToken) {
            const rotated = await api.rotateConfigToken(stored.refreshToken)
            if (rotated.ok) {
              await deps.repos.slackUserConfig.put(orgId, req.principal.userId, rotated.rotated)
              created = await api.createApp(rotated.rotated.accessToken, manifest)
            } else if (rotated.error === 'unreachable') {
              // Couldn't reach Slack to rotate — transient, not a dead config. Keep the row.
              return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: 'could not reach Slack' })
            }
          }
          if (!created.ok && SLACK_CONFIG_AUTH_ERRORS.has(created.error)) {
            await deps.repos.slackUserConfig.delete(orgId, req.principal.userId)
          }
        }

        if (!created.ok) {
          if (created.error === 'unreachable') {
            return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: 'could not reach Slack' })
          }
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: `Slack rejected the app creation (${created.error}). Check your App Configuration Token — it expires 12h after you generate it.`
          })
        }

        // http can't work without the signing secret the relay HMACs inbound POSTs with.
        // Slack returns it in the create response; if it's absent, fail now rather than
        // mint a pending install that finalizes into an unverifiable (dead) bot.
        if (transport === 'http' && !created.app.signingSecret) {
          return reply.code(502).send({
            error: 'Bad Gateway',
            statusCode: 502,
            message: 'Slack did not return an app signing secret — cannot set up HTTP mode.'
          })
        }

        const installId = randomUUID()
        await deps.repos.slackInstall.create({
          id: installId,
          orgId,
          agentId: agent.id,
          appId: created.app.appId,
          clientId: created.app.clientId,
          clientSecret: created.app.clientSecret,
          transport,
          // http finalizes with no paste — stash the signing secret captured at create.
          // (shareable is NOT stored — it rides the finalize body.)
          ...(transport === 'http' ? { signingSecret: created.app.signingSecret } : {}),
          ...(req.body.name?.trim() ? { name: req.body.name.trim() } : {}),
          ...(req.principal ? { createdByUserId: req.principal.userId } : {})
        })

        // The authorize URL already carries client_id + scopes; pin our state +
        // redirect_uri (byte-identical to the exchange step — Slack rejects a mismatch).
        const installUrl = new URL(created.app.oauthAuthorizeUrl)
        installUrl.searchParams.set('state', installId)
        installUrl.searchParams.set('redirect_uri', redirectUri)
        return reply
          .code(201)
          .send({ installId, appId: created.app.appId, installUrl: installUrl.toString(), transport })
      }
    )

    r.get(
      '/integrations/slack/app/:id',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Poll Slack auto-install',
          description:
            'Funnel progress: `awaiting_oauth` until the user approves the install in Slack, then `bot_ready` — at which point the console unlocks the app-level-token step. Never returns tokens.',
          operationId: 'getSlackAppInstall',
          params: IdParam,
          response: { 200: SlackAppStatusDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const row = await deps.repos.slackInstall.get(orgIdOf(req), req.params.id)
        if (!row) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'install not found' })
        }
        const status = row.botToken ? ('bot_ready' as const) : ('awaiting_oauth' as const)
        return { installId: row.id, appId: row.appId, status, transport: row.transport }
      }
    )

    r.post(
      '/integrations/slack/app/:id/finalize',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Finalize Slack auto-install',
          description:
            'Combine the OAuth-obtained bot token (held server-side) with the operator-pasted app-level token to create the bot + integration and push it live, then delete the pending session. Refuses with `SLACK_MISSING_SCOPES` (and the `missingScopes` list) when the workspace authorization granted fewer bot scopes than the app requires, so a short install never becomes a bot.',
          operationId: 'finalizeSlackAppInstall',
          params: IdParam,
          body: SlackAppFinalizeBody,
          response: {
            201: IntegrationDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: SlackInstallErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgIdOf(req)
        const row = await deps.repos.slackInstall.get(orgId, req.params.id)
        if (!row) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'install not found' })
        }
        if (!row.botToken) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'approve the install in Slack first' })
        }
        // Defense in depth: an http install with no captured signing secret can't be
        // verified by the relay — refuse rather than mint a dead bot (start rejects this
        // too, but a legacy/edge pending row must not slip an unverifiable bot through).
        if (row.transport === 'http' && !row.signingSecret) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'This HTTP install is missing its Slack signing secret — start the install again.'
          })
        }
        // Socket transport needs the operator-pasted app-level token (no Slack API mints
        // it); http captured the signing secret at app-create, so it finalizes with an
        // empty body and no paste.
        if (row.transport === 'socket') {
          if (!req.body.appToken) {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'An App-Level Token (xapp-…) is required to finish a Socket Mode install.'
            })
          }
          if (slackAppIdFromAppToken(req.body.appToken) !== row.appId) {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'The app-level token belongs to a different Slack app.'
            })
          }
          const appCheck = await slack.verifyAppToken?.(req.body.appToken)
          if (appCheck === 'invalid') {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message:
                'Slack rejected the app-level token — check you pasted the App-Level Token (xapp-…) and gave it the connections:write scope.'
            })
          }
        }
        // Re-check the agent: it could have been deleted / unplaced during the funnel.
        let agent = await deps.repos.agent.get(orgOf(req), row.agentId)
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // A pool agent IS placed and names no machine; the probe asks whichever member serves it.
        const installDaemonId = await deps.placementResolver.servingDaemon(agent)
        if (!installDaemonId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent must be placed on a daemon first' })
        }
        const platformAvailability = await integrationPlatformAvailability(deps, {
          daemonId: installDaemonId,
          orgId,
          viewer: ctxOf(req),
          platform: 'slack'
        })
        if (platformAvailability === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (platformAvailability === 'unsupported') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'daemon does not support slack integrations'
          })
        }

        // auth.test supplies display-only workspace metadata for the Settings
        // grouping. It also remains the fallback source for an omitted app name,
        // and — via `x-oauth-scopes` — the granted bot scopes checked below.
        const botCheck = slack.verifyBot ? await slack.verifyBot(row.botToken) : null

        // Slack's authorization does not reliably apply every bot permission the
        // manifest declares, and a short grant installs SILENTLY: the shortfall
        // only surfaces much later, when a scoped call starts answering
        // `missing_scope` and the session-access check fails closed. Refuse it
        // here — while the operator is still in the flow and one reinstall away
        // — and name the scopes so the console can say which. Before
        // `installNewSlackBot` on purpose: a short grant must not leave a bot or
        // integration behind. An inconclusive check never blocks (see
        // `checkSlackBotScopes`); repairing an ALREADY-installed bot stays the
        // Settings refresh's job.
        if (botCheck?.status === 'ok') {
          const grant = checkSlackBotScopes(botCheck.scopes)
          if (grant.status === 'short') {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              code: 'SLACK_MISSING_SCOPES',
              message: `Slack didn’t grant every permission this app needs. Reinstall it in your Slack workspace, then finish here. Missing: ${grant.missing.join(', ')}`,
              missingScopes: grant.missing
            })
          }
        }

        const name = row.name || (botCheck?.status === 'ok' ? botCheck.name : null) || agent.name
        const release = deps.agentMutations.tryBeginMutation(agent.id)
        if (!release) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'agent move is in progress; retry finalizing the integration'
          })
        }
        try {
          // Token verification and capability checks above can take long enough
          // for placement to change. Re-read after taking the mutation side of
          // the move gate so the bot cannot be installed onto a stale daemon.
          // Placement IDENTITY, not the column: a set placement names no machine.
          const current = await deps.repos.agent.get(orgOf(req), agent.id)
          if (
            !current ||
            !samePlacementRef(current, agent) ||
            current.lastModifiedAt.getTime() !== agent.lastModifiedAt.getTime()
          ) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent placement changed; refresh and retry finalizing the integration'
            })
          }
          agent = current
          const integration = await installNewSlackBot(deps, app.log, {
            orgId,
            agent,
            name,
            botToken: row.botToken,
            transport: row.transport,
            slackAppId: row.appId,
            ...(botCheck?.status === 'ok' && botCheck.teamId ? { workspaceId: botCheck.teamId } : {}),
            ...(botCheck?.status === 'ok' && botCheck.teamName ? { workspaceName: botCheck.teamName } : {}),
            ...(botCheck?.status === 'ok' && botCheck.botUserId ? { botUserId: botCheck.botUserId } : {}),
            // The granted set behind the fence above, kept on the bot row so
            // capability reads don't have to re-probe Slack.
            ...(botCheck?.status === 'ok' && botCheck.scopes?.length ? { grantedScopes: botCheck.scopes } : {}),
            // socket: the pasted xapp; http: the signing secret captured at create. The
            // shareable choice rides the finalize body (installNewSlackBot coerces it off
            // for socket regardless).
            ...(req.body.appToken ? { appToken: req.body.appToken } : {}),
            ...(row.signingSecret ? { signingSecret: row.signingSecret } : {}),
            ...(req.body.shareable ? { shareable: true } : {}),
            ...(req.principal ? { createdByUserId: req.principal.userId } : {})
          })
          // Tokens now live in bot_secret — drop the pending row so no copy lingers.
          await deps.repos.slackInstall.delete(orgId, row.id)
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
        } finally {
          release()
        }
      }
    )
  }
}

/**
 * `slackConfigRoutes` — the CALLER's stored Slack App Configuration token
 * (docs/designs/slack-install-smoothing.md §Tier B), managed from the console. PER-USER:
 * the token belongs to whoever stored it, and the app the funnel creates from it is
 * owned by them — so each initiator stores their own and installs independently. The
 * caller having one (+ the funnel enabled) forces the auto-install flow; absent ⇒ the
 * manual flow. Org-scoped route, keyed by (orgId, caller). Gated on the Slack config
 * API (used to validate the token on save). The tokens are secret material — GET
 * returns only status, never the token.
 */
export function slackConfigRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async function slackConfigRoutesPlugin(app: FastifyInstance): Promise<void> {
    const api = slack.configApi
    if (!api) return // no Slack API wired ⇒ routes 404, console shows the manual flow
    const r = app.withTypeProvider<ZodTypeProvider>()
    const orgIdOf = (req: { orgCtx?: { orgId: OrgId } }) => req.orgCtx!.orgId
    // Auto-install is only usable when the funnel's public callback is configured too.
    const funnelEnabled = !!deps.config.PUBLIC_CP_URL
    // The relay pool's public HTTPS base (Events API request_url the console shows to
    // paste into Slack), ws→http normalized. Null when PUBLIC_RELAY_URL is unset.
    const relayPublicUrl = relayHttpBase(deps.config.PUBLIC_RELAY_URL)

    const statusOf = async (orgId: OrgId, userId: string, now = new Date()) => {
      const row = await deps.repos.slackUserConfig.get(orgId, userId)
      // Durable = a refresh token is stored (the pair auto-rotates). Usable now = durable
      // or the access-only token is still fresh; a lapsed access-only token forces re-entry.
      const durable = !!row?.refreshToken
      // The credential half of "auto-install is offerable" is `configUsable` — the
      // SAME pure predicate the §9 facet's `usableNow` applies, so this surface and
      // the flows that call the facet cannot disagree about the rule. It is applied
      // to the row already in hand rather than through `usableNow`, which would
      // re-read it: this route IS the credential surface (§9 puts the store's
      // entry/rotation/status routes on `installRoutes`, and the facet is what the
      // platform's OTHER flows call back into), so a second round-trip would buy
      // nothing and would split one response across two snapshots of one row.
      // The deployment half — a configured public callback origin — stays here,
      // which is what knows it.
      const credentialUsable = configUsable(row, now)
      // HTTP mode is offerable here: the SAME gate the http install paths refuse
      // on, so the console never offers a transport the create call would reject.
      const relayAvailable = relayIngress(deps).ok
      return {
        configured: !!row,
        durable,
        funnelEnabled,
        autoAvailable: funnelEnabled && credentialUsable,
        accessExpiresAt: row ? row.accessExpiresAt.toISOString() : null,
        relayAvailable,
        relayPublicUrl,
        // The platform-published "Add to Slack" app (preset-agents.md §5.3): env
        // credentials + public callback + the relay pool, all present.
        platformInstallAvailable: !!slack.platformApp && funnelEnabled && relayAvailable,
        updatedAt: row ? row.updatedAt.toISOString() : null
      }
    }

    r.get(
      '/slack/config',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Slack config status',
          description:
            "Whether the signed-in caller has stored their own App Configuration token (drives the create modal's forced auto/manual mode) and whether auto-install is usable here. Never returns the token.",
          operationId: 'getSlackConfig',
          response: { 200: SlackConfigDto, 401: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        return statusOf(orgIdOf(req), req.principal.userId)
      }
    )

    r.put(
      '/slack/config',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Store Slack config token',
          description:
            'Save (or replace) the caller’s own Slack App Configuration token. With a refresh token it is validated + normalized by rotating once (durable, never expires); access-token-only is stored as-is with Slack’s ~12h lifetime and verified at install time. Forces the create modal into auto-install for this caller.',
          operationId: 'putSlackConfig',
          body: SlackConfigBody,
          response: { 200: SlackConfigDto, 400: ErrorDto, 401: ErrorDto, 403: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        const orgId = orgIdOf(req)
        const now = new Date()
        if (req.body.refreshToken) {
          // Refresh token supplied ⇒ validate + normalize by rotating it: confirms the
          // pair works AND yields the exact expiry. Each rotate issues a NEW pair (the
          // pasted access token is accepted for parity with Slack's UI but superseded by
          // the rotate). The stored pair auto-rotates from here on — durable.
          const rotated = await api.rotateConfigToken(req.body.refreshToken)
          if (!rotated.ok) {
            if (rotated.error === 'unreachable') {
              return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: 'could not reach Slack' })
            }
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: `Slack rejected the config token (${rotated.error}). Regenerate it at api.slack.com/apps → “Your App Configuration Tokens”.`
            })
          }
          await deps.repos.slackUserConfig.put(orgId, req.principal.userId, rotated.rotated)
        } else {
          // Access-only ⇒ nothing to rotate. Store the access token as-is with Slack's
          // documented ~12h lifetime; it is verified when the caller starts an install
          // (apps.manifest.create rejects a bad/expired token with a clear message). Once
          // it lapses the caller re-enters it, or adds a refresh token to make it durable.
          await deps.repos.slackUserConfig.put(orgId, req.principal.userId, {
            accessToken: req.body.accessToken,
            refreshToken: null,
            accessExpiresAt: new Date(now.getTime() + CONFIG_ACCESS_TTL_MS)
          })
        }
        return statusOf(orgId, req.principal.userId, now)
      }
    )

    r.delete(
      '/slack/config',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Clear Slack config token',
          description:
            'Remove the caller’s own stored App Configuration token; their create modal falls back to the manual flow.',
          operationId: 'deleteSlackConfig',
          response: { 204: z.null(), 401: ErrorDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        await deps.repos.slackUserConfig.delete(orgIdOf(req), req.principal.userId)
        return reply.code(204).send(null)
      }
    )
  }
}

export type SlackCallbackNote =
  | 'connected'
  | 'denied'
  | 'expired'
  | 'error'
  | 'workspace_taken'
  | 'workspace_mismatch'
  | 'agent_taken'
  | 'missing_scopes'

/**
 * The callback tab is a THROWAWAY — the real flow continues in the ORIGINAL
 * console tab, which polls for `bot_ready`. Redirecting here dumped the user on
 * the console home, which reads as "do something" when there's nothing to do. So
 * serve a tiny self-contained page that says the tab is done and auto-closes on
 * success. No request data is reflected (the note is server-chosen; the optional
 * link origin comes from config), so there's nothing to escape.
 *
 * Exported for the platform-app callback (slack-platform-install.ts), which
 * shares the throwaway-tab UX (and adds workspace/admission outcomes — the
 * platform bot is non-shareable, so a workspace backs one agent).
 */
export function closePageHtml(note: SlackCallbackNote, consoleUrl?: string): string {
  const ok = note === 'connected'
  const heading = ok ? 'Connected to Slack' : 'Slack sign-in didn’t finish'
  const body =
    note === 'connected'
      ? 'You can close this tab — head back to AgentConnect to finish adding the integration.'
      : note === 'expired'
        ? 'This install link expired. Close this tab and start again in AgentConnect.'
        : note === 'denied'
          ? 'The install was cancelled. Close this tab and try again in AgentConnect.'
          : note === 'workspace_taken'
            ? 'This Slack workspace is already connected to a different AgentConnect organization. Remove that connection first, then try again.'
            : note === 'workspace_mismatch'
              ? 'Slack authorized a different workspace. Close this tab and try again, choosing the workspace shown in AgentConnect.'
              : note === 'agent_taken'
                ? 'This Slack workspace is already connected to another agent in your organization. Remove that integration first, then try again.'
                : note === 'missing_scopes'
                  ? // The scopes themselves are listed in AgentConnect (this tab is
                    // a throwaway and the console is where the retry happens).
                    'Slack didn’t grant every permission AgentConnect needs. Close this tab — AgentConnect lists which ones are missing.'
                  : 'Something went wrong finishing the install. Close this tab and try again in AgentConnect.'
  // Auto-close only on success (a failure needs reading). window.close() is allowed
  // for script-opened tabs (this one was window.open'd); the text is the fallback.
  const autoClose = ok ? '<script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script>' : ''
  const link = consoleUrl ? `<p class="lnk"><a href="${consoleUrl}">Return to AgentConnect</a></p>` : ''
  const accent = ok ? '#16a34a' : '#dc2626'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e0f13;color:#e7e9ee;font:400 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.card{max-width:360px;padding:36px 28px;text-align:center}.mark{width:44px;height:44px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:22px;color:#fff;background:${accent};margin-bottom:16px}h1{font-size:16.5px;font-weight:650;margin:0 0 8px}p{margin:0;color:#a4abb8;font-size:13px}.lnk{margin-top:18px}a{color:#8ab4ff;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><div class="card"><div class="mark">${ok ? '✓' : '✕'}</div><h1>${heading}</h1><p>${body}</p>${link}</div>${autoClose}</body></html>`
}

/**
 * The unauthenticated Slack OAuth callback — Slack redirects the installer's
 * browser here after they approve (redirect URL = the manifest's sole
 * `redirect_urls` entry). Mounted TWICE by `server.ts` (sibling of
 * githubCallbackRoutes), outside the org subtree: at the internal version root
 * (`/api/v1`, where the edge's `/v1` rewrite lands) and at the public `/v1`
 * alias (direct-hit deploys) — the handed-out URL uses the public form, see
 * `SLACK_OAUTH_CALLBACK_PATH`. There is no bearer and no :orgId — the pending
 * row rides the OAuth `state`. The code→token exchange runs server-side; the
 * bot token is stashed on the row and NEVER handed to the browser, and the
 * callback tab just self-closes (it carries no token).
 */
export function slackOauthCallbackRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async function slackOauthCallbackRoutesPlugin(app: FastifyInstance): Promise<void> {
    const api = slack.configApi
    const publicCpUrl = deps.config.PUBLIC_CP_URL
    if (!api || !publicCpUrl) return
    const redirectUri = slackOAuthRedirectUri(publicCpUrl)
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/integrations/slack/oauth/callback',
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
        // Serve a self-closing page (no redirect to the console home). The optional
        // "Return to AgentConnect" link is pinned to the configured console origin —
        // never a request-supplied URL. The page carries NO token; the original
        // console tab polls for `bot_ready`.
        const consoleUrl = resolveWebAppUrl(deps.config)
        const back = (note: SlackCallbackNote): FastifyReply =>
          reply.type('text/html').send(closePageHtml(note, consoleUrl))

        // User denied, or Slack sent us back without the bits we need.
        if (req.query.error || !req.query.code || !req.query.state) return back('denied')
        // The callback carries no org: Slack returns only the unforgeable
        // `state` we minted, and that token IS the authority here
        // (org-scoped-data-layer.md §4). Every read below uses the row's own org.
        // eslint-disable-next-line no-restricted-syntax -- unauthenticated OAuth callback keyed by the minted state token
        const row = await deps.repos.slackInstall.getUnscoped(req.query.state)
        if (!row) return back('expired') // unknown / already-finalized / reaped state

        const exchanged = await api.exchangeOAuth({
          clientId: row.clientId,
          clientSecret: row.clientSecret,
          code: req.query.code,
          redirectUri
        })
        if (!exchanged.ok) {
          req.log.warn({ installId: row.id, error: exchanged.error }, 'slack oauth exchange failed')
          return back('error')
        }
        await deps.repos.slackInstall.setBotToken(row.orgId, row.id, exchanged.result.botToken)
        return back('connected')
      }
    )
  }
}
