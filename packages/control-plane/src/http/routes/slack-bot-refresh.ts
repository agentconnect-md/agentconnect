/**
 * `POST /bots/:id/slack/refresh` — sync AgentConnect's required configuration
 * into an existing Slack app without deleting user-owned manifest fields, then
 * report the workspace installation's granted bot scopes.
 *
 * A PROVIDER-CONTRIBUTED org route (integration-plugin-architecture.md §9
 * `installRoutes('org')`), not core. It lived in `http/routes/bots.ts` — the
 * generic durable-bot surface — where it was the last core file holding
 * `deps.slackConfigApi` + `deps.verifySlackBot` and calling
 * `resolveUserConfigAccessToken` directly. §9 names it explicitly as the flow
 * that "migrates into the provider with" the `providerToolingCredentials`
 * facet, together with the `slackAppLinks` console deep links below. The path
 * is unchanged: `botRoutes` and the registry's org plugins register into the
 * same `/api/v1/orgs/:orgId` scope (pinned in `http/platform-route-mounts.test.ts`).
 *
 * The caller's OWN App Configuration token is what can export/update the app,
 * so the token is resolved through the platform facet. If they don't own the app
 * (or stored nothing), Slack rejects the export/update and `manifest` stays
 * `manual_update_required` — the graceful fallback the DTO surfaces via the
 * settings links.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { SlackRouteSeams } from '../platform-route-seams.js'
import { BotId } from '../../domain/ids.js'
import { denyViewerWrite, orgOf } from '../rbac.js'
import { SlackBotRefreshDto, ErrorDto, IdParam, type SlackBotRefreshDtoT } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import {
  checkSlackBotScopes,
  mergeManagedSlackManifest,
  missingSlackCapabilityScopes,
  slackOAuthRedirectUri
} from '../slack-manifest.js'
import { relayHttpBase } from '../relay-ingress.js'

/** Slack errors from the manifest export/update that mean "this app is not
 *  managed by the caller's config token" — a graceful `manual_update_required`,
 *  not an outage. */
const MANUAL_MANIFEST_ERRORS = new Set([
  'app_not_eligible',
  'app_not_found',
  'app_not_owned_by_manager_app',
  'invalid_app_id',
  'no_permission'
])

/** The provider console deep links the refresh DTO carries (§9: they migrate
 *  with the tooling-credential facet). */
export function slackAppLinks(
  appId: string,
  teamId: string | null
): Pick<SlackBotRefreshDtoT, 'settingsUrl' | 'manifestUrl' | 'permissionsUrl' | 'reinstallUrl'> {
  const encodedAppId = encodeURIComponent(appId)
  const base = `https://api.slack.com/apps/${encodedAppId}`
  const workspaceBase = teamId
    ? `https://app.slack.com/app-settings/${encodeURIComponent(teamId)}/${encodedAppId}`
    : null
  return {
    settingsUrl: base,
    // Slack's current App Manifest and OAuth & Permissions editors both need the
    // workspace id (from auth.test) and app id. Reinstall uses Slack's direct
    // app-scoped install flow and therefore still works when auth.test fails.
    manifestUrl: workspaceBase ? `${workspaceBase}/app-manifest` : base,
    permissionsUrl: workspaceBase ? `${workspaceBase}/oauth` : base,
    reinstallUrl: `${base}/install-on-team?`
  }
}

