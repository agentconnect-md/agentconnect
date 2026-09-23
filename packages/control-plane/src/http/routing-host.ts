import type { AgentRecord, BotRecord, IntegrationRecord } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import { orgOf } from './rbac.js'
import type { FastifyRequest } from 'fastify'

export interface RoutingHostMember {
  agent: AgentRecord
  integration: IntegrationRecord
}

/** The bot's members a routing host daemon serves, each with its bot install; the preferred agent comes first. */
export async function routingHostMembers(
  deps: Pick<HttpDeps, 'repos' | 'placementResolver'>,
  req: FastifyRequest,
  bot: Pick<BotRecord, 'id'>,
  daemonId: string,
  preferAgentId?: string | null
): Promise<RoutingHostMember[]> {
  const installs = (await deps.repos.integration.listForBot(bot.id)).filter((i) => i.status !== 'revoked')
  const members: RoutingHostMember[] = []
  for (const integration of installs) {
    if (members.some((m) => m.agent.id === integration.agentId)) continue
    const agent = await deps.repos.agent.get(orgOf(req), integration.agentId)
    if (!agent || !(await deps.placementResolver.servingDaemons(agent)).includes(daemonId)) continue
    members.push({ agent, integration })
  }
  return preferAgentId
    ? [...members.filter((m) => m.agent.id === preferAgentId), ...members.filter((m) => m.agent.id !== preferAgentId)]
    : members
}
