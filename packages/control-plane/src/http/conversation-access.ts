import type { FastifyRequest } from 'fastify'
import { canEdit, canView, canViewSession } from '../authorization/policy.js'
import { IntegrationId } from '../domain/ids.js'
import type { AgentRecord, BotRecord, IntegrationChannelRecord, IntegrationRecord } from '../persistence/ports.js'
import { gateConsumer } from './decision-access.js'
import type { HttpDeps } from './deps.js'
import { ctxOf, orgOf } from './rbac.js'
import { makeSessionAccessResolver } from './session-access.js'

export interface ReadableConversation {
  integration: IntegrationRecord
  consumer: { agent: AgentRecord; integration: IntegrationRecord; row: IntegrationChannelRecord }
  row: IntegrationChannelRecord
  bot: BotRecord
}

/** A group conversation the caller may read, with the same session audience as a transcript read; null is a 404. */
export async function readableConversation(
  deps: HttpDeps,
  req: FastifyRequest,
  integrationId: string,
  channelId: string,
  opts: { bodies?: boolean } = {}
): Promise<ReadableConversation | null> {
  const orgId = orgOf(req)
  // The role is re-read, so a member removed mid-read loses access at the next check.
  const role = await deps.repos.org.roleOf(orgId, ctxOf(req).userId)
  if (!role) return null
  const viewer = { ...ctxOf(req), role }
  const integration = await deps.repos.integration.get(orgId, IntegrationId(integrationId))
  if (!integration) return null
  const [agent, bot, rows] = await Promise.all([
    deps.repos.agent.get(orgId, integration.agentId),
    deps.repos.bot.get(orgId, integration.botId),
    deps.repos.integrationChannel.listForIntegration(integration.id)
  ])
  if (!agent || !canView(agent, viewer) || !bot) return null
  const row = rows.find((candidate) => candidate.channelId === channelId)
  if (!row || row.kind === 'im') return null
  const consumer = await gateConsumer(deps, orgId, integration, bot, channelId)
  if (!consumer || !canView(consumer.agent, viewer)) return null
  const session = await deps.repos.session.latestConversationSession(orgId, consumer.agent.id, channelId)
  if (session) {
    const access = await makeSessionAccessResolver(deps).forSessions(req, [session])
    if (!canViewSession(session, viewer, access.identitySet, access.externalAccess)) return null
  } else {
    // No session names an audience yet: an active external-access policy fails closed; otherwise the org baseline holds for summaries.
    const providers = (deps.sessionAccessPlugins ?? []).filter((plugin) => plugin.available)
    const policies = await Promise.all(
      providers.map((plugin) => deps.repos.session.getExternalAccessPolicy(orgId, plugin.provider))
    )
    if (policies.some((policy) => policy !== null && policy.state !== 'disabled')) return null
    // Frozen bodies with no session audience need edit rights on the consumer agent, not the org read baseline.
    if (opts.bodies && !canEdit(consumer.agent, viewer)) return null
  }
  return { integration, consumer, row, bot }
}
