// auto-session-mode.md §10: the console home and playground open the member's private coordinator conversation with an agent.
import { agentCapabilitySource, type Agent, type DaemonRow, type MemberSetRow } from '@/lib/data'
import { autoSessionModeSupported } from '@/lib/session-mode'
import { protocolFor } from './selector'

/** Whether opening this agent enters the member's coordinator: its daemon reads Auto and its webchat runs the legacy protocol. */
export function opensCoordinator(
  agent: Agent,
  daemons: readonly DaemonRow[],
  memberSets: readonly Pick<MemberSetRow, 'setId'>[]
): boolean {
  return (
    autoSessionModeSupported(agentCapabilitySource(agent, daemons, memberSets)?.caps?.features) &&
    protocolFor([agent]) === 'legacy'
  )
}