export function slackBotRefreshRoutes(deps: HttpDeps, slack: SlackRouteSeams) {
  return async function slackBotRefreshRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/bots/:id/slack/refresh',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Refresh a Slack app',
          description:
            "Sync AgentConnect's required configuration into an existing Slack app without deleting user-owned manifest fields, then check the workspace installation's granted bot scopes. Returns Slack settings links when manual permission updates or workspace reinstallation are required.",
          operationId: 'refreshSlackBot',
          params: IdParam,
          response: { 200: SlackBotRefreshDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        if (bot.platform !== 'slack') {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'only Slack apps can be refreshed' })
        }
        if (!bot.slackAppId) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'Slack app id is unavailable — update this app manually in Slack'
          })
        }
        const secret = await deps.repos.botSecret.get(bot.orgId, bot.id)
        if (!secret) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'Slack app credentials are unavailable' })
        }

        // Verify identity before mutating the manifest. A manually registered
        // integration stores two independently pasted tokens; if the bot token
        // belongs to another app, updating the app encoded by the xapp token would
        // modify the wrong Slack app.
        const checked = await slack.verifyBot?.(secret.botToken)
        const appIdentityMatches = checked?.status === 'ok' && checked.appId === bot.slackAppId
        if (appIdentityMatches && checked.teamId) {
          await deps.repos.bot.setWorkspaceMetadata(bot.orgId, bot.id, checked.teamId, checked.teamName)
        }
        // The granted set observed for the STORED credential — the same token
        // capability reads (the session-access workspace checker) would use, so
        // it is recorded even when the app identity mismatches below. This is
        // how a workspace reauthorization becomes visible to those reads without
        // a re-probe. An absent header keeps the last known set.
        if (checked?.status === 'ok' && checked.scopes?.length) {
          await deps.repos.bot.setGrantedScopes(bot.orgId, bot.id, checked.scopes)
        }
        // A built-in app's manifest is deployment-managed rather than owned by
        // the signed-in user's Slack config token. Refresh still verifies its
        // installed scopes so the Console can offer the platform OAuth reinstall.
        let manifest: SlackBotRefreshDtoT['manifest'] = bot.prebuilt ? 'synced' : 'manual_update_required'
        const api = slack.configApi
        // Manifest sync needs a config token that owns THIS app — i.e. the caller's
        // own (per-user), resolved through the §9 tooling-credential facet: the SAME
        // instance the registry advertises and the install funnel uses, so the two
        // flows cannot disagree about which store answers or when a token is stale.
        if (!bot.prebuilt && api && appIdentityMatches && req.principal) {
          const config = (await slack.toolingCredentials?.resolveAccessToken(
            bot.orgId,
            req.principal.userId,
            new Date()
          )) ?? { ok: false as const, reason: 'unreachable' as const }
          if (config.ok) {
            const exported = await api.exportApp(config.accessToken, bot.slackAppId)
            if (exported.ok) {
              const redirectUrl = deps.config.PUBLIC_CP_URL
                ? slackOAuthRedirectUri(deps.config.PUBLIC_CP_URL)
                : undefined
              // An HTTP-mode bot's manifest keeps Socket Mode off + the relay pool's
              // request_urls (slack-http-mode §6); a socket bot's refresh is unchanged.
              const httpRelayBase = bot.transport === 'http' ? relayHttpBase(deps.config.PUBLIC_RELAY_URL) : null
              const updated = await api.updateApp(
                config.accessToken,
                bot.slackAppId,
                mergeManagedSlackManifest(exported.manifest, bot.name, redirectUrl, httpRelayBase ?? undefined)
              )
              manifest = updated.ok
                ? 'synced'
                : MANUAL_MANIFEST_ERRORS.has(updated.error)
                  ? 'manual_update_required'
                  : 'unknown'
            } else {
              manifest = MANUAL_MANIFEST_ERRORS.has(exported.error) ? 'manual_update_required' : 'unknown'
            }
          } else if (config.reason === 'unreachable') {
            manifest = 'unknown'
          }
        }

        let authorization: SlackBotRefreshDtoT['authorization'] = 'unknown'
        let missingScopes: string[] = []
        // Reported alongside, never folded into `authorization`: a missing capability scope
        // does not make an install broken, but silence let the console say "up to date" while
        // every optional tool answered `missing_scope`.
        let missingCapabilityScopes: string[] = []
        if (checked?.status === 'invalid') {
          authorization = 'invalid'
        } else if (checked?.status === 'ok' && checked.appId && checked.appId !== bot.slackAppId) {
          authorization = 'app_mismatch'
        } else if (checked?.status === 'ok') {
          // The same shared diff both install funnels fence on. A grant Slack
          // declined to report stays `unknown` — silence is not a shortfall.
          missingCapabilityScopes = missingSlackCapabilityScopes(checked.scopes)
          const grant = checkSlackBotScopes(checked.scopes)
          if (grant.status === 'short') {
            missingScopes = grant.missing
            authorization = 'reinstall_required'
          } else if (grant.status === 'complete') {
            authorization = 'current'
          }
        }

        return {
          manifest,
          authorization,
          missingScopes,
          missingCapabilityScopes,
          ...slackAppLinks(bot.slackAppId, appIdentityMatches && checked?.status === 'ok' ? checked.teamId : null)
        }
      }
    )
  }
}
