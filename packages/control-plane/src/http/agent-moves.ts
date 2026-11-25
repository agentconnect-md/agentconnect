// The route's move service shares credential projectors with reconnect and duty activation.
import type { FastifyBaseLogger } from 'fastify'
import { AgentMoveService } from '../orchestrator/agentMove.js'
import type { HttpDeps } from './deps.js'
import { makeMcpAgentGrantMinter } from '../orchestrator/mcpAgentGrants.js'
import { serializeByProvider } from './provider-chain.js'

export function buildAgentMoves(deps: HttpDeps, log: FastifyBaseLogger): AgentMoveService {
  return new AgentMoveService({
    agents: deps.repos.agent,
    assignments: deps.repos.assignment,
    integrations: deps.repos.integration,
    integrationChannels: deps.repos.integrationChannel,
    bots: deps.repos.bot,
    botSecrets: deps.repos.botSecret,
    platforms: deps.platforms,
    specs: deps.agentSpecs,
    chatAuthority: deps.repos.session,
    crons: deps.repos.cron,
    mcp: {
      providers: deps.repos.mcpProvider,
      grants: deps.repos.mcpGrant,
      relayRoster: deps.relayRoster,
      policies: deps.repos.agentMcpToolPolicy,
      catalogs: deps.repos.mcpToolCatalog,
      mintAgentGrant: makeMcpAgentGrantMinter({
        grants: deps.repos.mcpGrant,
        policies: deps.repos.agentMcpToolPolicy,
        secrets: deps.repos.mcpProviderSecret,
        // Read at call time: the token service joins the deps after this service is built.
        get tokens() {
          return deps.mcpTokenResolver
        },
        relays: deps.relayControl,
        serialize: serializeByProvider
      })
    },
    memory: {
      connections: deps.repos.externalMemoryConnection,
      installations: deps.repos.memoryPluginInstallation,
      secrets: deps.repos.externalMemoryConnectionSecret,
      grants: deps.repos.externalMemoryGrant,
      relayRoster: deps.relayRoster
    },
    control: deps.control,
    hooks: deps.hooks,
    httpBot: deps.httpBot,
    collabRoutes: deps.collabRoutes,
    mutations: deps.agentMutations,
    sessionOwners: deps.sessionOwners,
    placement: deps.placementResolver,
    memberSets: deps.repos.memberSet,
    taskLocks: { sessions: deps.repos.session, stores: deps.repos.memberSet },
    liveness: deps.liveness,
    // Awaited, never the debounced kick: the target claims the agent's duty right after this returns.
    ...(deps.recomputeDutiesNow ? { recomputeDuties: deps.recomputeDutiesNow } : {}),
    log
  })
}
