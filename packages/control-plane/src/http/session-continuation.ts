import {
  originKindOf,
  WEBCHAT_HOOK_CONTINUATION_FEATURE,
  WEBCHAT_SESSION_CONTINUATION_FEATURE
} from '@agentconnect.md/protocol'
import { servesSessionContent } from '../domain/session-content.js'
import type { ResolvableAgent } from '../orchestrator/placementResolver.js'
import type { HttpDeps } from './deps.js'

/** Why no daemon can host a session continuation right now — the detail view's reason vocabulary. */
export type ContinuationHostRefusal = 'agent_moved' | 'daemon_offline' | 'unavailable'

export type ContinuationHost = { ok: true; daemonId: string } | { ok: false; reason: ContinuationHostRefusal }

/** The ONE answer to "which daemon continues this session" — the detail projection (`canContinue`) and the session-target mint both read it, so they cannot disagree. The daemon a turn reaches (`dispatchDaemon`) must be the recorder or a holder of the shared store the rows went to (`domain/session-content.ts`); keying on `session.daemonId` alone read as "agent moved" for every pooled agent once its recorder pod rolled. */
export async function resolveContinuationHost(
  deps: Pick<HttpDeps, 'placementResolver' | 'daemonConns' | 'repos' | 'config'>,
  session: { platform: string | null; daemonId: string | null; contentSetId: string | null },
  agent: ResolvableAgent
): Promise<ContinuationHost> {
  const daemonId = await deps.placementResolver.dispatchDaemon(agent)
  // A machine placement always names its daemon; only a set with no live member resolves to nobody.
  if (!daemonId) return { ok: false, reason: 'daemon_offline' }
  const sharedStoreMembers = session.contentSetId
    ? await deps.repos.memberSet.sharedStoreMemberIdsOf(session.contentSetId)
    : []
  if (!servesSessionContent({ recordedDaemonId: session.daemonId, sharedStoreMembers }, daemonId)) {
    return { ok: false, reason: 'agent_moved' }
  }
  const daemon = deps.daemonConns.get(daemonId)
  if (daemon?.state !== 'READY') return { ok: false, reason: 'daemon_offline' }
  if (!daemon.capabilities?.features?.includes(WEBCHAT_SESSION_CONTINUATION_FEATURE)) {
    return { ok: false, reason: 'unavailable' }
  }
  // A hook-origin session runs console-only — no mirror, no platform connection — a strictly newer daemon behavior than the chat continuation the bit above gates (§9).
  if (
    originKindOf(session.platform ?? '') === 'hook' &&
    !daemon.capabilities.features.includes(WEBCHAT_HOOK_CONTINUATION_FEATURE)
  ) {
    return { ok: false, reason: 'unavailable' }
  }
  if (!deps.config.PUBLIC_RELAY_URL) return { ok: false, reason: 'unavailable' }
  // Fail-closed rollout: EVERY live relay behind the public pool must preserve targetSessionId.
  const alive = await deps.repos.relay.listAlive(new Date(Date.now() - (deps.config.RELAY_STALE_MS ?? 45_000)))
  if (alive.length === 0 || alive.some((r) => !r.features.includes(WEBCHAT_SESSION_CONTINUATION_FEATURE))) {
    return { ok: false, reason: 'unavailable' }
  }
  return { ok: true, daemonId }
}
