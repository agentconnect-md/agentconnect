// auto-session-mode.md §10: the console home and playground open the member's private coordinator conversation with an agent.
import { openCoordinatorConversation, prewarmAgent } from '@/lib/api'
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

type OpenPlayground = (
  agent: Agent,
  members?: Agent[],
  options?: { conversationId?: string; coordinator?: boolean }
) => string

/** The session the agent's Playground opens on: the member's coordinator session once it has one, else a fresh playground session. */
export async function openAgentPlayground(input: {
  agent: Agent
  orgId: string | undefined
  coordinator: boolean
  prewarm: boolean
  openPlayground: OpenPlayground
}): Promise<string> {
  const { agent, orgId, openPlayground } = input
  if (!orgId || !input.coordinator) return openPlayground(agent)
  if (input.prewarm) prewarmAgentOnOpen(agent.id)
  const entry = await openCoordinatorConversation(orgId, agent.id).catch(() => undefined)
  return (
    entry?.sessionId ??
    openPlayground(agent, undefined, entry ? { conversationId: entry.conversationId, coordinator: true } : undefined)
  )
}

/** The agent a playground session id was minted for (`pg_<agentId>_<uuid>`), or undefined for any other id. */
export function playgroundAgentId(sessionId: string): string | undefined {
  if (!sessionId.startsWith('pg_')) return undefined
  const end = sessionId.lastIndexOf('_')
  return end > 3 ? sessionId.slice(3, end) : undefined
}
