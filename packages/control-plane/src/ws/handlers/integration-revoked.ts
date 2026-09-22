// `integration/revoked`: a daemon-held socket saw the platform revoke its bot — the daemon twin of the relay's `rc/bot-revoked`.
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId, IntegrationId, type BotId, type OrgId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { BotRecord } from '../../persistence/ports.js'
import type { DaemonWsDeps } from '../deps.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

/** The socket bot behind one reported integration, or why this reporter may not revoke it. */
async function reportableBot(
  orgId: OrgId,
  integrationId: string,
  reporter: DaemonId,
  deps: DaemonWsDeps
): Promise<{ bot: BotRecord } | { refused: string }> {
  const integration = await deps.integration.get(orgId, IntegrationId(integrationId))
  if (!integration) return { refused: 'unknown integration' }
  const agent = await deps.agent.get(orgId, integration.agentId)
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, reporter))) {
    return { refused: 'integration is not served by this daemon' }
  }
  const bot = await deps.bot?.get(orgId, integration.botId)
  if (!bot || bot.transport !== 'socket' || !deps.socketBotRevocation?.accepts(bot.platform)) {
    return { refused: 'bot is not a daemon-socket bot of this platform' }
  }
  return { bot }
}

export const handleIntegrationRevoked: Handler = async (frame, conn, deps) => {
  if (!isFrame('integration/revoked')(frame)) return
  const revocation = deps.socketBotRevocation
  const orgId = frameOrgId(frame, conn)
  if (!revocation || !orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'integration revocation is not available', false)
    return
  }
  const p = frame.payload
  const reporter = DaemonId(conn.daemonId)
  let applied = false
  try {
    const bots = new Map<BotId, BotRecord>()
    for (const integrationId of new Set(p.integrationIds)) {
      const verdict = await reportableBot(orgId, integrationId, reporter, deps)
      if ('bot' in verdict) bots.set(verdict.bot.id, verdict.bot)
      else deps.log.warn?.({ integrationId, daemonId: reporter, why: verdict.refused }, 'integration/revoked: refused')
    }
    for (const bot of bots.values()) {
      // A re-install clears the stamp, so an already-revoked bot is this credential's settled revocation: nothing to write.
      if (bot.revokedAt || (await revocation.revoke(bot.id, p.reason, p.eventAtMs)).applied) applied = true
    }
  } catch (err) {
    // Retryable: the daemon keeps its report until a committed verdict comes back.
    deps.log.error({ err, daemonId: reporter }, 'integration/revoked: revocation failed')
    conn.sendError(frame.id, 'INTERNAL', 'integration revocation failed', true)
    return
  }
  conn.replyTo(frame, 'integration/revoked/ok', { applied })
}
