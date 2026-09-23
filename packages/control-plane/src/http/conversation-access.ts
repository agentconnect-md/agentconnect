import type { FastifyRequest } from 'fastify'
import type { DecisionEvaluationConversation } from '@agentconnect.md/protocol'
import { canEdit, canView, canViewSession } from '../authorization/policy.js'
import { IntegrationId, type AgentId } from '../domain/ids.js'
import type {
  AgentRecord,
  BotRecord,
  IntegrationChannelRecord,
  IntegrationRecord,
  ViewCtx
} from '../persistence/ports.js'
import { gateConsumer } from './decision-access.js'
import type { HttpDeps } from './deps.js'
import { ctxOf, orgOf } from './rbac.js'
import { makeSessionAccessResolver } from './session-access.js'

export interface ReadableConversation {
  integration: IntegrationRecord
  consumer: { agent: AgentRecord; integration: IntegrationRecord; row: IntegrationChannelRecord }
  row: IntegrationChannelRecord
  bot: BotRecord
  viewer: ViewCtx
  /** The agents whose sessions name the conversation's audience; the consumer alone when absent. */
  audienceAgentIds?: readonly AgentId[]
}

/** The session-independent half of a conversation read (role, install, agent and consumer visibility, row kind); null is a 404. */
export async function readableConversation(
  deps: HttpDeps,
  req: FastifyRequest,
  integrationId: string,
  channelId: string
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
  return { integration, consumer, row, bot, viewer }
}

/** A routed conversation of a shared bot (role, a visible bot agent, a group row); any bot agent's session names its audience. */
export async function readableRoutedConversation(
  deps: HttpDeps,
  req: FastifyRequest,
  bot: BotRecord,
  channelId: string
): Promise<ReadableConversation | null> {
  const orgId = orgOf(req)
  // The role is re-read, so a member removed mid-read loses access at the next check.
  const role = await deps.repos.org.roleOf(orgId, ctxOf(req).userId)
  if (!role) return null
  const viewer = { ...ctxOf(req), role }
  const [fresh, installs, rows] = await Promise.all([
    deps.repos.bot.get(orgId, bot.id),
    deps.repos.integration.listForBot(bot.id),
    deps.repos.integrationChannel.listForBot(bot.id)
  ])
  if (!fresh) return null
  const agents = await Promise.all(fresh.agentIds.map((id) => deps.repos.agent.get(orgId, id)))
  if (!agents.some((agent) => agent && canView(agent, viewer))) return null
  const conversation = rows.filter((row) => row.channelId === channelId)
  if (conversation.length === 0 || conversation.some((row) => row.kind === 'im')) return null
  const install = installs[0]
  if (!install) return null
  const consumer = await gateConsumer(deps, orgId, install, fresh, channelId)
  if (!consumer) return null
  return {
    integration: consumer.integration,
    consumer,
    row: consumer.row,
    bot: fresh,
    viewer,
    audienceAgentIds: fresh.agentIds
  }
}

/** The transcript audience of the newest top-level session in the daemon-named namespace, checked before a reply is returned. */
export async function conversationAudienceAllows(
  deps: HttpDeps,
  req: FastifyRequest,
  conversation: ReadableConversation,
  namespace: DecisionEvaluationConversation,
  opts: { bodies?: boolean } = {}
): Promise<boolean> {
  const orgId = orgOf(req)
  const { viewer, consumer } = conversation
  const session = await deps.repos.session.latestConversationSession(
    orgId,
    conversation.audienceAgentIds ?? [consumer.agent.id],
    {
      ...namespace,
      channel: conversation.row.channelId
    }
  )
  if (session) {
    const access = await makeSessionAccessResolver(deps).forSessions(req, [session])
    return canViewSession(session, viewer, access.identitySet, access.externalAccess)
  }
  // No session names an audience yet: an active external-access policy fails closed; otherwise the org baseline holds for summaries.
  const providers = (deps.sessionAccessPlugins ?? []).filter((plugin) => plugin.available)
  const policies = await Promise.all(
    providers.map((plugin) => deps.repos.session.getExternalAccessPolicy(orgId, plugin.provider))
  )
  if (policies.some((policy) => policy !== null && policy.state !== 'disabled')) return false
  // Frozen bodies with no session audience need edit rights on the consumer agent, not the org read baseline.
  return !opts.bodies || canEdit(consumer.agent, viewer)
}
