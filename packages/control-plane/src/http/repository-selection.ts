// The Control Plane half of choosing repositories by decision (multi-repository-workspaces.md decisions 13–18).
import { REPO_SELECTOR_V1_FEATURE } from '@agentconnect.md/protocol'
import { dutyEligibility } from '../domain/placement.js'
import { OrgId } from '../domain/ids.js'
import type { DaemonView } from '../ports.js'
import type { AgentRecord } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'

/** The members of a set that could serve an agent right now. One read; reuse it for a page. */
export async function readySetMembers(
  deps: Pick<HttpDeps, 'registry' | 'repos' | 'liveness'>,
  orgId: OrgId,
  setId: string
): Promise<DaemonView[]> {
  const [daemons, memberIds] = await Promise.all([
    deps.registry.listAvailable(orgId),
    deps.repos.memberSet.memberIdsOf(setId)
  ])
  const members = new Set(memberIds)
  return daemons.filter((d) => {
    const live = deps.liveness.get(d.daemonId)
    return members.has(d.daemonId) && live?.reachable === true && live.state === 'READY'
  })
}

/** The daemons that would run the agent's sessions: its daemon, or every ready member of its group or the pool. */
async function placementDaemons(
  deps: Pick<HttpDeps, 'registry' | 'repos' | 'liveness'>,
  agent: AgentRecord
): Promise<DaemonView[]> {
  const eligibility = dutyEligibility(agent)
  if (eligibility.scope === 'none') return []
  if (eligibility.scope === 'set') return readySetMembers(deps, OrgId(agent.orgId), eligibility.setId)
  const daemon = await deps.registry.getAvailable(OrgId(agent.orgId), eligibility.daemonId)
  return daemon ? [daemon] : []
}

export interface DecisionMaterializeRefusal {
  message: string
  code: 'REPOSITORY_SELECTOR_MISSING' | 'DAEMON_FEATURE_MISSING'
}

/** Why a repository row or installation grant cannot be marked `decision`, or null when it can. */
export async function decisionMaterializeRefusal(
  deps: Pick<HttpDeps, 'registry' | 'repos' | 'liveness'>,
  agent: AgentRecord
): Promise<DecisionMaterializeRefusal | null> {
  if (!agent.repositorySelector) {
    return {
      code: 'REPOSITORY_SELECTOR_MISSING',
      message:
        'choosing repositories by decision needs a repository selector on the agent; set `repositorySelector` first'
    }
  }
  const daemons = await placementDaemons(deps, agent)
  if (daemons.length === 0) {
    return {
      code: 'DAEMON_FEATURE_MISSING',
      message: 'no daemon serving this agent is available to choose repositories by decision'
    }
  }
  if (daemons.some((daemon) => !daemon.capabilities.features.includes(REPO_SELECTOR_V1_FEATURE))) {
    return {
      code: 'DAEMON_FEATURE_MISSING',
      message: 'the daemon serving this agent cannot choose repositories by decision yet; upgrade it first'
    }
  }
  return null
}

/** Whether any of the agent's repository rows or installation grants is marked `decision`. */
export async function usesDecisionMaterialize(
  deps: Pick<HttpDeps, 'repos'>,
  agentId: AgentRecord['id']
): Promise<boolean> {
  const [rows, grants] = await Promise.all([
    deps.repos.agentRepoAuth.listForAgent(agentId),
    deps.repos.agentInstallationAuth.listForAgent(agentId)
  ])
  return [...rows, ...grants].some((entry) => entry.materialize === 'decision')
}
