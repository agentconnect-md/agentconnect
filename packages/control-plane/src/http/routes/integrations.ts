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
import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import type { AgentRecord, BotRecord, IntegrationRecord, IntegrationChannelRecord } from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import { denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { integrationToSpec, isGatedAgent } from '../../orchestrator/placement.js'
import { pickChannelOwner } from '../../orchestrator/httpBot.js'
import { isDirectConversationKind } from '../../persistence/ports.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { installNewSlackBot, slackAppIdFromAppToken } from '../install-slack.js'
import { installNewFeishuBot } from '../install-feishu.js'
import { discordAppIdFromBotToken } from '../discord-identity.js'
import { integrationPlatformAvailability } from '../daemon-platform-capability.js'
import {
  CreateIntegrationBody,
  TelegramBotCheckBody,
  TelegramBotCheckDto,
  UpdateIntegrationChannelBody,
  LeaveIntegrationConversationBody,
  IntegrationDto,
  IntegrationChannelDto,
  IntegrationListDto,
  ErrorDto,
  IdParam,
  type IntegrationDtoT,
  type IntegrationChannelDtoT
} from '../dto/index.js'

function toChannelDto(c: IntegrationChannelRecord): IntegrationChannelDtoT {
  return {
    channelId: c.channelId,
    name: c.name,
    spaceId: c.spaceId,
    space: c.space,
    isPrivate: c.isPrivate,
    kind: c.kind,
    trigger: c.trigger,
    agentId: c.agentId
  }
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
      const [secret, channels, owner] = await Promise.all([
        deps.repos.botSecret.get(i.botId),
        deps.repos.integrationChannel.listForIntegration(i.id),
        deps.repos.agent.get(i.agentId)
      ])
      if (!secret) return
      try {
        await deps.control.integrationUpsert(
          daemonId,
          integrationToSpec(i, secret, channels, owner ? isGatedAgent(owner) : false)
        )
      } catch (err) {
        if (!(err instanceof NoConnection)) throw err
        app.log.debug({ integrationId: i.id, daemonId }, 'integration/upsert skipped: daemon offline')
      }
    }

    // Shareable-install preconditions (shared-bot-relay.md §6): Slack-only for now, a
    // relay must be connected to host the ingest, and one agent installs a bot once.
    // Returns an error envelope to send, or null when the install may proceed.
    const validateShareableInstall = async (
      bot: { agentIds: string[] },
      agentId: string,
      platform: 'slack' | 'telegram' | 'discord' | 'feishu'
    ): Promise<{ code: 400 | 409; body: { error: string; statusCode: number; message: string } } | null> => {
      if (platform !== 'slack') {
        return {
          code: 400,
          body: { error: 'Bad Request', statusCode: 400, message: 'multi-agent bots currently support Slack only' }
        }
      }
      if (!deps.httpBot.hasConnectedRelay()) {
        return {
          code: 409,
          body: {
            error: 'Conflict',
            statusCode: 409,
            message: 'HTTP callback delivery is unavailable on this deployment'
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
      '/integrations/telegram/check',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Check a Telegram bot',
          description:
            'Validate a pasted Telegram bot token and report whether Group Privacy Mode is disabled, without storing the token.',
          operationId: 'checkTelegramBot',
          body: TelegramBotCheckBody,
          response: { 200: TelegramBotCheckDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const checked = await deps.verifyTelegramBot(req.body.botToken)
        return {
          status:
            checked.status === 'ok'
              ? checked.privacyModeDisabled
                ? ('ready' as const)
                : ('privacy_enabled' as const)
              : checked.status
        }
      }
    )

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
          response: { 201: IntegrationDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
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
          const profileAgent = { id: current.id, icon: current.icon, runtime: current.runtime }

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
            // A dead credential is not reusable. `inUseByAgentId` goes null when the
            // last install is removed, so a REVOKED bot (workspace uninstalled the
            // app / killed its tokens) looks "free" to the picker — reusing it would
            // mint an integration on a token Slack already rejects.
            if (bot.revokedAt) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'this bot’s Slack app was uninstalled or its tokens were revoked; reinstall it instead'
              })
            }
            // A platform-app install starts NON-shareable (preset-agents.md §5.5)
            // — one workspace ⇒ one agent. Its `teamId` is the marker: only the
            // distributed app persists one. Widening it must be a deliberate
            // opt-in (the Settings → Bots sharing toggle), never the silent
            // `setShareable(true)` promotion the http branch below applies to
            // classic bots; once shared it reuses like any shared bot.
            if (bot.teamId && !bot.shareable) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message:
                  'the AgentConnect Slack app serves one agent per workspace — enable sharing on its bot (Settings → Bots) or create a dedicated Slack app for this agent'
              })
            }
            // Reuse keeps the bot's existing transport (immutable post-create). An
            // HTTP bot routes via the relay pool; only Slack may add a second agent.
            const wantHttp = bot.transport === 'http'
            if (wantHttp) {
              if (bot.agentIds.length > 0) {
                const shareableErr = await validateShareableInstall(bot, agent.id, req.body.platform)
                if (shareableErr) return reply.code(shareableErr.code).send(shareableErr.body)
                if (!bot.shareable) await deps.repos.bot.setShareable(bot.id, true)
              } else if (!deps.httpBot.hasConnectedRelay()) {
                return reply.code(409).send({
                  error: 'Conflict',
                  statusCode: 409,
                  message: 'HTTP callback delivery is unavailable on this deployment'
                })
              }
              // Membership admission is ATOMIC with the bot row — the same
              // primitive as the platform callback. The checks above are the
              // optimistic UX layer; only under the lock are `shareable` and the
              // membership set authoritative, so a concurrent sharing disable or
              // a duplicate reuse serializes there instead of racing this
              // handler's snapshots ('exists' = the winner's row, idempotent 201).
              const admission = await deps.repos.integration.addBotMembership({
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
              if (admission.outcome === 'revoked') {
                // A workspace revoke won the row lock and flipped every install —
                // zero-active must not read as "free" (the optimistic revokedAt
                // check above saw the pre-revoke snapshot).
                return reply.code(409).send({
                  error: 'Conflict',
                  statusCode: 409,
                  message: 'this bot’s Slack app was uninstalled or its tokens were revoked; reinstall it instead'
                })
              }
              if (admission.outcome === 'not_shareable') {
                return reply.code(409).send({
                  error: 'Conflict',
                  statusCode: 409,
                  message: 'bot sharing was just disabled; refresh and retry the integration change'
                })
              }
              // Relay owns the ingest — (re)assign the bot + push send-only specs to
              // every member daemon (including any that were direct before promotion).
              await deps.httpBot.syncBot(bot.id)
              return reply.code(201).send(toDto(admission.integration))
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

          // HTTP callback ingress is implemented for Slack and Feishu. Telegram and
          // Discord keep their daemon-owned long-lived transports.
          if (req.body.transport === 'http' && req.body.platform !== 'slack' && req.body.platform !== 'feishu') {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'HTTP callback delivery currently supports Slack and Feishu only'
            })
          }

          // Telegram: `getMe` validates the single BotFather token and confirms
          // Group Privacy Mode is disabled before anything is stored. Telegram exposes
          // that setting as read-only; the owner still changes it in @BotFather.
          if (req.body.platform === 'telegram') {
            const tg = req.body.telegram! // superRefine guarantees it when botId is absent
            const checked = await deps.verifyTelegramBot(tg.botToken)
            if (checked.status === 'invalid') {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                code: 'TELEGRAM_BOT_TOKEN_INVALID',
                message: 'Telegram rejected the bot token — copy it again from @BotFather.'
              })
            }
            if (checked.status === 'unreachable') {
              return reply.code(503).send({
                error: 'Service Unavailable',
                statusCode: 503,
                code: 'TELEGRAM_BOT_CHECK_UNAVAILABLE',
                message: 'AgentConnect could not reach Telegram to check this bot. Try again in a moment.'
              })
            }
            if (!checked.privacyModeDisabled) {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                code: 'TELEGRAM_PRIVACY_MODE_ENABLED',
                message:
                  'Privacy Mode is still on. In @BotFather, send /setprivacy, select this bot, choose Disable, then try again.'
              })
            }
            const provided = req.body.name?.trim()
            const name = provided || checked.name || agent.name
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
            if (deps.syncTelegramBotIcon) {
              try {
                await deps.syncTelegramBotIcon(tg.botToken, profileAgent)
              } catch (err) {
                app.log.warn({ err, agentId: agent.id, botId }, 'telegram icon sync failed; integration remains active')
              }
            }
            return reply.code(201).send(toDto(integration))
          }

          // Discord: validate the single Gateway bot token, then ensure its application
          // has Message Content enabled BEFORE storing anything. The flag update is
          // idempotent; a bot that already has limited or approved access is untouched.
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
            const intentSetup = await deps.ensureDiscordMessageContentIntent(discord.botToken)
            if (intentSetup === 'rejected') {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                code: 'DISCORD_MESSAGE_CONTENT_INTENT_SETUP_FAILED',
                message:
                  'AgentConnect could not enable Message Content Intent automatically. Open the Discord Developer Portal → Bot → Privileged Gateway Intents, turn on Message Content Intent, save, then try again.'
              })
            }
            if (intentSetup === 'unreachable') {
              return reply.code(503).send({
                error: 'Service Unavailable',
                statusCode: 503,
                code: 'DISCORD_MESSAGE_CONTENT_INTENT_CHECK_UNAVAILABLE',
                message:
                  'AgentConnect could not reach Discord to check or enable Message Content Intent. Try installing again in a moment.'
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
            if (deps.syncDiscordBotProfile && check?.status !== 'unreachable') {
              try {
                await deps.syncDiscordBotProfile(discord.botToken, profileAgent)
              } catch (err) {
                app.log.warn(
                  { err, agentId: agent.id, botId },
                  'discord profile sync failed; integration remains active'
                )
              }
            }
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
            const region = feishu.region // zod-defaulted to 'lark' for new installs
            const transport = req.body.transport ?? 'socket'
            if (transport === 'http' && !deps.httpBot.hasConnectedRelay()) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'HTTP callback delivery is unavailable on this deployment'
              })
            }
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
            // HTTP ingress cannot call Feishu with the app secret, so the CP must
            // resolve the bot's own open_id now. The relay uses it to distinguish
            // @bot from mentions of ordinary users in group messages.
            if (transport === 'http' && (check?.status !== 'ok' || !check.openId)) {
              return reply.code(503).send({
                error: 'Service Unavailable',
                statusCode: 503,
                message:
                  'Could not resolve this app’s bot identity. Enable the bot capability in Feishu, then try again.'
              })
            }
            const provided = req.body.name?.trim()
            const derived = check?.status === 'ok' ? check.name : null
            const name = provided || derived || agent.name
            const integration = await installNewFeishuBot(deps, app.log, {
              orgId,
              agent,
              name,
              appId: feishu.appId,
              appSecret: feishu.appSecret,
              region,
              transport,
              ...(check?.status === 'ok' && check.openId ? { botUserId: check.openId } : {}),
              ...(feishu.verificationToken ? { verificationToken: feishu.verificationToken } : {}),
              ...(feishu.encryptKey ? { encryptKey: feishu.encryptKey } : {}),
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
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
            if (!deps.httpBot.hasConnectedRelay()) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'HTTP callback delivery is unavailable on this deployment'
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
            ...(botCheck?.status === 'ok' && botCheck.teamId ? { workspaceId: botCheck.teamId } : {}),
            ...(botCheck?.status === 'ok' && botCheck.teamName ? { workspaceName: botCheck.teamName } : {}),
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
        // see. A restricted agent's integration never leaks here, regardless of role.
        const rows = await deps.repos.integration.listForOrg(orgIdOf(req), ctxOf(req))
        const hydrated = await Promise.all(
          rows.map(async (integration) => ({
            integration,
            channels: await deps.repos.integrationChannel.listForIntegration(integration.id)
          }))
        )
        // Membership is repeated per shareable-bot integration, while only the
        // canonical owner row persists agentId. Read effective state from every
        // active install of each visible bot — not only viewer-visible integrations
        // — so a sibling never disagrees with the relay's route table.
        const effective = new Map<string, IntegrationChannelRecord>()
        const bots = new Map((await deps.repos.bot.listForOrg(orgIdOf(req))).map((bot) => [bot.id, bot]))
        const botStates = await Promise.all(
          [...new Set(hydrated.map(({ integration }) => integration.botId))].map(async (botId) => {
            const bot = bots.get(botId)
            if (bot?.transport !== 'http') return null
            const [installs, channels] = await Promise.all([
              deps.repos.integration.listForBot(botId),
              deps.repos.integrationChannel.listForBot(botId)
            ])
            return { botId, installs, channels: channels.filter((channel) => channel.kind === 'channel') }
          })
        )
        for (const state of botStates) {
          if (!state) continue
          const byChannel = new Map<string, IntegrationChannelRecord[]>()
          for (const channel of state.channels) {
            const channels = byChannel.get(channel.channelId) ?? []
            channels.push(channel)
            byChannel.set(channel.channelId, channels)
          }
          for (const [channelId, channels] of byChannel) {
            const owner = pickChannelOwner(state.installs, channels)
            if (!owner) continue
            const channel =
              channels.find((row) => row.agentId === owner.agentId) ??
              channels.find((row) => row.integrationId === owner.id) ??
              channels[0]
            if (channel) {
              const persistedOwner = channels.some((row) => row.agentId === owner.agentId)
              const ownerAgent = persistedOwner ? null : await deps.repos.agent.get(owner.agentId)
              effective.set(`${state.botId}\u0000${channelId}`, {
                ...channel,
                agentId: owner.agentId,
                ...(ownerAgent && isGatedAgent(ownerAgent) ? { trigger: 'off' as const } : {})
              })
            }
          }
        }
        return hydrated.map(({ integration, channels }) =>
          toDto(
            integration,
            channels.map((channel) => {
              if (channel.kind !== 'channel') return channel
              const state = effective.get(`${integration.botId}\u0000${channel.channelId}`)
              return state ? { ...channel, agentId: state.agentId, trigger: state.trigger } : channel
            })
          )
        )
      }
    )

    /**
     * Shared admission for the per-channel routes: the integration must be in this
     * org, its owning agent visible AND editable, and the row must exist. Replies on
     * the failure paths and returns null, so a caller that gets a value is cleared.
     *
     * Derived visibility: a restricted agent the caller cannot see 404s (hiding the
     * integration too); one they can see but not edit 403s. `channelId` is optional
     * so a space-scoped action can share the same gate.
     */
    const admitChannelAction = async (
      req: { params: { id: string; channelId?: string } },
      reply: FastifyReply
    ): Promise<{ integration: IntegrationRecord; agent: AgentRecord; bot: BotRecord } | null> => {
      const integration = await deps.repos.integration.get(IntegrationId(req.params.id))
      if (!integration || integration.orgId !== orgIdOf(req as never)) {
        reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        return null
      }
      const agent = await deps.repos.agent.get(integration.agentId)
      if (!agent || !canView(agent, ctxOf(req as never))) {
        reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        return null
      }
      if (!canEdit(agent, ctxOf(req as never))) {
        reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        return null
      }
      const bot = await deps.repos.bot.get(integration.botId)
      if (!bot) {
        reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        return null
      }
      return { integration, agent, bot }
    }

    /** Re-derive routing after a channel row appears or disappears: an HTTP bot's
     *  table lives on the relay, a classic bot's bindRules on its daemon. */
    const republishChannels = async (
      integration: IntegrationRecord,
      bot: BotRecord,
      agent: AgentRecord
    ): Promise<void> => {
      if (bot.transport === 'http') await deps.httpBot.syncRoutes(bot.id)
      else if (agent.daemonId) await replicateUpsert(integration, agent.daemonId)
    }

    /**
     * Tell the owning daemon to stop reporting these conversations.
     *
     * Deleting the row is not enough on its own. A platform that cannot enumerate has
     * its observed set rebuilt from SESSION HISTORY, which knows nothing about a row
     * being removed — so without this the daemon's next refresh pushes the
     * conversation straight back and the removal silently undoes itself.
     *
     * Best-effort: an offline daemon re-reports the conversation, which is the
     * pre-existing annoyance rather than a new failure, and the operator can act again.
     */
    const pushForget = async (
      integration: IntegrationRecord,
      agent: AgentRecord,
      channels: string[]
    ): Promise<{ ok: true } | { ok: false; body: { error: string; statusCode: number; message: string } }> => {
      if (channels.length === 0) return { ok: true }
      const undeliverable = {
        ok: false as const,
        body: {
          error: 'Bad Gateway',
          statusCode: 502,
          message: 'the daemon is offline, so this conversation would be listed again — retry once it reconnects'
        }
      }
      if (!agent.daemonId) return undeliverable
      try {
        const ack = await deps.control.integrationForget(agent.daemonId, { integrationId: integration.id, channels })
        if (ack.ok) return { ok: true }
        return {
          ok: false,
          body: { error: 'Bad Gateway', statusCode: 502, message: ack.reason ?? 'the daemon refused' }
        }
      } catch (err) {
        if (err instanceof NoConnection) return undeliverable
        throw err
      }
    }

    /**
     * A shared bot's channel is bot-scoped: one owner, and a trigger replicated across
     * every install. Ending its listing therefore reaches agents beyond the one whose
     * page this is, so it takes the SAME authorization the trigger/owner PATCH takes —
     * edit rights on the effective owner — instead of only on this integration's agent.
     * Returns an error envelope to send, or null when the action may proceed.
     */
    const resolveBotScopedChannel = async (
      req: { params: { id: string; channelId?: string } },
      integration: IntegrationRecord,
      bot: BotRecord,
      channelId: string
    ): Promise<
      | { ok: true; botScoped: boolean; ownerAgentId?: string }
      | { ok: false; code: 403 | 409; body: { error: string; statusCode: number; message: string } }
    > => {
      const rows = await deps.repos.integrationChannel.listForIntegration(integration.id)
      const row = rows.find((candidate) => candidate.channelId === channelId)
      // A DIRECT row is per-agent even on a shared bot (§14.3: each gated install gets
      // its own DM row), so it is never fanned out and needs no owner check — sharing
      // one would let an editor of one agent silently drop another agent's DM.
      if (bot.transport !== 'http' || (row && isDirectConversationKind(row.kind))) {
        return { ok: true, botScoped: false }
      }
      const [installs, channelRows] = await Promise.all([
        deps.repos.integration.listForBot(bot.id),
        deps.repos.integrationChannel.listForBot(bot.id)
      ])
      const owner = pickChannelOwner(
        installs,
        channelRows.filter((candidate) => candidate.kind === 'channel' && candidate.channelId === channelId)
      )
      const ownerAgent = owner ? await deps.repos.agent.get(owner.agentId) : null
      if (!ownerAgent) {
        return {
          ok: false,
          code: 409,
          body: { error: 'Conflict', statusCode: 409, message: 'channel owner changed; refresh and retry' }
        }
      }
      if (!canEdit(ownerAgent, ctxOf(req as never))) {
        return {
          ok: false,
          code: 403,
          body: { error: 'Forbidden', statusCode: 403, message: 'cannot edit this channel’s owning agent' }
        }
      }
      return { ok: true, botScoped: true, ownerAgentId: ownerAgent.id }
    }

    // Per-channel trigger choice (@-mention vs any message). Persist, then push the
    // integration's recomputed bindRules to the owning daemon (integration/upsert,
    // best-effort — the reconcile roster converges an offline daemon later).
    r.patch(
      '/integrations/:id/channels/:channelId',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Update a channel',
          description: "Set a channel's trigger or default agent, then push the updated routing configuration.",
          operationId: 'updateIntegrationChannel',
          params: IdParam.extend({ channelId: z.string().min(1) }),
          body: UpdateIntegrationChannelBody,
          response: { 200: IntegrationChannelDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
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
        const existingChannel = (await deps.repos.integrationChannel.listForIntegration(integration.id)).find(
          (channel) => channel.channelId === req.params.channelId
        )
        if (!existingChannel) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'channel not found' })
        }
        const bot = await deps.repos.bot.get(integration.botId)
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        const botScopedChannel = bot.transport === 'http' && existingChannel.kind === 'channel'
        let effectiveOwner: AgentRecord | null = null
        let selectedOwner: AgentRecord | null = null
        if (botScopedChannel) {
          if (req.body.agentId !== undefined && !bot.agentIds.includes(AgentId(req.body.agentId))) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'default agent must be an agent that uses this bot'
            })
          }
          const [installs, channelRows] = await Promise.all([
            deps.repos.integration.listForBot(bot.id),
            deps.repos.integrationChannel.listForBot(bot.id)
          ])
          const owner = pickChannelOwner(
            installs,
            channelRows.filter((channel) => channel.kind === 'channel' && channel.channelId === req.params.channelId)
          )
          effectiveOwner = owner ? await deps.repos.agent.get(owner.agentId) : null
          selectedOwner =
            req.body.agentId !== undefined ? await deps.repos.agent.get(AgentId(req.body.agentId)) : effectiveOwner
          if (!effectiveOwner || !selectedOwner) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'channel owner changed; refresh and retry the integration change'
            })
          }
          if (!canEdit(effectiveOwner, ctxOf(req)) || !canEdit(selectedOwner, ctxOf(req))) {
            return reply.code(403).send({
              error: 'Forbidden',
              statusCode: 403,
              message: 'cannot edit the current or selected channel owner'
            })
          }
        }
        const mutationAgents = [
          ...new Map(
            [agent, effectiveOwner, selectedOwner]
              .filter((candidate): candidate is AgentRecord => candidate !== null)
              .map((candidate) => [candidate.id, candidate])
          ).values()
        ]
        const release = deps.agentMutations.tryBeginMutation(mutationAgents.map((candidate) => candidate.id))
        if (!release) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'agent move is in progress; retry the integration change'
          })
        }
        try {
          const refreshed = new Map<string, AgentRecord>()
          for (const observed of mutationAgents) {
            const current = await refreshMutationAgent(observed)
            if (!current) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'agent placement changed; refresh and retry the integration change'
              })
            }
            refreshed.set(current.id, current)
          }
          agent = refreshed.get(agent.id)!
          // HTTP channel ownership is bot-scoped even though membership rows are
          // stored per integration. Route the whole patch through the orchestrator
          // so every agent detail shows the same owner/trigger and exactly one row
          // remains authoritative.
          let updated: IntegrationChannelRecord | null = null
          let routesSynced = false
          if (botScopedChannel) {
            updated = await deps.httpBot.updateChannel(
              bot.id,
              req.params.channelId,
              {
                ...(req.body.agentId !== undefined ? { agentId: req.body.agentId } : {}),
                ...(req.body.trigger !== undefined ? { trigger: req.body.trigger } : {})
              },
              {
                expectedOwnerAgentId: effectiveOwner!.id,
                source: 'console'
              }
            )
            if (!updated) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'channel owner changed; refresh and retry the integration change'
              })
            }
            routesSynced = true
          } else {
            if (req.body.agentId !== undefined) {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                message: 'default agent applies only to shared channels'
              })
            }
            updated = await deps.repos.integrationChannel.setTrigger(
              integration.id,
              req.params.channelId,
              req.body.trigger!
            )
          }
          if (!updated)
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'channel not found' })
          // Push the change: an HTTP bot's routes hot-update on the relay; a classic
          // bot re-pushes its recomputed bindRules to the owning daemon.
          if (bot.transport === 'http') {
            if (!routesSynced) await deps.httpBot.syncRoutes(bot.id)
          } else if (agent.daemonId) {
            await replicateUpsert(integration, agent.daemonId)
          }
          return toChannelDto(updated!)
        } finally {
          release()
        }
      }
    )

    /**
     * Forget one conversation row. This is CLEANUP, not a platform action: it says
     * "AgentConnect should stop listing this", which is the only thing an operator
     * can do about a conversation the bot already left on a platform that cannot
     * report its own departure (Telegram, Discord, Feishu — their reports can only
     * ever grow). Sessions and transcripts are untouched.
     *
     * On an enumerating platform the row simply comes back on the next authoritative
     * listing if the bot is in fact still there — which is the correct answer to
     * "why did it reappear": it never left, and leaving is `…/leave` or a platform
     * action, not this.
     */
    r.delete(
      '/integrations/:id/channels/:channelId',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Forget a channel',
          description:
            'Remove a conversation row from AgentConnect without touching the platform. Intended for a conversation the bot has already left where the platform cannot report its own departure. The row returns on the next authoritative listing if the bot is still a member.',
          operationId: 'deleteIntegrationChannel',
          params: IdParam.extend({ channelId: z.string().min(1) }),
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const admitted = await admitChannelAction(req, reply)
        if (!admitted) return
        const { integration, agent, bot } = admitted
        const scope = await resolveBotScopedChannel(req, integration, bot, req.params.channelId)
        if (!scope.ok) return reply.code(scope.code).send(scope.body)
        // The owner joins the lease, not just the authorization: a bot-wide action
        // decided against one owner must not commit while a move re-places that owner.
        const leased = [...new Set([agent.id, ...(scope.ownerAgentId ? [scope.ownerAgentId] : [])])]
        const release = deps.agentMutations.tryBeginMutation(leased)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the removal' })
        }
        try {
          // Ownership can change between resolving it and holding the lease, so the
          // verdict is re-taken under the lease and must still name the same owner.
          const fenced = await resolveBotScopedChannel(req, integration, bot, req.params.channelId)
          if (!fenced.ok) return reply.code(fenced.code).send(fenced.body)
          if (fenced.ownerAgentId !== scope.ownerAgentId) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'channel owner changed; refresh and retry' })
          }
          const rows = await deps.repos.integrationChannel.listForIntegration(integration.id)
          if (!rows.some((row) => row.channelId === req.params.channelId)) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'channel not found' })
          }
          // Suppress at the SOURCE FIRST, and only then delete. The daemon's tombstone
          // is what makes the removal stick — its observed set is rebuilt from session
          // history — so deleting first and reporting 502 afterwards would leave the row
          // gone from the console while telling the operator it failed, and the advised
          // retry would 404 on the already-deleted row instead of re-attempting the
          // suppression. Same order the leave route uses: confirm, then touch local state.
          const suppressed = await pushForget(integration, agent, [req.params.channelId])
          if (!suppressed.ok) return reply.code(502).send(suppressed.body)
          // A shared bot's CHANNEL state is bot-scoped — ownership and trigger are
          // replicated across every install — so forgetting it on one install alone
          // would leave siblings listing it and let the compiler resurrect the row. A
          // direct row is per-agent and stays on this install only (§14.3).
          const installs = scope.botScoped ? await deps.repos.integration.listForBot(bot.id) : [integration]
          for (const install of installs) {
            await deps.repos.integrationChannel.deleteChannel(install.id, req.params.channelId)
          }
          await republishChannels(integration, bot, agent)
          return reply.code(204).send(null)
        } finally {
          release()
        }
      }
    )

    /**
     * Leave at the PLATFORM — the only route here that changes the outside world.
     *
     * `target` is explicit because the platforms do not agree on what a bot can
     * withdraw from: Slack and Telegram leave one conversation, while a Discord bot
     * has no per-channel membership at all and can only leave an entire server. The
     * caller states which it means; the daemon refuses a mismatch rather than
     * quietly doing the larger thing.
     *
     * A platform refusal — a missing scope, `last_member`, a lost right — comes back
     * as 502 carrying the platform's own words, because the operator can usually act
     * on them and a generic failure would hide that.
     */
    r.post(
      '/integrations/:id/leave',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Leave a conversation',
          description:
            "Ask the owning daemon to withdraw the bot from a conversation (Slack, Telegram) or an entire server (Discord) at the platform, then forget the affected rows. Returns 502 with the platform's own message when the platform refuses.",
          operationId: 'leaveIntegrationConversation',
          params: IdParam,
          body: LeaveIntegrationConversationBody,
          response: { 204: z.null(), 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const admitted = await admitChannelAction(req, reply)
        if (!admitted) return
        const { integration, agent, bot } = admitted
        const target = req.body.target
        if (target.kind === 'space' && integration.platform !== 'discord') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'only Discord has a server to leave; leave the conversation instead'
          })
        }
        if (target.kind === 'conversation' && integration.platform === 'discord') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'a Discord bot joins servers, not channels; leave the server instead'
          })
        }
        const scope =
          target.kind === 'conversation'
            ? await resolveBotScopedChannel(req, integration, bot, target.channel)
            : ({ ok: true, botScoped: false, ownerAgentId: undefined } as const)
        if (!scope.ok) return reply.code(scope.code).send(scope.body)
        // Held across the whole request, not just the row writes. A cold move
        // re-places the agent on another daemon and rebuilds its channel state
        // there; without the lease this could dispatch the platform call to the
        // PRE-move daemon and then delete rows the move has already rewritten —
        // leaving the new daemon believing it is still in a channel the bot has
        // actually left. The effective owner joins the lease for the same reason the
        // forget route takes it: a bot-wide action decided against one owner must not
        // commit while a move re-places that owner.
        const leased = [...new Set([agent.id, ...(scope.ownerAgentId ? [scope.ownerAgentId] : [])])]
        const release = deps.agentMutations.tryBeginMutation(leased)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry leaving' })
        }
        try {
          if (target.kind === 'conversation') {
            const fenced = await resolveBotScopedChannel(req, integration, bot, target.channel)
            if (!fenced.ok) return reply.code(fenced.code).send(fenced.body)
            if (fenced.ownerAgentId !== scope.ownerAgentId) {
              return reply
                .code(409)
                .send({ error: 'Conflict', statusCode: 409, message: 'channel owner changed; refresh and retry' })
            }
          }
          // Placement may have changed between admission and taking the lease, so the
          // daemon this dispatches to is re-read under it rather than trusted.
          const placed = await refreshMutationAgent(agent)
          if (!placed) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'agent placement changed; retry leaving' })
          }
          // The daemon holding this integration owns provider egress for it in BOTH
          // transports — a relay-managed bot still keeps send credentials — so the
          // platform call belongs to the agent's own daemon either way.
          if (!placed.daemonId) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'the agent is not placed on a daemon; it cannot reach the platform'
            })
          }
          let verdict
          try {
            verdict = await deps.control.integrationLeave(placed.daemonId, { integrationId: integration.id, target })
          } catch (err) {
            return reply.code(502).send({
              error: 'Bad Gateway',
              statusCode: 502,
              message: err instanceof NoConnection ? 'the daemon is offline' : (err as Error).message
            })
          }
          if (!verdict.ok) {
            return reply
              .code(502)
              .send({ error: 'Bad Gateway', statusCode: 502, message: verdict.error ?? 'the platform refused' })
          }
          // The daemon retires the affected rows itself (an authoritative re-list on
          // Slack, an explicit retraction elsewhere). Forgetting them here too makes
          // the console consistent the moment this returns, and is idempotent.
          const installs = scope.botScoped ? await deps.repos.integration.listForBot(bot.id) : [integration]
          const rows = await deps.repos.integrationChannel.listForIntegration(integration.id)
          const gone =
            target.kind === 'space'
              ? rows.filter((row) => row.spaceId === target.spaceId).map((row) => row.channelId)
              : [target.channel]
          for (const install of installs) {
            for (const channelId of gone) await deps.repos.integrationChannel.deleteChannel(install.id, channelId)
          }
          await republishChannels(integration, bot, placed)
          return reply.code(204).send(null)
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
          if (botBefore?.transport === 'http') {
            await deps.httpBot.prepareIntegrationRemoval(existing.botId)
          }
          await deps.repos.integration.delete(existing.id)
          // "Freed" now means NO active integration remains (a shareable bot may still
          // serve other agents — don't stamp it freed while it does, §6).
          const remaining = await deps.repos.integration.listForBot(existing.botId)
          if (remaining.length === 0) {
            await deps.repos.bot.markFreed(existing.botId, new Date(), agent.name ?? null)
          }
          // Tell the removed agent's daemon to drop the spec either way.
          await replicateRemove(existing.id, agent.daemonId ?? null)
          // HTTP bot: recompute the relay's routes + members (or release it if this
          // was the last install).
          if (botBefore?.transport === 'http') await deps.httpBot.syncBot(existing.botId)
          return reply.code(204).send(null)
        } finally {
          release()
        }
      }
    )
  }
}
