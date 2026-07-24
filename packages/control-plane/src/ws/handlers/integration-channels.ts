/**
 * `integration/channels` handler (per-channel trigger config).
 *
 * A fire-and-forget EVT (no reply). The daemon reports the FULL set of channels
 * an integration's bot is currently a member of (on socket start + every invite/
 * remove); the CP converges `integration_channel` to that snapshot (latest-wins,
 * idempotent), PRESERVING each stored channel's operator-chosen trigger. Channel
 * ids/names are control metadata — never message content (§1/§12). Every accepted
 * replacement also hot-pushes the derived collaboration routes so joins and
 * removals converge without waiting for reconnect.
 *
 * Scope check: the integration's owning agent must be placed on the REPORTING
 * daemon (the same daemon-scoped join as `register/ok.integrations[]`) — a daemon
 * can never write channel rows for another daemon's integration.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleIntegrationChannels: Handler = async (frame, conn, deps) => {
  if (!isFrame('integration/channels')(frame)) return
  const p = frame.payload
  const owned = await deps.integration.activeForDaemon(DaemonId(conn.daemonId))
  const integration = owned.find((i) => i.id === p.integrationId)
  if (!integration) return // unknown / just deleted / not this daemon's — drop silently
  const release = deps.agentMutations.tryBeginMutation(integration.agentId)
  if (!release) return // a placement move owns this agent; its authoritative bundle wins
  try {
    // Ownership may have changed while the first repository read was in flight.
    // Re-check under the shared mutation lease before accepting this daemon's
    // latest-wins snapshot, otherwise a late source event can overwrite target
    // channel metadata after a cold move.
    const current = await deps.integration.activeForDaemon(DaemonId(conn.daemonId))
    if (!current.some((candidate) => candidate.id === integration.id && candidate.agentId === integration.agentId)) {
      return
    }
    await deps.integrationChannel.replaceSnapshot(integration.id, p.channels)
  } finally {
    release()
  }

  // Membership is part of the effective agent-call edge. Refresh both relay and
  // daemon full-replace snapshots immediately after accepting a join/removal so
  // the data plane does not wait for an unrelated policy edit or reconnect.
  // Register baselines remain the durable backstop if this best-effort push fails.
  try {
    await deps.collabRoutes.broadcast(integration.orgId)
  } catch {
    // A later policy/placement change or reconnect rebuilds the snapshot.
  }
}
