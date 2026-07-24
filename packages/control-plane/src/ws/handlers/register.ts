/**
 * `register` → `register/ok` handler (design §4.6, protocol §3.3).
 *
 * The convergence point: records capabilities (C4), then asks the C3 reconcile
 * service for the authoritative snapshot built from the C6 routing table. The
 * connection advances to READY (the only state in which the CP issues control),
 * the owned sessions are bound in the `ConnectionRegistry`, and the `register/ok`
 * REP (`corr` = the `register` frame id) is sent.
 *
 * Idempotent: re-sending `register` re-runs reconcile and yields the same
 * snapshot (CP wins all conflicts) — reconnect is convergence, not replay.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleRegister: Handler = async (frame, conn, deps) => {
  if (!isFrame('register')(frame)) return
  const req = frame.payload
  const did = DaemonId(conn.daemonId)

  await deps.registry.upsertOnRegister(did, req)
  const snap = await deps.orchestrator.reconcile(did, req)

  // Update the live index: capabilities/maxAgents + the bound session set.
  const state = deps.connReg.get(conn.daemonId)
  if (state) {
    state.capabilities = req.capabilities
    state.maxAgents = req.maxAgents
    state.state = 'READY'
    state.assignments.clear()
  }
  for (const a of snap.assignments) {
    deps.connReg.bindSession(a.sessionKey, conn.daemonId)
  }

  // Inject the current relay roster so the daemon converges to the relays it should
  // dial (shared-bot-relay.md §5). Hot changes ride the `relay/roster` EVT.
  const [relays, gitCommitIdentity] = await Promise.all([deps.relayRoster(), deps.github?.getGitCommitIdentity()])

  conn.state = 'READY'
  conn.replyTo(frame, 'register/ok', {
    ...snap,
    relays,
    ...(gitCommitIdentity ? { gitCommitIdentity } : {}),
    serverFeatures: ['hook-report-ack-v1', 'gitcred-actions-v1']
  })

  // Now that this connection has actually reached READY (reconcile succeeded above),
  // close any CP-commanded restart/upgrade op it was relaunching for (§7). Best-effort
  // — register/ok is already sent, so a settle failure must not disrupt registration.
  await deps.registry.settleLifecycleOpOnReady(did).catch(() => {})
}
