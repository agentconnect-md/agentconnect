/**
 * The teardown skeletons — `installNewBot`'s counterparts, and core for the same
 * reason it is: the steps are identical wherever an install or an identity goes away,
 * and only the CALLER's policy differs.
 *
 * They landed here when Linear needed a workspace disconnect. That route removes every
 * member install of one bot and then the bot, which is exactly `DELETE /integrations/:id`
 * followed by `DELETE /bots/:id` — so it either reuses those bodies or grows a second
 * copy of the freed-stamping, the duty recompute, the `integration/remove` fan-out and
 * the declared `onBotDelete` side effect. A second copy of a teardown is how one path
 * quietly stops firing a step the other still does.
 *
 * The BOT-SCOPED half stays with the caller on purpose: `prepareIntegrationRemoval` and
 * `syncBot` are per-bot, not per-install, so a caller removing N installs of one bot
 * spends them once around the loop rather than N times inside it.
 */
import type { HttpDeps } from './deps.js'
import type { AgentRecord, BotRecord, IntegrationRecord } from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'
import { NoConnection } from '../orchestrator/outbound.js'

/** Minimal log surface (Fastify logger in prod). */
interface TeardownLog {
  debug(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

/**
 * Remove ONE install: drop the row, re-derive the bot's freed stamp, and tell the
 * owning agent's daemons to drop the spec.
 *
 * The caller owns authorization, the agent-mutation lease, and the bot-scoped
 * `prepareIntegrationRemoval` / `syncBot` pair around it.
 */
export async function removeIntegrationRow(
  deps: HttpDeps,
  log: TeardownLog,
  args: {
    orgId: OrgId
    integration: IntegrationRecord
    /** The install's owning agent, resolved under the caller's lease. Absent ⇒ the row
     *  outlived its agent, so there is no placement to notify and only the row goes. */
    agent: AgentRecord | null
  }
): Promise<void> {
  const { orgId, integration, agent } = args
  await deps.repos.integration.delete(orgId, integration.id)
  deps.recomputeDuties?.(orgId)
  // "Freed" means NO active install remains — a shareable bot may still serve others.
  const remaining = await deps.repos.integration.listForBot(integration.botId)
  if (remaining.length === 0) {
    await deps.repos.bot.markFreed(orgId, integration.botId, new Date(), agent?.name ?? null)
  }
  if (!agent) return
  // The row's own org rides the send: `integration/remove` carries only an id, so a
  // holder that never registered this integration has nothing to resolve.
  await deps.agentDelivery.integrationRemove(agent, integration.id, integration.orgId, (err, target) => {
    if (!(err instanceof NoConnection)) throw err
    log.debug({ integrationId: integration.id, daemonId: target }, 'integration/remove skipped: daemon offline')
  })
}

/**
 * Delete one bot identity and run the platform teardown the cascade cannot reach
 * (provider contract §9 `onBotDelete` — Linear's upstream grant revoke).
 *
 * The secret row is read BEFORE the delete cascades it away and the side effect runs
 * AFTER the row is gone, so a refused delete never tears down a live install's upstream
 * state. Best-effort by contract: a failing side effect is logged and the delete stands,
 * because the row is already gone and each platform owns a sweeper as its backstop.
 *
 * The caller owns authorization and the "no install remains" precondition.
 */
export async function deleteBotIdentity(deps: HttpDeps, log: TeardownLog, orgId: OrgId, bot: BotRecord): Promise<void> {
  const onBotDelete = deps.platforms.get(bot.platform)?.sideEffects?.onBotDelete
  const secrets = onBotDelete ? await deps.repos.botSecret.get(orgId, bot.id) : null
  await deps.repos.bot.delete(orgId, bot.id)
  if (!onBotDelete) return
  try {
    await onBotDelete(bot, secrets)
  } catch (err) {
    log.warn({ err, botId: bot.id, platform: bot.platform }, 'bot delete side effect failed')
  }
}
