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
import { manifestFor } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import type { AgentRecord, BotRecord, IntegrationRecord, IntegrationChannelRecord } from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import type { ResolvableAgent } from '../../orchestrator/placementResolver.js'
import { denyViewerWrite, ctxOf, orgOf } from '../rbac.js'
import { refreshMutationAgent as refreshAgentUnderMutation } from '../mutation-agent.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { integrationToSpec, isGatedAgent } from '../../orchestrator/placement.js'
import { conversationOwnerRow, pickConversationOwner } from '../../orchestrator/httpBot.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { installNewBot } from '../install-bot.js'
import { removeIntegrationRow } from '../uninstall.js'
import { BotExternalIdentityTaken } from '../../persistence/errors.js'
import { integrationPlatformAvailability } from '../daemon-platform-capability.js'
import { relayIngress } from '../relay-ingress.js'
import { buildCreateIntegrationBody, credentialBlockOf } from '../dto/create-integration-body.js'
import type { CpConfigRefusal } from '../../platforms/provider.js'
import { multiAgentUnsupportedMessage } from '../../platforms/sharing.js'
import {
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
    // §9: the create body is FOLDED from the platform registry (one optional
    // credential block per registered provider + its transport refinements),
    // once per composition root — `@fastify/swagger` reads the same object to
    // document the request body.
    const CreateIntegrationBody = buildCreateIntegrationBody(deps.platforms)
    // The caller's active org — every read/write below is scoped to it.
    const orgIdOf = (req: { orgCtx?: { orgId: OrgId } }) => req.orgCtx!.orgId
    const refreshMutationAgent = (observed: AgentRecord) => refreshAgentUnderMutation(deps.repos.agent, observed)

    // Push the full spec (metadata + tokens + per-conversation bindRules) to every
    // daemon that serves the owning agent — its placement AND any duty holder
    // (`deps.agentDelivery` is the one resolver; a holder left on stale credentials
    // or stale bind rules is the frozen-bundle failure one level down). Best-effort:
    // an offline daemon picks it up from the reconcile roster on the next connect.
    // Token-bearing — never log the spec.
    const replicateUpsert = async (i: IntegrationRecord, owningAgent: ResolvableAgent): Promise<void> => {
      // The bot row joins the reads: it is a required input of the §9 projector
      // that now assembles the spec payload (`orchestrator/placement.ts`). Every
      // caller here is already on the socket-transport arm, so the projector
      // returns the same direct-mode payload this path emitted before.
      const [secret, channels, owner, bot] = await Promise.all([
        deps.repos.botSecret.get(i.orgId, i.botId),
        deps.repos.integrationChannel.listForIntegration(i.id),
        deps.repos.agent.get(i.orgId, i.agentId),
        deps.repos.bot.get(i.orgId, i.botId)
      ])
      if (!secret || !bot) return
      const spec = await integrationToSpec(
        deps.platforms,
        i,
        bot,
        secret,
        channels,
        owner ? isGatedAgent(owner) : false
      )
      // The provider had no deliverable payload — same exit as a missing secret above.
      if (!spec) return
      await deps.agentDelivery.integrationUpsert(owningAgent, spec, (err, target) => {
        if (!(err instanceof NoConnection)) throw err
        app.log.debug({ integrationId: i.id, daemonId: target }, 'integration/upsert skipped: daemon offline')
      })
    }

    // Shareable-install preconditions (shared-bot-relay.md §6): the platform must
    // declare multi-agent bots, a relay must be connected to host the ingest, and one
    // agent installs a bot once. Returns an error envelope, or null to proceed.
    const validateShareableInstall = async (
      bot: { agentIds: string[] },
      agentId: string,
      platform: string
    ): Promise<{ code: 400 | 409; body: { error: string; statusCode: number; message: string } } | null> => {
      if (!manifestFor(platform).multiAgentShareable) {
        return {
          code: 400,
          body: { error: 'Bad Request', statusCode: 400, message: multiAgentUnsupportedMessage(platform) }
        }
      }
      const ingress = relayIngress(deps)
      if (!ingress.ok) {
        return { code: 409, body: { error: 'Conflict', statusCode: 409, message: ingress.message } }
      }
      if (bot.agentIds.includes(agentId)) {
        return { code: 409, body: { error: 'Conflict', statusCode: 409, message: 'this agent already uses this bot' } }
      }
      return null
    }

    // A provider's refusal from `validateConfig` (§9), sent verbatim: 400 for a
    // DEFINITIVE credential rejection, 503 when the provider was unreachable
    // (inconclusive, never proof the credential is bad). `code` rides along only
    // where the platform defines one — the console branches on it.
    const sendConfigRefusal = (reply: FastifyReply, refusal: CpConfigRefusal) =>
      reply.code(refusal.status).send({
        error: refusal.status === 400 ? 'Bad Request' : 'Service Unavailable',
        statusCode: refusal.status,
        ...(refusal.code ? { code: refusal.code } : {}),
        message: refusal.message
      })

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
        // The composed body's `platform` enum IS the registry's id set, so a
        // parsed body always names a registered provider.
        const provider = deps.platforms.get(req.body.platform)!
        let agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        // Derived visibility: installing an integration edits the agent's setup, so
        // a restricted agent the caller can't see 404s, and one they can see but not
        // edit 403s.
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // Delivery is daemon-scoped; refuse until the agent is placed (no backfill hook). A pool
        // agent IS placed and names no machine, so the capability probe below asks whichever
        // member serves it.
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
        const observedBot = req.body.botId === undefined ? null : await deps.repos.bot.get(orgId, BotId(req.body.botId))
        if (req.body.botId !== undefined && (!observedBot || observedBot.platform !== req.body.platform)) {
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
          // Re-taken under the lease, and RESOLVED: the column is null for a pool agent, which is
          // served without naming a machine. Nothing serving it is what "no longer placed" means.
          if (!(await deps.placementResolver.servingDaemon(current))) {
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
            const bot = await deps.repos.bot.get(orgId, BotId(req.body.botId))
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
            // `update({ shareable: true })` promotion the http branch below applies to
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
                if (!bot.shareable) await deps.repos.bot.update(orgId, bot.id, { shareable: true })
              } else {
                const ingress = relayIngress(deps)
                if (!ingress.ok) {
                  return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: ingress.message })
                }
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
            // A socket-transport install is a new duty edge (design §4.4).
            deps.recomputeDuties?.(orgId)
            await replicateUpsert(integration, agent)
            return reply.code(201).send(toDto(integration))
          }

          // ── Register a NEW bot from pasted credentials ────────────────────
          // ONE tail for every platform (§9). What used to be four
          // `req.body.platform === …` arms — each casting the opaque credential
          // block back to its own type and writing its own rows — is now the
          // core skeleton below plus two provider calls: the live credential
          // check (`validateConfig`) and the pure row mapping
          // (`buildNewBotInstall`). Nothing here names a platform.

          const transport = req.body.transport ?? 'socket'
          // HTTP callback ingress exists only where the platform contributes a
          // relay projection (§9: a missing `projectBotAssign` IS the "no relay
          // path" signal). Telegram and Discord keep their daemon-owned
          // long-lived transports.
          if (req.body.transport === 'http' && !provider.projectBotAssign) {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'HTTP callback delivery currently supports Slack and Feishu only'
            })
          }
          // Public relay ingress is CORE's 409 (§9 — core, not the provider, knows
          // the relay pool), and it now precedes the provider round-trip on every
          // platform: a deployment that cannot serve http ingress at all is a
          // deployment-level blocker, so there is no point spending a provider API
          // call first. (Feishu already checked in this order; Slack checked after.
          // The two refusals can only race when the credential is ALSO bad.)
          if (transport === 'http') {
            const ingress = relayIngress(deps)
            if (!ingress.ok) {
              return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: ingress.message })
            }
          }

          // The chosen platform's credential block: validated by the provider's OWN
          // schema (§9) and guaranteed present here by the exactly-one-of refinement.
          // Opaque to core — it travels straight back into the provider, which is the
          // only code that knows the field names inside.
          const credentials = credentialBlockOf(req.body)

          // Every provider round-trip that must precede persistence — token
          // verification, and Discord's Message-Content intent enablement — so a
          // stale / wrong / swapped credential fails the request instead of minting
          // an integration whose transport never opens. Reachability stays
          // best-effort by contract: only a DEFINITIVE rejection refuses with 400.
          const validated = await provider.validateConfig(credentials, transport)
          if (!validated.ok) return sendConfigRefusal(reply, validated)

          // The platform half of the write: which bot/integration columns this
          // platform fills, how it packs the shared secret row, and the D6 identity
          // it claims. Pure — no I/O.
          const install = provider.buildNewBotInstall({
            credentials,
            identity: validated.identity,
            transport,
            shareable: req.body.shareable === true
          })
          // Name: operator-typed → provider-derived → the owning agent's name.
          const provided = req.body.name?.trim()
          const name = provided || validated.identity.name || agent.name

          // D6 fence, half one: one bot per external app identity. New rows write the
          // tenant sentinel, so the composite unique backstops the race below; this
          // pre-check just turns the common case into a clean 409 with reuse guidance.
          const fence = install.externalIdentity
          if (fence) {
            const identityTaken = await deps.repos.bot.getByExternalIdentity(
              req.body.platform,
              fence.externalAppId,
              fence.externalTenantId
            )
            if (identityTaken) {
              return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: fence.conflictMessage })
            }
          }

          try {
            const { integration, bot } = await installNewBot(deps, app.log, {
              ...install,
              orgId,
              agent,
              platform: req.body.platform,
              name,
              transport,
              ...(req.principal ? { createdByUserId: req.principal.userId } : {})
            })
            // Install-time side effects (§9 `sideEffects.postCreate`): the Telegram
            // avatar push, the Discord profile/avatar push. Cosmetic and best-effort
            // by contract — a failure is logged and the install stands (201 either
            // way). An absent member ⇒ the platform pushes nothing.
            if (provider.sideEffects?.postCreate) {
              try {
                await provider.sideEffects.postCreate({
                  integration,
                  bot,
                  secrets: install.secrets,
                  agent: profileAgent
                })
              } catch (err) {
                app.log.warn(
                  { err, agentId: agent.id, botId: bot.id, platform: req.body.platform },
                  'post-install profile sync failed; integration remains active'
                )
              }
            }
            return reply.code(201).send(toDto(integration))
          } catch (err) {
            // D6 fence, half two: the composite unique fired between the pre-check
            // above and the insert.
            if (fence && err instanceof BotExternalIdentityTaken) {
              return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: fence.conflictMessage })
            }
            throw err
          }
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
          description: 'Every platform integration in the active organization, each with its conversation bindings.',
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
        // active install of each visible bot so every conversation copy agrees.
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
            return { botId, installs, channels }
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
            const owner = pickConversationOwner(state.installs, channels)
            if (!owner) continue
            const channel = conversationOwnerRow(owner, channels)
            if (channel) {
              const persistedOwner = channels.some((row) => row.agentId === owner.agentId)
              const ownerAgent = persistedOwner ? null : await deps.repos.agent.get(orgOf(req), owner.agentId)
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
              const state = effective.get(`${integration.botId}\u0000${channel.channelId}`)
              return state ? { ...channel, agentId: state.agentId, trigger: state.trigger } : channel
            })
          )
        )
      }
    )

    /**
     * Shared admission for the per-conversation routes: the integration must be in this
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
      const integration = await deps.repos.integration.get(orgIdOf(req as never), IntegrationId(req.params.id))
      if (!integration) {
        reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        return null
      }
      const agent = await deps.repos.agent.get(orgIdOf(req as never), integration.agentId)
      if (!agent || !canView(agent, ctxOf(req as never))) {
        reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        return null
      }
      if (!canEdit(agent, ctxOf(req as never))) {
        reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        return null
      }
      const bot = await deps.repos.bot.get(orgIdOf(req as never), integration.botId)
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
      else await replicateUpsert(integration, agent)
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
    /**
     * Does this platform need a durable suppression at all?
     *
     * Only the ones whose conversation list is rebuilt from session history — the
     * daemon's `refreshObservedChannels` set, which is exactly the manifest's
     * `membershipEnumeration: 'observed'` arm (§5). A platform that re-lists its
     * membership authoritatively has its rows governed by that listing and a
     * tombstone would add nothing; demanding one would just make Forget fail
     * whenever its daemon is offline, for no gain. This is also why the
     * multi-install fan-out below can never span several daemons today: a bot may
     * only gain a second agent when it is shareable, and shareable is Slack-only.
     *
     * Reading the manifest rather than naming the three observed platforms also
     * makes the miss arm fail-closed: an id this build does not know gets
     * `DEFAULT_MANIFEST` (`'observed'`) and is asked for a suppression, instead of
     * being silently treated as authoritative.
     */
    const needsSuppression = (platform: string): boolean => manifestFor(platform).membershipEnumeration === 'observed'

    const pushForget = async (
      integration: IntegrationRecord,
      agent: AgentRecord,
      channels: string[]
    ): Promise<{ ok: true } | { ok: false; body: { error: string; statusCode: number; message: string } }> => {
      if (channels.length === 0 || !needsSuppression(integration.platform)) return { ok: true }
      const undeliverable = {
        ok: false as const,
        body: {
          error: 'Bad Gateway',
          statusCode: 502,
          message: 'the daemon is offline, so this conversation would be listed again — retry once it reconnects'
        }
      }
      // The suppression goes to whoever serves the agent right now — its placement, or the member
      // holding its duty. A pool agent names no machine, so the column would refuse every one.
      const target = await deps.placementResolver.servingDaemon(agent)
      if (!target) return undeliverable
      try {
        const ack = await deps.control.integrationForget(target, { integrationId: integration.id, channels })
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
     * A shared bot's conversation is bot-scoped: one owner, and a trigger replicated
     * across every install. Ending its listing therefore reaches agents beyond the one whose
     * page this is, so it takes the SAME authorization the trigger/owner PATCH takes —
     * edit rights on the effective owner — instead of only on this integration's agent.
     * Returns an error envelope to send, or null when the action may proceed.
     */
    const resolveBotScopedConversation = async (
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
      if (bot.transport !== 'http' || !row) {
        return { ok: true, botScoped: false }
      }
      const [installs, conversationRows] = await Promise.all([
        deps.repos.integration.listForBot(bot.id),
        deps.repos.integrationChannel.listForBot(bot.id)
      ])
      const owner = pickConversationOwner(
        installs,
        conversationRows.filter((candidate) => candidate.channelId === channelId)
      )
      const ownerAgent = owner ? await deps.repos.agent.get(owner.orgId, owner.agentId) : null
      if (!ownerAgent) {
        return {
          ok: false,
          code: 409,
          body: { error: 'Conflict', statusCode: 409, message: 'conversation owner changed; refresh and retry' }
        }
      }
      if (!canEdit(ownerAgent, ctxOf(req as never))) {
        return {
          ok: false,
          code: 403,
          body: { error: 'Forbidden', statusCode: 403, message: 'cannot edit this conversation’s owning agent' }
        }
      }
      return { ok: true, botScoped: true, ownerAgentId: ownerAgent.id }
    }

    // Per-conversation trigger choice (@-mention vs any message). Persist, then push the
    // integration's recomputed bindRules to the owning daemon (integration/upsert,
    // best-effort — the reconcile roster converges an offline daemon later).
    r.patch(
      '/integrations/:id/channels/:channelId',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Update a conversation',
          description: "Set a conversation's trigger or default agent, then push the updated routing configuration.",
          operationId: 'updateIntegrationChannel',
          params: IdParam.extend({ channelId: z.string().min(1) }),
          body: UpdateIntegrationChannelBody,
          response: { 200: IntegrationChannelDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const integration = await deps.repos.integration.get(orgIdOf(req), IntegrationId(req.params.id))
        if (!integration) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        }
        // Derived visibility: gate on the parent agent — a restricted agent the
        // caller can't see 404s (hiding the integration too), one they can see but
        // not edit 403s.
        let agent = await deps.repos.agent.get(orgIdOf(req as never), integration.agentId)
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
        const bot = await deps.repos.bot.get(orgIdOf(req), integration.botId)
        if (!bot) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'bot not found' })
        }
        const botScopedConversation = bot.transport === 'http'
        let effectiveOwner: AgentRecord | null = null
        let selectedOwner: AgentRecord | null = null
        if (botScopedConversation) {
          if (req.body.agentId !== undefined && !bot.agentIds.includes(AgentId(req.body.agentId))) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'default agent must be an agent that uses this bot'
            })
          }
          const [installs, conversationRows] = await Promise.all([
            deps.repos.integration.listForBot(bot.id),
            deps.repos.integrationChannel.listForBot(bot.id)
          ])
          const owner = pickConversationOwner(
            installs,
            conversationRows.filter((channel) => channel.channelId === req.params.channelId)
          )
          effectiveOwner = owner ? await deps.repos.agent.get(orgOf(req), owner.agentId) : null
          selectedOwner =
            req.body.agentId !== undefined
              ? await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
              : effectiveOwner
          if (!effectiveOwner || !selectedOwner) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'conversation owner changed; refresh and retry the integration change'
            })
          }
          if (!canEdit(effectiveOwner, ctxOf(req)) || !canEdit(selectedOwner, ctxOf(req))) {
            return reply.code(403).send({
              error: 'Forbidden',
              statusCode: 403,
              message: 'cannot edit the current or selected conversation owner'
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
          // HTTP conversation ownership is bot-scoped even though membership rows are
          // stored per integration. Route the whole patch through the orchestrator
          // so every agent detail shows the same owner/trigger and exactly one row
          // remains authoritative.
          let updated: IntegrationChannelRecord | null = null
          let routesSynced = false
          if (botScopedConversation) {
            updated = await deps.httpBot.updateConversation(
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
                message: 'conversation owner changed; refresh and retry the integration change'
              })
            }
            routesSynced = true
          } else {
            if (req.body.agentId !== undefined) {
              return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                message: 'default agent applies only to shared bot conversations'
              })
            }
            // A human picked this, so it outranks every later default (§14.8).
            updated = await deps.repos.integrationChannel.setTrigger(
              integration.id,
              req.params.channelId,
              req.body.trigger!,
              { chosen: true }
            )
          }
          if (!updated)
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'channel not found' })
          // Push the change: an HTTP bot's routes hot-update on the relay; a classic
          // bot re-pushes its recomputed bindRules to the owning daemon.
          if (bot.transport === 'http') {
            if (!routesSynced) await deps.httpBot.syncRoutes(bot.id)
          } else {
            await replicateUpsert(integration, agent)
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
          summary: 'Forget a conversation',
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
        const scope = await resolveBotScopedConversation(req, integration, bot, req.params.channelId)
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
          const fenced = await resolveBotScopedConversation(req, integration, bot, req.params.channelId)
          if (!fenced.ok) return reply.code(fenced.code).send(fenced.body)
          if (fenced.ownerAgentId !== scope.ownerAgentId) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'conversation owner changed; refresh and retry' })
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
          // A shared bot's conversation state is bot-scoped, so delete every sibling
          // row or the compiler can resurrect it on the next convergence.
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
        // Which target shape this platform can actually serve — the §5 manifest's
        // `leaveGranularity`, earned by this branch (it is a genuine PRE-DISPATCH
        // read: the shape is validated before an owner resolves, before the
        // mutation lease, and before any daemon is reached). The same axis is the
        // daemon's two leave members and the web module's
        // `WebChannelListSemantics.leave`; core now reads the declaration those
        // two describe instead of re-spelling "Discord is the one with servers".
        // Fail-closed on an unknown id: `'conversation'`, exactly the arm the
        // `!== 'discord'` comparison took.
        const leaves = manifestFor(integration.platform).leaveGranularity
        if (target.kind === 'space' && leaves !== 'space') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'this platform has no space to leave; leave the conversation instead'
          })
        }
        if (target.kind === 'conversation' && leaves === 'space') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'on this platform the bot joins a space, not individual conversations; leave the space instead'
          })
        }
        const scope =
          target.kind === 'conversation'
            ? await resolveBotScopedConversation(req, integration, bot, target.channel)
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
            const fenced = await resolveBotScopedConversation(req, integration, bot, target.channel)
            if (!fenced.ok) return reply.code(fenced.code).send(fenced.body)
            if (fenced.ownerAgentId !== scope.ownerAgentId) {
              return reply
                .code(409)
                .send({ error: 'Conflict', statusCode: 409, message: 'conversation owner changed; refresh and retry' })
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
          // platform call belongs to whichever member serves the agent, resolved not read.
          const egressDaemonId = await deps.placementResolver.servingDaemon(placed)
          if (!egressDaemonId) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'the agent is not placed on a daemon; it cannot reach the platform'
            })
          }
          let verdict
          try {
            verdict = await deps.control.integrationLeave(egressDaemonId, { integrationId: integration.id, target })
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
        const existing = await deps.repos.integration.get(orgIdOf(req), IntegrationId(req.params.id))
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
        }
        // Derived visibility: gate on the parent agent (a restricted agent the caller
        // can't see 404s; can-see-but-not-edit 403s) before removing its integration.
        let agent = await deps.repos.agent.get(orgOf(req), existing.agentId)
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
          const botBefore = await deps.repos.bot.get(orgIdOf(req), existing.botId)
          if (botBefore?.transport === 'http') {
            await deps.httpBot.prepareIntegrationRemoval(existing.botId)
          }
          // The row-scoped half is the shared skeleton (`http/uninstall.ts`): delete,
          // re-derive the freed stamp, and tell the agent's daemons to drop the spec.
          await removeIntegrationRow(deps, app.log, { orgId: orgIdOf(req), integration: existing, agent })
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
