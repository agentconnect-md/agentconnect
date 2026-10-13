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
import { manifestFor } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { type BotRecord, isSyntheticEmail } from '../../persistence/ports.js'
import { BotStillShared } from '../../persistence/errors.js'
import { BotId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import { BotDto, BotListDto, UpdateBotBody, ErrorDto, IdParam, type BotDtoT } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { multiAgentUnsupportedMessage } from '../../platforms/sharing.js'
import { deleteBotIdentity } from '../uninstall.js'
import type { CpPlatformRegistry } from '../../platforms/provider.js'

export function toBotDto(b: BotRecord, platforms: Pick<CpPlatformRegistry, 'get'>): BotDtoT {
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
    releasedWhenFreed: platforms.get(b.platform)?.releasesFreedBot?.(b) === true,
    lastUsedAt: b.lastUsedAt?.toISOString() ?? null,
    freedFromAgent: b.lastAgentName,
    teamId: b.teamId,
    workspaceId: b.workspaceId,
    workspaceName: b.workspaceName,
    revokedAt: b.revokedAt?.toISOString() ?? null,
    revokedReason: b.revokedReason,
    revokedEvidence: b.revokedEvidence,
    revokedCode: b.revokedCode,
    credentialRejectedAt: b.credentialRejectedAt?.toISOString() ?? null,
    credentialRejectedCode: b.credentialRejectedCode,
    externalAppId: b.externalAppId,
    platformConfig: publicPlatformConfig(b.platformConfig),
    createdAt: b.createdAt.toISOString()
  }
}

/** The bag's string values; every one is public by contract (`BotIdentityColumns`), and a flag like Slack's stays on its own field. */
function publicPlatformConfig(bag: Record<string, unknown> | null): Record<string, string> | null {
  if (!bag) return null
  const entries = Object.entries(bag).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : null
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
            "The org's durable platform bot identities, including freed and built-in bots offered for reuse.",
          operationId: 'listBots',
          response: { 200: BotListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.bot.listForOrg(orgOf(req))
        return rows.map((row) => toBotDto(row, deps.platforms))
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
        // The read is org-fenced (org-scoped-data-layer.md §3): a cross-org id
        // reads as absent, so no route-level org comparison is needed.
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        return toBotDto(bot, deps.platforms)
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
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        // Any active install blocks deletion (a shareable bot may have many; the FK
        // Restrict backstops). Uninstall every integration first.
        if (bot.agentIds.length > 0) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'bot is installed on an agent — uninstall first' })
        }
        // The row + the platform-owned teardown the cascade cannot reach are the shared
        // skeleton (`http/uninstall.ts`), so this path and Linear's workspace disconnect
        // cannot drift on which side effects a deleted identity fires.
        await deleteBotIdentity(deps, req.log, orgOf(req), bot)
        return reply.code(204).send(null)
      }
    )

    // Flip an HTTP bot's multi-agent capacity (shared-bot-relay.md §4.1): enabling needs a `multiAgentShareable` platform and the http transport.
    r.patch(
      '/bots/:id',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Update a bot',
          description:
            'Allow or disallow this HTTP bot from serving multiple agents (allowing requires a platform that supports multi-agent bots; relay ingress is unchanged either way).',
          operationId: 'updateBot',
          params: IdParam,
          body: UpdateBotBody,
          response: { 200: BotDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        let bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        if (req.body.shareable === bot.shareable) return toBotDto(bot, deps.platforms) // no-op
        // Only enabling is refused on a platform without multi-agent bots, so a row flipped before this guard stays repairable.
        if (req.body.shareable && !manifestFor(bot.platform).multiAgentShareable) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: multiAgentUnsupportedMessage(bot.platform) })
        }
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
          const current = await deps.repos.bot.get(bot.orgId, bot.id)
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
          // be left without a route). This read is the fast optimistic check; the
          // authoritative recount happens INSIDE the update under the bot-row lock
          // (BotStillShared), where a concurrent membership admission cannot race it.
          if (!req.body.shareable && bot.agentIds.length > 1) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'bot is shared by multiple agents — uninstall the others before disabling sharing'
            })
          }
          try {
            await deps.repos.bot.update(bot.orgId, bot.id, { shareable: req.body.shareable })
          } catch (err) {
            if (err instanceof BotStillShared) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'bot is shared by multiple agents — uninstall the others before disabling sharing'
              })
            }
            throw err
          }
          // Multi-agent capacity change only — recompile the relay pool's routes (no
          // ingest re-open; the transport, hence the ingest, is unchanged).
          await deps.httpBot.syncRoutes(bot.id)
          const updated = await deps.repos.bot.get(bot.orgId, bot.id)
          return toBotDto(updated!, deps.platforms)
        } finally {
          release()
        }
      }
    )
  }
}
