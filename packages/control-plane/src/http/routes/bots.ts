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
import { botJoinsPublicChannels } from '../../platforms/slack/provider.js'
import { integrationToSpec, isGatedAgent } from '../../orchestrator/placement.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { deleteBotIdentity } from '../uninstall.js'

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
    joinPublicChannels: botJoinsPublicChannels(b),
    transport: b.transport,
    inUseByAgentId: b.inUseByAgentId,
    agentIds: b.agentIds,
    lastUsedAt: b.lastUsedAt?.toISOString() ?? null,
    freedFromAgent: b.lastAgentName,
    teamId: b.teamId,
    workspaceId: b.workspaceId,
    workspaceName: b.workspaceName,
    revokedAt: b.revokedAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString()
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
            "The org's durable platform bot identities, including freed and built-in bots offered for reuse.",
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
        // The read is org-fenced (org-scoped-data-layer.md §3): a cross-org id
        // reads as absent, so no route-level org comparison is needed.
        const bot = await deps.repos.bot.get(orgOf(req), BotId(req.params.id))
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        return toDto(bot)
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

    // Flip the HTTP bot's multi-agent capacity (`Bot.shareable`,
    // shared-bot-relay.md §4.1). Transport is immutable: relay ingress remains in
    // place either way. Enabling needs BOTH a platform whose manifest declares
    // `multiAgentShareable` (the same precondition the shareable install checks)
    // and the http transport; disabling is refused while >1 agent uses the bot.
    /**
     * Re-deliver every integration of `bot` with its re-projected config, after a bot-level
     * setting the daemon reads changed. An HTTP bot's send-only specs ride `syncBot` (the
     * relay assignment is re-broadcast too, harmlessly); a socket bot's integrations are
     * re-pushed to their owning daemons one by one, the way the channel PATCH does it.
     */
    const pushBotConfig = async (bot: BotRecord): Promise<void> => {
      if (bot.transport === 'http') {
        await deps.httpBot.syncBot(bot.id)
        return
      }
      const [secret, integrations] = await Promise.all([
        deps.repos.botSecret.get(bot.orgId, bot.id),
        deps.repos.integration.listForBot(bot.id)
      ])
      if (!secret) return
      for (const integration of integrations) {
        const [channels, owner] = await Promise.all([
          deps.repos.integrationChannel.listForIntegration(integration.id),
          deps.repos.agent.get(bot.orgId, integration.agentId)
        ])
        if (!owner) continue
        const spec = await integrationToSpec(deps.platforms, integration, bot, secret, channels, isGatedAgent(owner))
        if (!spec) continue
        await deps.agentDelivery.integrationUpsert(owner, spec, (err, target) => {
          if (!(err instanceof NoConnection)) throw err
          app.log.debug(
            { integrationId: integration.id, daemonId: target },
            'integration/upsert skipped: daemon offline'
          )
        })
      }
    }

    r.patch(
      '/bots/:id',
      {
        schema: {
          tags: [Tag.Bots],
          summary: 'Update a bot',
          description:
            'Allow or disallow this HTTP bot from serving multiple agents (allowing requires a platform that supports multi-agent bots; relay ingress is unchanged either way), and/or let the bot join public channels on demand where the platform supports it.',
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
        // The join switch is a plain per-bot setting: no membership to recount, so no
        // mutation lease. Gated on the manifest FIRST, like `shareable` below — a flag no
        // daemon reads must not sit on the row as a promise.
        if (req.body.joinPublicChannels !== undefined) {
          if (!manifestFor(bot.platform).publicChannelJoin) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: `${bot.platform} bots cannot join channels by themselves`
            })
          }
          if (req.body.joinPublicChannels !== botJoinsPublicChannels(bot)) {
            await deps.repos.bot.update(bot.orgId, bot.id, { joinPublicChannels: req.body.joinPublicChannels })
            bot = (await deps.repos.bot.get(bot.orgId, bot.id)) ?? bot
            await pushBotConfig(bot)
          }
          if (req.body.shareable === undefined) return toDto(bot)
        }
        if (req.body.shareable === undefined || req.body.shareable === bot.shareable) return toDto(bot) // no-op
        // Multi-agent bots are a per-PLATFORM capability, and this route used to
        // check only the transport — so any HTTP-transport bot on a platform the
        // install path refuses (`validateShareableInstall`) could be flipped
        // shareable here, leaving the flag on the row as a promise nothing
        // honors. Only the ENABLE direction is refused: an already-flipped row
        // from before this guard must stay repairable from the console.
        //
        // Checked before the mutation lease, unlike `shareable`/`agentIds`
        // below: `platform` is immutable, so a locked re-read could not tell us
        // anything the snapshot does not. 409 rather than the create route's
        // 400 for the same rule — there the platform is the CLIENT's assertion
        // in the request body, here it is the stored row's, exactly like the
        // transport refusal this sits beside.
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
          return toDto(updated!)
        } finally {
          release()
        }
      }
    )
  }
}
