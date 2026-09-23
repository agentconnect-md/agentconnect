/**
 * Integration-gating convergence (resource-visibility.md §14.4): when an agent's
 * visibility flips, its derived conversation-gating flag changes, so every
 * integration of the agent must be re-converged — an HTTP bot recompiles
 * its relay routes + re-pushes send-only specs (`syncBot` covers both), a direct
 * install gets a fresh token-bearing spec push. Best-effort per integration: a
 * missed push self-heals from the reconcile roster on the daemon's next connect.
 */
import type {
  AgentRecord,
  AgentRepo,
  BotRepo,
  BotSecretStore,
  IntegrationChannelRepo,
  IntegrationRecord,
  IntegrationRepo
} from '../persistence/ports.js'
import { NoConnection } from './outbound.js'
import type { AgentDelivery } from './agentDelivery.js'
import { integrationToSpec, isGatedAgent } from './placement.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import { AgentId, type IntegrationId } from '../domain/ids.js'

export interface GatingPushDeps {
  repos: {
    integration: IntegrationRepo
    bot: BotRepo
    botSecret: BotSecretStore
    integrationChannel: IntegrationChannelRepo
  }
  agentDelivery: AgentDelivery
  httpBot: { syncBot(botId: string): Promise<void> }
  /** §9 platform providers — the projector behind the re-pushed spec's payload.
   *  `HttpDeps` already carries this field, so the caller passes its bundle
   *  unchanged. */
  platforms: CpPlatformRegistry
}

export async function convergeIntegrationGating(
  deps: GatingPushDeps,
  agent: AgentRecord,
  log?: { warn(obj: unknown, msg?: string): void }
): Promise<void> {
  const integrations = await deps.repos.integration.listForAgent(AgentId(agent.id))
  const syncedBots = new Set<string>()
  for (const i of integrations) await convergeIntegration(deps, i, agent, syncedBots, log)
}

/** Re-push the specs of every integration gating on an edited Decision (decisions.md §7.1); best-effort. */
export async function convergeDecisionConsumers(
  deps: GatingPushDeps & { repos: { agent: Pick<AgentRepo, 'getUnscoped'> } },
  integrationIds: readonly IntegrationId[],
  log?: { warn(obj: unknown, msg?: string): void }
): Promise<void> {
  const syncedBots = new Set<string>()
  for (const id of new Set(integrationIds)) {
    try {
      const i = await deps.repos.integration.getUnscoped(id)
      if (!i || i.status !== 'active') continue
      const agent = await deps.repos.agent.getUnscoped(i.agentId)
      if (!agent) continue
      await convergeIntegration(deps, i, agent, syncedBots, log)
    } catch (err) {
      log?.warn({ integrationId: id, err: (err as Error).message }, 'decision converge: integration push failed')
    }
  }
}

/** One integration's convergence: an http bot recompiles once per bot, a direct install gets a fresh spec. */
async function convergeIntegration(
  deps: GatingPushDeps,
  i: IntegrationRecord,
  agent: AgentRecord,
  syncedBots: Set<string>,
  log?: { warn(obj: unknown, msg?: string): void }
): Promise<void> {
  try {
    // Orchestration: the bot behind one of this agent's integration rows.
    const bot = await deps.repos.bot.getUnscoped(i.botId)
    if (bot?.transport === 'http') {
      if (!syncedBots.has(String(bot.id))) {
        syncedBots.add(String(bot.id))
        await deps.httpBot.syncBot(String(bot.id))
      }
      return
    }
    // The bot row is a required projector input (§9). Unreachable — the
    // integration→bot FK is non-null and `onDelete: Restrict` — but a spec
    // without it would be a fabricated identity, so skip like a missing secret.
    if (!bot) return
    const [secret, channels] = await Promise.all([
      deps.repos.botSecret.get(i.orgId, i.botId),
      deps.repos.integrationChannel.listForIntegration(i.id)
    ])
    if (!secret) return
    // Every daemon serving the agent, not just its placement: a gating flip that
    // reaches only the placement leaves a holder admitting conversations the
    // agent's new visibility forbids.
    const spec = await integrationToSpec(deps.platforms, i, bot, secret, channels, isGatedAgent(agent))
    // No deliverable payload ⇒ nothing to converge; the reconcile roster prunes it, like a
    // missing secret. Pushing a config-less spec would only be refused and ignored by the daemon.
    if (!spec) return
    await deps.agentDelivery.integrationUpsert(agent, spec, (err) => {
      if (err instanceof NoConnection) return // offline daemon → reconcile roster carries it
      throw err
    })
  } catch (err) {
    if (err instanceof NoConnection) return // offline daemon → reconcile roster carries it
    log?.warn({ integrationId: i.id, err: (err as Error).message }, 'gating converge: integration push failed')
  }
}
