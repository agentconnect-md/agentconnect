/**
 * The one `AgentMoveService` wiring, shared by every route that moves runtime authority.
 *
 * It was assembled inline in `routes/agents.ts`, which was fine while agent placement was the only
 * caller. Group enrolment is the second (daemon-groups.md §3): enrolling a machine that still has
 * pinned agents IS the move convention, run once per agent, so it needs the same graph — and a
 * second hand-built copy of an eighteen-dependency bundle is a copy that drifts.
 */
import type { FastifyBaseLogger } from 'fastify'
import { AgentMoveService } from '../orchestrator/agentMove.js'
import type { HttpDeps } from './deps.js'

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
    crons: deps.repos.cron,
    control: deps.control,
    hooks: deps.hooks,
    httpBot: deps.httpBot,
    collabRoutes: deps.collabRoutes,
    mutations: deps.agentMutations,
    sessionOwners: deps.sessionOwners,
    placement: deps.placementResolver,
    memberSets: deps.repos.memberSet,
    memberSetWrites: deps.repos.memberSet,
    liveness: deps.liveness,
    ...(deps.recomputeDuties ? { recomputeDuties: deps.recomputeDuties } : {}),
    log
  })
}
