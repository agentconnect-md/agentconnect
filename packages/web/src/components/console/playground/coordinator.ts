// auto-session-mode.md §10: the console home and playground open the member's private coordinator conversation with an agent.
import { prewarmAgent } from '@/lib/api'
import { agentCapabilitySource, isPoolPlacementKind, type Agent, type DaemonRow, type MemberSetRow } from '@/lib/data'
import { autoSessionModeSupported } from '@/lib/session-mode'
import { protocolFor } from './selector'

/** Whether opening this agent enters the member's coordinator: its coordinator is on, its daemon reads Auto and its webchat runs the legacy protocol. */
export function opensCoordinator(
  agent: Agent,
  daemons: readonly DaemonRow[],
  memberSets: readonly Pick<MemberSetRow, 'setId'>[]
): boolean {
  return (
    !agent.coordinatorDisabled &&
    autoSessionModeSupported(agentCapabilitySource(agent, daemons, memberSets)?.caps?.features) &&
    protocolFor([agent]) === 'legacy'
  )
}

/** How long one console prewarm of an agent stands before opening it again asks again. */
export const COORDINATOR_PREWARM_REPEAT_MS = 60_000

const lastPrewarm = new Map<string, number>()

/** Whether opening the console on this agent prewarms it: only an agent on the pool runs in a sandbox the console may start (auto-session-mode.md §4.9). */
export function prewarmsOnOpen(agent: Pick<Agent, 'placementKind' | 'setId'>, orgSetIds: ReadonlySet<string>): boolean {
  return isPoolPlacementKind(agent.placementKind, agent.setId, orgSetIds)
}

/** Wake the agent's sandbox and start the member's coordinator host, at most once a minute per agent and never from a hidden page (auto-session-mode.md §4.9). */
export function prewarmAgentOnOpen(
  agentId: string,
  now: number = Date.now(),
  send: (agentId: string) => Promise<unknown> = prewarmAgent
): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const last = lastPrewarm.get(agentId)
  if (last !== undefined && now - last < COORDINATOR_PREWARM_REPEAT_MS) return
  lastPrewarm.set(agentId, now)
  // Best effort: a refusal (an unfunded org, an offline pool) only means the first message starts cold.
  void send(agentId).catch(() => undefined)
}
