// The merge-when-ready toggle's frame: the CP relays it and stores nothing (webchat-side-panels.md, M6).
import { AUTO_MERGE_SESSION_FEATURE, type AutoMergeSetReq } from '@agentconnect.md/protocol'

/** An arm names the session whose tier places its watcher only when that session is the watcher's agent's own and the daemon honours it; a disarm, like an older daemon, never gets one. */
export function autoMergeSetRequest(
  target: { agentId: string; repoFullName: string; prNumber: number },
  enabled: boolean,
  session: { id: string; agentId: string },
  features: readonly string[]
): AutoMergeSetReq {
  const placed = enabled && session.agentId === target.agentId && features.includes(AUTO_MERGE_SESSION_FEATURE)
  return { ...target, enabled, ...(placed ? { sessionId: session.id } : {}) }
}
