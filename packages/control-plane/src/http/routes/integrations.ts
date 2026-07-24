/**
 * `http/routes/integrations.ts` (design docs/designs/slack-integration-install.md)
 * — install / list / remove platform integrations (Slack) through the C6
 * `IntegrationRepo` + `BotRepo` + the `BotSecretStore` token seam.
 *
 * The bot identity is durable: an install either REUSES an existing free bot
 * (`botId`) or REGISTERS a new one from pasted tokens (`slack`). Token material
 * is written ONCE via the store and never returned; the metadata DTOs carry no
 * tokens. On create the integration is pushed live to the owning agent's daemon
 * (`integration/upsert`, best-effort — the `register/ok` reconcile roster is the
 * backstop), so the daemon opens the Socket Mode socket. Uninstall deletes the
 * integration but keeps the bot (+ its tokens) — it shows up as "freed" in the
 * console picker for the next install.
 *
 * The owning agent MUST already be placed on a daemon (409 otherwise): the wire
 * delivery is daemon-scoped and there is no post-create placement hook to backfill.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import type { AgentRecord, IntegrationRecord, IntegrationChannelRecord } from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import { denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit } from '../visibility.js'
import { integrationToSpec } from '../../orchestrator/placement.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { installNewSlackBot, slackAppIdFromAppToken } from '../install-slack.js'
import { discordAppIdFromBotToken } from '../discord-identity.js'
import { integrationPlatformAvailability } from '../daemon-platform-capability.js'
import {
  CreateIntegrationBody,
  UpdateIntegrationChannelBody,
  IntegrationDto,
  IntegrationChannelDto,
  IntegrationListDto,
  ErrorDto,
  IdParam,
  type IntegrationDtoT,
  type IntegrationChannelDtoT
} from '../dto/index.js'

function toChannelDto(c: IntegrationChannelRecord): IntegrationChannelDtoT {
  return { channelId: c.channelId, name: c.name, isPrivate: c.isPrivate, trigger: c.trigger, agentId: c.agentId }
}

function toDto(i: IntegrationRecord, channels: IntegrationChannelRecord[] = []): IntegrationDtoT {
  return {
    id: i.id,
    name: i.name,
    platform: i.platform,
    agentId: i.agentId,
    botId: i.botId,
    status: i.status,
    ...(i.feishuRegion ? { region: i.feishuRegion } : {}),
    createdAt: i.createdAt.toISOString(),
    channels: channels.map(toChannelDto)
  }
}

export function integrationRoutes(deps: HttpDeps) {
  return async function integrationRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    // The caller's active org — every read/write below is scoped to it.
    const orgIdOf = (req: { orgCtx?: { orgId: OrgId } }) => req.orgCtx!.orgId
    const refreshMutationAgent = async (observed: AgentRecord): Promise<AgentRecord | null> => {
      const current = await deps.repos.agent.get(observed.id)
      if (
        !current ||
        current.daemonId !== observed.daemonId ||
        current.lastModifiedAt.getTime() !== observed.lastModifiedAt.getTime()
      ) {
        return null
      }
      return current
    }

    // Push the full spec (metadata + tokens + per-channel bindRules) to the owning
    // daemon. Best-effort: if the daemon is offline the reconcile roster carries it
    // on the next connect. Token-bearing — never log the spec.
    const replicateUpsert = async (i: IntegrationRecord, daemonId: string): Promise<void> => {
      const [secret, channels] = await Promise.all([
        deps.repos.botSecret.get(i.botId),
        deps.repos.integrationChannel.listForIntegration(i.id)
      ])
      if (!secret) return
      try {
        await deps.control.integrationUpsert(daemonId, integrationToSpec(i, secret, channels))
      } catch (err) {
        if (!(err instanceof NoConnection)) throw err
        app.log.debug({ integrationId: i.id, daemonId }, 'integration/upsert skipped: daemon offline')
      }
    }

    // Shared-install preconditions (shared-bot-relay.md §6): Slack-only for now, a
    // relay must be connected to host the ingest, and one agent installs a bot once.
    // Returns an error envelope to send, or null when the install may proceed.
    const validateSharedInstall = async (
      bot: { agentIds: string[] },
      agentId: string,
      platform: 'slack' | 'telegram' | 'discord' | 'feishu'
    ): Promise<{ code: 400 | 409; body: { error: string; statusCode: number; message: string } } | null> => {
      if (platform !== 'slack') {
        return {
          code: 400,
          body: { error: 'Bad Request', statusCode: 400, message: 'shared bots currently support Slack only' }
        }
      }
      if (!deps.sharedBot.hasConnectedRelay()) {
        return {
          code: 409,
          body: {
            error: 'Conflict',
            statusCode: 409,
            message: 'no relay is connected — shared bots need a relay to receive messages'
          }
        }
      }
      if (bot.agentIds.includes(agentId)) {
        return { code: 409, body: { error: 'Conflict', statusCode: 409, message: 'this agent already uses this bot' } }
      }
      return null
    }

    const replicateRemove = async (integrationId: string, daemonId: string | null): Promise<void> => {
      if (!daemonId) return
      try {
        await deps.control.integrationRemove(daemonId, { integrationId })
      } catch (err) {
        if (!(err instanceof NoConnection)) throw err
        app.log.debug({ integrationId, daemonId }, 'integration/remove skipped: daemon offline')
      }
    }

    r.post(
      '/integrations',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Add an integration',
          description:
            'Install a platform integration on a placed agent, reusing a free bot or registering a new one from pasted tokens, then push it live to the owning daemon.',
          operationId: 'createIntegration',
          body: CreateIntegrationBody,
          response: { 201: IntegrationDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgIdOf(req)
        let agent = await deps.repos.agent.get(AgentId(req.body.agentId))
        // Derived visibility: installing an integration edits the agent's setup, so
        // a restricted agent the caller can't see 404s, and one they can see but not
        // edit 403s.
        if (!agent || agent.orgId !== orgId || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // Delivery is daemon-scoped; refuse until the agent is placed (no backfill hook).
        if (!agent.daemonId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent must be placed on a daemon first' })
        }
        const platformAvailability = await integrationPlatformAvailability(deps, {
          daemonId: agent.daemonId,
          orgId,
          viewer: ctxOf(req),
          platform: req.body.platform
        })
        if (platformAvailability === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (platformAvailability === 'unsupported') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: `daemon does not support ${req.body.platform} integrations`
          })
        }

        // Reusing/promoting a classic bot can change the wire mode for agents
        // already using it, so their placement moves share this same boundary.
        const observedBot = req.body.botId === undefined ? null : await deps.repos.bot.get(BotId(req.body.botId))
        if (
          req.body.botId !== undefined &&
          (!observedBot || observedBot.orgId !== orgId || observedBot.platform !== req.body.platform)
        ) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        const observedBotAgentIds = [...(observedBot?.agentIds ?? [])].sort()
        const release = deps.agentMutations.tryBeginMutation([agent.id, ...observedBotAgentIds])
        if (!release) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'agent move is in progress; retry the integration change'
          })
        }
        try {
          const current = await refreshMutationAgent(agent)
          if (!current) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent placement changed; refresh and retry the integration change'
            })
          }
          agent = current
          const daemonId = current.daemonId
          if (!daemonId) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent is no longer placed; refresh and retry the integration change'
            })
          }

          // Reuse an existing bot: mint an integration for it. A SHAREABLE bot may
          // already serve other agents (this adds one more); a CLASSIC bot must be free.
          if (req.body.botId !== undefined) {
            const bot = await deps.repos.bot.get(BotId(req.body.botId))
            if (
              !bot ||
              !observedBot ||
              bot.orgId !== orgId ||
              bot.platform !== req.body.platform ||
              bot.shareable !== observedBot.shareable ||
              bot.agentIds.length !== observedBotAgentIds.length ||
              [...bot.agentIds].sort().some((agentId, index) => agentId !== observedBotAgentIds[index])
            ) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'bot integrations changed; refresh and retry the integration change'
              })
            }
            // Reuse keeps the bot's existing transport (immutable post-create). An
            // http bot routes via the relay pool; adding a 2nd agent makes it shared.
            const wantHttp = bot.transport === 'http'
            if (wantHttp) {
              const sharedErr = await validateSharedInstall(bot, agent.id, req.body.platform)
              if (sharedErr) return reply.code(sharedErr.code).send(sharedErr.body)
              if (!bot.shareable) await deps.repos.bot.setShareable(bot.id, true)
              const integration = await deps.repos.integration.create({
                id: IntegrationId(randomUUID()),
                orgId,
                agentId: agent.id,
                botId: bot.id,
                platform: req.body.platform,
                name: bot.name,
                // Carry the durable region forward so a reinstalled feishu/lark bot keeps
                // its gateway (undefined ⇒ 'feishu' for non-feishu bots).
                ...(bot.feishuRegion ? { feishuRegion: bot.feishuRegion } : {}),
                ...(req.principal ? { createdByUserId: req.principal.userId } : {})
              })
              // Relay owns the ingest — (re)assign the bot + push send-only specs to
              // every member daemon (including any that were direct before promotion).
              await deps.sharedBot.syncBot(bot.id)
              return reply.code(201).send(toDto(integration))
            }
            // Classic reuse: 1 bot : ≤1 install.
            if (bot.inUseByAgentId) {
              return reply
                .code(409)
                .send({ error: 'Conflict', statusCode: 409, message: 'bot is already installed on an agent' })
            }
            const integration = await deps.repos.integration.create({
              id: IntegrationId(randomUUID()),
              orgId,
              agentId: agent.id,
              botId: bot.id,
              platform: req.body.platform,
              name: bot.name,
              // Carry the durable region forward so a reinstalled feishu/lark bot keeps
              // its gateway (undefined ⇒ 'feishu' for non-feishu bots).
              ...(bot.feishuRegion ? { feishuRegion: bot.feishuRegion } : {}),
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
            await replicateUpsert(integration, daemonId)
            return reply.code(201).send(toDto(integration))
          }

          // Registering a NEW bot with http transport (relay ingest) is Slack-only for
          // now (Telegram/Discord relay ingest is milestone C) — reject early.
          if (req.body.transport === 'http' && req.body.platform !== 'slack') {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'HTTP-mode (relay ingress) bots currently support Slack only'
            })
          }

          // Telegram: a single BotFather token — no app-level token and no OAuth /
          // verification funnel. Register the bot + secret + integration inline and push
          // it live. Name: operator-typed → getMe-derived (best-effort) → owning agent.
          if (req.body.platform === 'telegram') {
            const tg = req.body.telegram! // superRefine guarantees it when botId is absent
            const provided = req.body.name?.trim()
            const derived =
              !provided && deps.resolveTelegramBotName ? await deps.resolveTelegramBotName(tg.botToken) : null
            const name = provided || derived || agent.name
            const botId = BotId(randomUUID())
            await deps.repos.bot.create({
              id: botId,
              orgId,
              platform: 'telegram',
              name,
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
            await deps.repos.botSecret.put(botId, { botToken: tg.botToken, appToken: null, signingSecret: null })
            const integration = await deps.repos.integration.create({
              id: IntegrationId(randomUUID()),
              orgId,
              agentId: agent.id,
              botId,
              platform: 'telegram',
              name,
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
            await replicateUpsert(integration, daemonId)
            return reply.code(201).send(toDto(integration))
          }

          // Discord: a single Gateway bot token — no app-level token and no OAuth /
          // verification funnel. Validate it against Discord BEFORE storing, so a stale /
          // wrong / reset token fails here (400) instead of silently producing an
          // integration whose Gateway login never succeeds (its only symptom a daemon-log
          // error nobody sees). `GET /users/@me` also hands back the bot name, so we don't
          // re-fetch just to name the bot. Best-effort about reachability: a network blip is
          // inconclusive (`unreachable`), NOT proof the token is bad — only a 401 blocks it.
          if (req.body.platform === 'discord') {
            const discord = req.body.discord! // superRefine guarantees it when botId is absent
            const check = deps.verifyDiscordBot ? await deps.verifyDiscordBot(discord.botToken) : null
            if (check?.status === 'invalid') {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                message:
                  'Discord rejected the bot token — check you pasted the Bot token from the Developer Portal (Bot → Reset Token).'
              })
            }
            // Name: operator-typed → users/@me-derived (best-effort) → owning agent. The
            // daemon needs only the bot token to open the Gateway, but we ALSO decode the
            // application (client) id from the token and persist it — public metadata, not
            // secret — so the console can later hand out a ready-made "Add to Discord"
            // invite URL from Settings without re-parsing the (never-returned) token.
            const provided = req.body.name?.trim()
            const derived = check?.status === 'ok' ? check.name : null
            const name = provided || derived || agent.name
            const discordAppId = discordAppIdFromBotToken(discord.botToken)
            const botId = BotId(randomUUID())
            await deps.repos.bot.create({
              id: botId,
              orgId,
              platform: 'discord',
              name,
              ...(discordAppId ? { discordAppId } : {}),
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
            await deps.repos.botSecret.put(botId, { botToken: discord.botToken, appToken: null, signingSecret: null })
            const integration = await deps.repos.integration.create({
              id: IntegrationId(randomUUID()),
              orgId,
              agentId: agent.id,
              botId,
              platform: 'discord',
              name,
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
            await replicateUpsert(integration, daemonId)
            return reply.code(201).send(toDto(integration))
          }

          // Feishu / Lark: an appId + appSecret pair — no app-level token and no OAuth /
          // verification funnel. Validate them against Feishu BEFORE storing (the
          // tenant-access-token exchange validates both at once), so a stale / wrong app id
          // or secret fails here (400) instead of silently producing an integration whose
          // WSClient login never succeeds. That exchange also lets us derive the bot name
          // (bot/v3/info) when the install omits one. Best-effort about reachability: only a
          // definitive credential rejection blocks — a network blip is `unreachable`. The
          // two credentials reuse the two-slot bot_secret (botToken = appSecret, the secret;
          // appToken = appId, the identifier — appToken already nullable since Telegram).
          if (req.body.platform === 'feishu') {
            const feishu = req.body.feishu! // superRefine guarantees it when botId is absent
            const region = feishu.region // zod-defaulted to 'feishu' when omitted
            const check = deps.verifyFeishuBot
              ? await deps.verifyFeishuBot(feishu.appId, feishu.appSecret, region)
              : null
            if (check?.status === 'invalid') {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                message:
                  'Feishu rejected the credentials — check the App ID (cli_…) and App Secret from the Developer Console (Credentials & Basic Info).'
              })
            }
            const provided = req.body.name?.trim()
            const derived = check?.status === 'ok' ? check.name : null
            const name = provided || derived || agent.name
            const botId = BotId(randomUUID())
            await deps.repos.bot.create({
              id: botId,
              orgId,
              platform: 'feishu',
              name,
              // Durable home for the region so a later reinstall of this freed bot
              // reconstructs the right gateway (the integration row is deleted on uninstall).
              feishuRegion: region,
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
            // botToken = appSecret (secret), appToken = appId (identifier).
            await deps.repos.botSecret.put(botId, {
              botToken: feishu.appSecret,
              appToken: feishu.appId,
              signingSecret: null
            })
            const integration = await deps.repos.integration.create({
              id: IntegrationId(randomUUID()),
              orgId,
              agentId: agent.id,
              botId,
              platform: 'feishu',
              name,
              feishuRegion: region,
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
            await replicateUpsert(integration, daemonId)
            return reply.code(201).send(toDto(integration))
          }

          // Register a new Slack bot from pasted tokens. Validate against Slack BEFORE
          // we store them, so a stale / wrong-app / swapped token fails here (400)
          // instead of silently producing an integration whose socket never opens.
          // Best-effort about reachability: a network blip is inconclusive
          // (`unreachable`), NOT proof the token is bad — only a definitive rejection
          // blocks the install.
          const slack = req.body.slack! // refine() guarantees it when botId is absent
          const transport = req.body.transport ?? 'socket'
          const botCheck = await deps.verifySlackBot?.(slack.botToken)
          if (botCheck?.status === 'invalid') {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'Slack rejected the bot token — check you pasted the Bot User OAuth Token (xoxb-…).'
            })
          }
          if (transport === 'socket') {
            // Socket Mode: the app-level xapp token is required + validated against Slack.
            const appCheck = await deps.verifySlackAppToken?.(slack.appToken!)
            if (appCheck === 'invalid') {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                message:
                  'Slack rejected the app-level token — check you pasted the App-Level Token (xapp-…) and gave it the connections:write scope.'
              })
            }
            const appTokenAppId = slackAppIdFromAppToken(slack.appToken!)
            if (botCheck?.status === 'ok' && botCheck.appId && appTokenAppId && botCheck.appId !== appTokenAppId) {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                message: 'The Slack bot token and app-level token belong to different apps.'
              })
            }
          } else {
            // HTTP mode: inbound arrives at the relay pool — a relay must be connected.
            if (!deps.sharedBot.hasConnectedRelay()) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'no relay is connected — HTTP-mode bots need a relay to receive messages'
              })
            }
          }
          // Name is optional: the app already has one. Prefer what the operator typed,
          // else the name auth.test derived, else fall back to the owning agent's name.
          const provided = req.body.name?.trim()
          const derived = botCheck?.status === 'ok' ? botCheck.name : null
          const integration = await installNewSlackBot(deps, app.log, {
            orgId,
            agent,
            name: provided || derived || agent.name,
            botToken: slack.botToken,
            transport,
            ...(botCheck?.status === 'ok' && botCheck.appId ? { slackAppId: botCheck.appId } : {}),
            ...(slack.appToken ? { appToken: slack.appToken } : {}),
            ...(slack.signingSecret ? { signingSecret: slack.signingSecret } : {}),
            ...(req.body.shareable === true ? { shareable: true } : {}),
            ...(req.principal ? { createdByUserId: req.principal.userId } : {})
          })
          return reply.code(201).send(toDto(integration))
        } finally {
          release()
        }
      }
    )

    r.get(
      '/integrations',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'List integrations',
          description: 'Every platform integration in the active organization, each with its per-channel bindings.',
          operationId: 'listIntegrations',
          response: { 200: IntegrationListDto }
        }
      },
      async (req) => {
        // Derived visibility: only integrations whose parent agent the caller can
        // see (owner ⇒ all). A restricted agent's integration never leaks here.
        const rows = await deps.repos.integration.listForOrg(orgIdOf(req), ctxOf(req))
        return Promise.all(
          rows.map(async (i) => toDto(i, await deps.repos.integrationChannel.listForIntegration(i.id)))
        )
      }
    )

    // Per-channel trigger choice (@-mention vs any message). Persist, then push the
    // integration's recomputed bindRules to the owning daemon (integration/upsert,
    // best-effort — the reconcile roster converges an offline daemon later).
    r.patch(
      '/integrations/:id/channels/:channelId',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Update a channel',
          description:
            "Set a channel's trigger (@-mention vs any message), then push the integration's recomputed bindRules to the owning daemon.",
          operationId: 'updateIntegrationChannel',
          params: IdParam.extend({ channelId: z.string().min(1) }),
          body: UpdateIntegrationChannelBody,
          response: { 200: IntegrationChannelDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const integration = await deps.repos.integration.get(IntegrationId(req.params.id))
        if (!integration || integration.orgId !== orgIdOf(req)) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        }
        // Derived visibility: gate on the parent agent — a restricted agent the
        // caller can't see 404s (hiding the integration too), one they can see but
        // not edit 403s.
        let agent = await deps.repos.agent.get(integration.agentId)
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        const observedOwner = req.body.agentId ? await deps.repos.agent.get(AgentId(req.body.agentId)) : null
        const release = deps.agentMutations.tryBeginMutation([
          agent.id,
          ...(req.body.agentId ? [req.body.agentId] : [])
        ])
        if (!release) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'agent move is in progress; retry the integration change'
          })
        }
        try {
          const current = await refreshMutationAgent(agent)
          if (!current) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent placement changed; refresh and retry the integration change'
            })
          }
          agent = current
          if (observedOwner && !(await refreshMutationAgent(observedOwner))) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'default agent placement changed; refresh and retry the integration change'
            })
          }
          // Apply whichever of {trigger, agentId} the body carries (DTO refine
          // guarantees ≥1). `agentId:null` clears the per-channel owner.
          let updated: IntegrationChannelRecord | null = null
          if (req.body.trigger !== undefined) {
            updated = await deps.repos.integrationChannel.setTrigger(
              integration.id,
              req.params.channelId,
              req.body.trigger
            )
            if (!updated)
              return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'channel not found' })
          }
          if (req.body.agentId !== undefined) {
            // A named owner must be a placed agent that actually shares this bot.
            if (req.body.agentId !== null) {
              const bot = await deps.repos.bot.get(integration.botId)
              if (!bot || !bot.agentIds.includes(AgentId(req.body.agentId))) {
                return reply.code(409).send({
                  error: 'Conflict',
                  statusCode: 409,
                  message: 'default agent must be an agent that uses this bot'
                })
              }
            }
            updated = await deps.repos.integrationChannel.setAgent(
              integration.id,
              req.params.channelId,
              req.body.agentId === null ? null : AgentId(req.body.agentId)
            )
            if (!updated)
              return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'channel not found' })
          }
          // Push the change: a shared bot's routes hot-update on the relay; a classic
          // bot re-pushes its recomputed bindRules to the owning daemon.
          const bot = await deps.repos.bot.get(integration.botId)
          if (bot?.transport === 'http') await deps.sharedBot.syncRoutes(bot.id)
          else if (agent.daemonId) await replicateUpsert(integration, agent.daemonId)
          return toChannelDto(updated!)
        } finally {
          release()
        }
      }
    )

    // Remove the integration (metadata only — the bot and its tokens SURVIVE, freed
    // for the next install), then tell the owning daemon to drop it
    // (`integration/remove`, best-effort).
    r.delete(
      '/integrations/:id',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Remove an integration',
          description:
            'Delete the integration metadata (the bot and its tokens survive, freed for the next install), then tell the owning daemon to drop it.',
          operationId: 'deleteIntegration',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.integration.get(IntegrationId(req.params.id))
        if (!existing || existing.orgId !== orgIdOf(req)) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        }
        // Derived visibility: gate on the parent agent (a restricted agent the caller
        // can't see 404s; can-see-but-not-edit 403s) before removing its integration.
        let agent = await deps.repos.agent.get(existing.agentId)
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        const release = deps.agentMutations.tryBeginMutation(agent.id)
        if (!release) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'agent move is in progress; retry the integration change'
          })
        }
        try {
          const current = await refreshMutationAgent(agent)
          if (!current) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent placement changed; refresh and retry the integration change'
            })
          }
          agent = current
          const botBefore = await deps.repos.bot.get(existing.botId)
          await deps.repos.integration.delete(existing.id)
          // "Freed" now means NO active integration remains (a shared bot may still
          // serve other agents — don't stamp it freed while it does, §6).
          const remaining = await deps.repos.integration.listForBot(existing.botId)
          if (remaining.length === 0) {
            await deps.repos.bot.markFreed(existing.botId, new Date(), agent.name ?? null)
          }
          // Tell the removed agent's daemon to drop the spec either way.
          await replicateRemove(existing.id, agent.daemonId ?? null)
          // Shared bot: recompute the relay's routes + members (or release it if this
          // was the last install).
          if (botBefore?.transport === 'http') await deps.sharedBot.syncBot(existing.botId)
          return reply.code(204).send(null)
        } finally {
          release()
        }
      }
    )
  }
}
