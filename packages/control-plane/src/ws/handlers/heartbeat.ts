/**
 * `heartbeat` handler (design §4.6, protocol §7.1).
 *
 * A fire-and-forget EVT (no reply). Updates the daemon's liveness in the
 * in-memory `ConnectionRegistry` (load / health / `lastBeatAt`) and persists the
 * snapshot via the C4 registry service. The watchdog (Phase 3) consumes
 * `lastBeatAt`; here we just keep it fresh.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleHeartbeat: Handler = async (frame, conn, deps) => {
  if (!isFrame('heartbeat')(frame)) return
  const hb = frame.payload
  const did = DaemonId(conn.daemonId)

  const state = deps.connReg.get(conn.daemonId)
  if (state) {
    state.load = hb.load
    state.health = hb.health
    state.lastBeatAt = deps.clock.now()
    state.reachable = true
  }

  // Duty lease exchange (k8s daemons; frames/duty.ts): renewal is the heartbeat,
  // grants and revocations ride back as EVTs on the same connection. Install-wide
  // (frame-mode) connections only — duty groups span orgs, so an org-scoped
  // daemon's `duties` is dropped rather than let it claim other orgs' members.
  // Started BEFORE any await: the service's per-daemon lane is reserved
  // synchronously, so a duty/release dispatched after this beat queues behind
  // its exchange — ledger operations keep the daemon's frame order.
  const lease =
    hb.duties && conn.orgId === null
      ? deps.dutyLease.onHeartbeat(did, hb.duties, (type, payload) =>
          conn.send(type, payload, state ? { epoch: state.sessionEpoch } : undefined)
        )
      : undefined

  await deps.registry.recordHeartbeat(did, hb)
  if (lease) await lease
}
