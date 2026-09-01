/**
 * Register a Feishu/Lark bot from an app credential pair and push it live.
 *
 * Both the manual credential form and the one-click registration flow land
 * here. Secret material is written through BotSecretStore and is never
 * returned to the browser or included in logs.
 */
import { randomUUID } from 'node:crypto'
import type { FeishuRegion } from '@agentconnect.md/protocol'
import type { HttpDeps } from './deps.js'
import type { AgentRecord, IntegrationRecord, SlackTransport } from '../persistence/ports.js'
import { BotId, IntegrationId, type OrgId } from '../domain/ids.js'
import { integrationToSpec, isGatedAgent } from '../orchestrator/placement.js'
import { NoConnection } from '../orchestrator/outbound.js'

export interface InstallFeishuBotArgs {
  orgId: OrgId
  agent: AgentRecord
  /** Pre-reserved by durable one-click registration for restart-idempotency. */
  botId?: BotId
  /** Pre-reserved by durable one-click registration for restart-idempotency. */
  integrationId?: IntegrationId
  name: string
  appId: string
  appSecret: string
  region: FeishuRegion
  transport?: SlackTransport
  botUserId?: string
  verificationToken?: string
  encryptKey?: string
  createdByUserId?: string
}

interface DebugLog {
  debug(obj: unknown, msg?: string): void
}

export async function installNewFeishuBot(
  deps: HttpDeps,
  log: DebugLog,
  args: InstallFeishuBotArgs
): Promise<IntegrationRecord> {
  const { orgId, agent, name, appId, appSecret, region, createdByUserId } = args
  const transport = args.transport ?? 'socket'
  const botId = args.botId ?? BotId(randomUUID())
  const id = args.integrationId ?? IntegrationId(randomUUID())
  let integration = await deps.repos.integration.get(orgId, id)
  if (
    integration &&
    (integration.agentId !== agent.id || integration.botId !== botId || integration.platform !== 'feishu')
  ) {
    throw new Error('reserved Feishu integration id is already in use')
  }
  if (!integration) {
    const bot = await deps.repos.bot.get(orgId, botId)
    if (!bot) {
      await deps.repos.bot.create({
        id: botId,
        orgId,
        platform: 'feishu',
        name,
        feishuAppId: appId,
        feishuRegion: region,
        transport,
        ...(args.botUserId ? { botUserId: args.botUserId } : {}),
        ...(createdByUserId ? { createdByUserId } : {})
      })
    } else if (
      bot.orgId !== orgId ||
      bot.platform !== 'feishu' ||
      bot.feishuAppId !== appId ||
      bot.transport !== transport
    ) {
      throw new Error('reserved Feishu bot id is already in use')
    }
  }
  // Feishu reuses the established two-slot secret shape:
  // botToken = appSecret (secret), appToken = appId (identifier).
  await deps.repos.botSecret.put(orgId, botId, {
    botToken: appSecret,
    appToken: appId,
    signingSecret: null,
    verificationToken: args.verificationToken ?? null,
    encryptKey: args.encryptKey ?? null
  })

  if (!integration) {
    integration = await deps.repos.integration.create({
      id,
      orgId,
      agentId: agent.id,
      botId,
      platform: 'feishu',
      name,
      feishuRegion: region,
      ...(createdByUserId ? { createdByUserId } : {})
    })
  }

  if (transport === 'http') {
    await deps.httpBot.syncBot(botId)
    return integration
  }

  // The bot row joins the reads: it is a required input of the §9 projector that
  // now assembles the spec payload (`orchestrator/placement.ts`). It was created
  // or matched above, so this read always hits.
  const [secret, channels, botRow] = await Promise.all([
    deps.repos.botSecret.get(orgId, botId),
    deps.repos.integrationChannel.listForIntegration(id),
    deps.repos.bot.get(orgId, botId)
  ])
  const spec =
    secret && botRow
      ? await integrationToSpec(deps.platforms, integration, botRow, secret, channels, isGatedAgent(agent))
      : null
  if (spec) {
    await deps.agentDelivery.integrationUpsert(agent, spec, (err, target) => {
      if (!(err instanceof NoConnection)) throw err
      log.debug({ integrationId: id, daemonId: target }, 'integration/upsert skipped: daemon offline')
    })
  }
  return integration
}
