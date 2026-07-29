/**
 * `http/routes/bots.ts` — list / delete the org's durable bot identities
 * (design docs/designs/slack-integration-install.md).
 *
 * A bot outlives the integration installing it: the console's "Add integration"
 * picker reads this list to offer freed / prebuilt bots for reuse instead of
 * forcing a re-create. Metadata only — token material never leaves the
 * `BotSecretStore`. Deleting is refused while the bot is installed (the
 * integration's Restrict FK backstops).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { type BotRecord, isSyntheticEmail } from '../../persistence/ports.js'
import { BotId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import {
  BotDto,
  BotListDto,
  SlackBotRefreshDto,
  UpdateBotBody,
  ErrorDto,
  IdParam,
  type BotDtoT,
  type SlackBotRefreshDtoT
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { resolveUserConfigAccessToken } from '../slack-user-config.js'
import { mergeManagedSlackManifest, slackOAuthRedirectUri, SLACK_BOT_SCOPES } from '../slack-manifest.js'
import { relayHttpBase } from './slack-install.js'

function toDto(b: BotRecord): BotDtoT {
  return {
    id: b.id,
    name: b.name,
    platform: b.platform,
    prebuilt: b.prebuilt,
    slackAppId: b.slackAppId,
    discordAppId: b.discordAppId,
    feishuAppId: b.feishuAppId,
    feishuRegion: b.feishuRegion,
    // Creator's userId (web resolves to a name / "You"); synthetic-email placeholder ⇒
    // non-human creator ⇒ null (the console shows the prebuilt/"—" fallback).
    createdBy: b.createdBy && !isSyntheticEmail(b.createdBy.email) ? b.createdBy.userId : null,
    shareable: b.shareable,
    transport: b.transport,
    inUseByAgentId: b.inUseByAgentId,
    agentIds: b.agentIds,
    lastUsedAt: b.lastUsedAt?.toISOString() ?? null,
    freedFromAgent: b.lastAgentName,
    teamId: b.teamId,
    revokedAt: b.revokedAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString()
  }
}

const MANUAL_MANIFEST_ERRORS = new Set([
  'app_not_eligible',
  'app_not_found',
  'app_not_owned_by_manager_app',
  'invalid_app_id',
  'no_permission'
])

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

export function botRoutes(deps: HttpDeps) {
  return async function botRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/bots',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'List bots',
          description:
            "The org's durable platform bot identities, including freed and prebuilt bots offered for reuse.",
          operationId: 'listBots',
          response: { 200: BotListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.bot.listForOrg(orgOf(req))
        return rows.map(toDto)
      }
    )

    r.get(
      '/bots/:id',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Get a bot',
          description: "Fetch a single bot identity by id (scoped to the caller's org; a cross-org id reads as 404).",
          operationId: 'getBot',
          params: IdParam,
          response: { 200: BotDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const bot = await deps.repos.bot.get(BotId(req.params.id))
        if (!bot || bot.orgId !== req.orgCtx!.orgId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        return toDto(bot)
      }
    )

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
        const bot = await deps.repos.bot.get(BotId(req.params.id))
        if (!bot || bot.orgId !== req.orgCtx!.orgId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        if (bot.platform !== 'slack') {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'only Slack apps can be refreshed' })
        }
        if (bot.prebuilt) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'prebuilt Slack apps are managed by AgentConnect' })
        }
        if (!bot.slackAppId) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'Slack app id is unavailable — update this app manually in Slack'
          })
        }
        const secret = await deps.repos.botSecret.get(bot.id)
        if (!secret) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'Slack app credentials are unavailable' })
        }

        // Verify identity before mutating the manifest. A manually registered
        // integration stores two independently pasted tokens; if the bot token
        // belongs to another app, updating the app encoded by the xapp token would
        // modify the wrong Slack app.
        const checked = await deps.verifySlackBot?.(secret.botToken)
        const appIdentityMatches = checked?.status === 'ok' && checked.appId === bot.slackAppId
        let manifest: SlackBotRefreshDtoT['manifest'] = 'manual_update_required'
        const api = deps.slackConfigApi
        // Manifest sync needs a config token that owns THIS app — i.e. the caller's
        // own (per-user). If they don't own it (or stored none), Slack rejects the
        // export/update and `manifest` stays `manual_update_required` — the graceful
        // fallback the DTO already surfaces via the Slack settings links.
        if (api && appIdentityMatches && req.principal) {
          const config = await resolveUserConfigAccessToken(deps, bot.orgId, req.principal.userId, new Date())
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
        if (checked?.status === 'invalid') {
          authorization = 'invalid'
        } else if (checked?.status === 'ok' && checked.appId && checked.appId !== bot.slackAppId) {
          authorization = 'app_mismatch'
        } else if (checked?.status === 'ok' && checked.scopes) {
          const granted = new Set(checked.scopes)
          missingScopes = SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope))
          authorization = missingScopes.length > 0 ? 'reinstall_required' : 'current'
        }

        return {
          manifest,
          authorization,
          missingScopes,
          ...slackAppLinks(bot.slackAppId, appIdentityMatches && checked?.status === 'ok' ? checked.teamId : null)
        }
      }
    )

    // Forget a bot (and, via cascade, its stored tokens). Refused while installed —
    // uninstall the integration first.
    r.delete(
      '/bots/:id',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Delete a bot',
          description:
            'Forget a bot and, via cascade, its stored tokens; refused while the bot is installed on an agent (uninstall the integration first).',
          operationId: 'deleteBot',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const bot = await deps.repos.bot.get(BotId(req.params.id))
        if (!bot || bot.orgId !== req.orgCtx!.orgId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        // Any active install blocks deletion (a shareable bot may have many; the FK
        // Restrict backstops). Uninstall every integration first.
        if (bot.agentIds.length > 0) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'bot is installed on an agent — uninstall first' })
        }
        await deps.repos.bot.delete(bot.id)
        return reply.code(204).send(null)
      }
    )

    // Flip the HTTP bot's multi-agent capacity (`Bot.shareable`,
    // shared-bot-relay.md §4.1). Transport is immutable: relay ingress remains in
    // place either way. Disabling is refused while >1 agent uses the bot.
    r.patch(
      '/bots/:id',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Update a bot',
          description: 'Allow or disallow this HTTP bot from serving multiple agents. Relay ingress is unchanged.',
          operationId: 'updateBot',
          params: IdParam,
          body: UpdateBotBody,
          response: { 200: BotDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        let bot = await deps.repos.bot.get(BotId(req.params.id))
        if (!bot || bot.orgId !== req.orgCtx!.orgId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        if (req.body.shareable === bot.shareable) return toDto(bot) // no-op
        const observedAgentIds = [...bot.agentIds].sort()
        const release = deps.agentMutations.tryBeginMutation(observedAgentIds)
        if (!release) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'an agent using this bot is moving; retry the bot change'
          })
        }
        try {
          const current = await deps.repos.bot.get(bot.id)
          if (
            !current ||
            current.shareable !== bot.shareable ||
            [...current.agentIds].sort().some((agentId, index) => agentId !== observedAgentIds[index]) ||
            current.agentIds.length !== observedAgentIds.length
          ) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'bot integrations changed; refresh and retry the bot change'
            })
          }
          bot = current
          // `shareable` is now the multi-agent sub-flag of an HTTP-mode bot (the
          // socket↔http transport axis is immutable post-create — the Slack app's
          // request_url is set once at app creation). A socket bot is always
          // single-agent, so it cannot be shared.
          if (bot.transport !== 'http') {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'only HTTP-mode Slack bots can be shared — recreate the bot in HTTP mode'
            })
          }
          // Disabling multi-agent is refused while >1 agent uses it (the others would
          // be left without a route).
          if (!req.body.shareable && bot.agentIds.length > 1) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'bot is shared by multiple agents — uninstall the others before disabling sharing'
            })
          }
          await deps.repos.bot.setShareable(bot.id, req.body.shareable)
          // Multi-agent capacity change only — recompile the relay pool's routes (no
          // ingest re-open; the transport, hence the ingest, is unchanged).
          await deps.httpBot.syncRoutes(bot.id)
          const updated = await deps.repos.bot.get(bot.id)
          return toDto(updated!)
        } finally {
          release()
        }
      }
    )
  }
}
