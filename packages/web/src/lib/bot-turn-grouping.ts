// Grouping identity for consecutive live bot steps in the session detail view
// (webchat-multi-agents.md §5.3): agent display names are NOT unique, so when
// both sides carry the lane-stamped `agentId` it is authoritative. The name
// comparison remains only for legacy untagged steps (pre-multi-agent daemons,
// locally pushed warning steps), which have nothing else to group by.

/** Stable block identity for one participant's output in a live webchat turn. */
export function liveBotTurnKey(turnId: string | undefined, agentId: string | undefined): string | undefined {
  return turnId ? `live:${turnId}:${agentId ?? ''}` : undefined
}

/** Whether a live step continues the previous bot block. */
export function sameBotSpeaker(
  prev: { agentId?: string | undefined; agentName: string },
  next: { agentId?: string | undefined; agentName: string }
): boolean {
  if (prev.agentId !== undefined && next.agentId !== undefined) return prev.agentId === next.agentId
  return prev.agentName === next.agentName
}
