// Register a new bot and publish its integration; reserved IDs make interrupted installs retryable.
import { randomUUID } from 'node:crypto'
import type { HttpDeps } from './deps.js'
import type { AgentRecord, BotRecord, IntegrationRecord, SlackTransport } from '../persistence/ports.js'
import { BotId, IntegrationId, type OrgId } from '../domain/ids.js'
import { integrationToSpec } from '../orchestrator/placement.js'
import { NoConnection } from '../orchestrator/outbound.js'
import type { CpNewBotInstall } from '../platforms/provider.js'
import { BotWorkspaceClaimed } from '../persistence/errors.js'

export interface InstallNewBotArgs extends CpNewBotInstall {
  orgId: OrgId
  // Durable login flows reserve these IDs before the first install attempt.
  reservedIds?: { botId: BotId; integrationId: IntegrationId }
  // Caller checks visibility, edit permission, placement and the mutation gate.
  agent: AgentRecord
  /** Registry platform id — the bot/integration rows' `platform` column. */
  platform: string
  name: string
  /** The bot row's own name; absent ⇒ `name`. */
  botName?: string
  // HTTP uses relay ingress; socket uses the daemon's connection.
  transport?: SlackTransport
  /** Provisioned by AgentConnect (the platform app), not a console user. */
  prebuilt?: boolean
  createdByUserId?: string
  // Seed HTTP conversation routes before publishing the bot.
  seedConversations?: (integration: IntegrationRecord, bot: BotRecord) => Promise<void>
}

/** Minimal log surface (Fastify logger in prod). */
interface DebugLog {
  debug(obj: unknown, msg?: string): void
}

export async function installNewBot(
  deps: HttpDeps,
  log: DebugLog,
  args: InstallNewBotArgs
): Promise<{ integration: IntegrationRecord; bot: BotRecord }> {
  const { orgId, agent, platform, name, secrets, createdByUserId } = args
  const transport: SlackTransport = args.transport ?? 'socket'
  // Socket bots allow only one install to avoid duplicate connections on one credential.
  const shareable = transport === 'http' && args.bot?.shareable === true

  // Enforce captured workspace claims at the shared create seam.
  const claim = args.workspaceClaim
  if (claim && (await deps.repos.bot.workspaceClaimedElsewhere(orgId, platform, claim.appId, claim.tenantId))) {
    throw new BotWorkspaceClaimed(claim.conflictMessage)
  }

  const botId = args.reservedIds?.botId ?? BotId(randomUUID())
  const id = args.reservedIds?.integrationId ?? IntegrationId(randomUUID())
  const existingBot = args.reservedIds ? await deps.repos.bot.get(orgId, botId) : null
  if (existingBot && (existingBot.platform !== platform || existingBot.transport !== transport)) {
    throw new Error('reserved bot id is already in use')
  }
  const bot =
    existingBot ??
    (await deps.repos.bot.create({
      ...args.bot,
      id: botId,
      orgId,
      platform,
      name: args.botName ?? name,
      transport,
      ...(args.prebuilt ? { prebuilt: true } : {}),
      shareable,
      ...(createdByUserId ? { createdByUserId } : {})
    }))
  // Resume missing credentials and retain credentials already stored by an earlier attempt.
  if (!args.reservedIds || !(await deps.repos.botSecret.get(orgId, botId))) {
    await deps.repos.botSecret.put(orgId, botId, secrets)
  }
  const existingIntegration = args.reservedIds ? await deps.repos.integration.get(orgId, id) : null
  if (
    existingIntegration &&
    (existingIntegration.agentId !== agent.id ||
      existingIntegration.botId !== botId ||
      existingIntegration.platform !== platform)
  ) {
    throw new Error('reserved integration id is already in use')
  }
  const integration =
    existingIntegration ??
    (await deps.repos.integration.create({
      ...args.integration,
      id,
      orgId,
      agentId: agent.id,
      botId,
      platform,
      name,
      ...(createdByUserId ? { createdByUserId } : {})
    }))

  // Publish the relay assignment and send-only daemon spec for HTTP bots.
  if (transport === 'http') {
    // Before the sync, so the routes this publishes already carry the platform's own rows.
    await args.seedConversations?.(integration, bot)
    await deps.httpBot.syncBot(botId)
    return { integration, bot }
  }

  // Retry publication too; offline daemons receive the spec when they reconnect. Never log credentials.
  const [secret, channels] = await Promise.all([
    deps.repos.botSecret.get(orgId, botId),
    deps.repos.integrationChannel.listForIntegration(id)
  ])
  const spec = secret
    ? await integrationToSpec(deps.platforms, deps.repos.session, integration, bot, secret, channels, agent)
    : null
  // Withhold unavailable specs and let reconciliation carry or prune the row.
  if (spec) {
    await deps.agentDelivery.integrationUpsert(agent, spec, (err, target) => {
      if (!(err instanceof NoConnection)) throw err
      log.debug({ integrationId: id, daemonId: target }, 'integration/upsert skipped: daemon offline')
    })
  }
  return { integration, bot }
}
