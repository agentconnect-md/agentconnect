/**
 * `auth` → `auth/ok` handler (design §4.6, protocol §3.1).
 *
 * Verifies the daemon-token via the C4 `DaemonAuth` service, which on success
 * mints the next monotonic `sessionEpoch`. On failure the socket is closed
 * `4401` (no epoch bump, no registry entry). On success the connection advances
 * to REGISTERING, is indexed in the `ConnectionRegistry` (superseding — and
 * closing `4409` — any previous connection for the same daemon), and the
 * `auth/ok` REP (`corr` = the `auth` frame id) is sent.
 */
import { CloseCode, isFrame } from '@agentconnect.md/protocol'
import type { Handler } from './index.js'

export const handleAuth: Handler = async (frame, conn, deps) => {
  if (!isFrame('auth')(frame)) return // dispatch guarantees the type; narrow for payload typing
  const req = frame.payload

  const verdict = await deps.auth.authenticate(req, {
    remoteAddr: conn.remoteAddr,
    subprotocol: conn.transport.subprotocol
  })

  if (!verdict.ok) {
    conn.close(verdict.closeCode, verdict.reason)
    return
  }

  conn.daemonId = verdict.daemonId
  conn.orgId = verdict.orgId
  conn.setId = verdict.setId
  conn.sessionEpoch = verdict.okFrame.sessionEpoch
  conn.state = 'REGISTERING'

  // A re-auth supersedes any existing connection for this daemon (its epoch is
  // now stale). Close the old socket so it cannot keep feeding liveness for the
  // fresh entry; its close handler only removes the entry while it still owns it.
  const prev = deps.connReg.get(verdict.daemonId)
  if (prev && prev.conn !== conn) {
    prev.conn.close(CloseCode.EPOCH_CONFLICT, 'superseded by a newer connection')
  }

  deps.connReg.add({
    daemonId: verdict.daemonId,
    orgId: verdict.orgId,
    conn,
    sessionEpoch: verdict.okFrame.sessionEpoch,
    state: 'REGISTERING',
    maxAgents: 0,
    load: { cpu: 0, mem: 0, agents: 0 },
    health: 'ok',
    lastBeatAt: deps.clock.now(),
    reachable: true,
    assignments: new Set(),
    launches: new Map(),
    orgByAgent: new Map(),
    orgByIntegration: new Map(),
    orgByCron: new Map(),
    orgByMcpServer: new Map(),
    orgByMemoryConnection: new Map()
  })

  let okFrame = verdict.okFrame
  if (req.bootstrapProtocolVersion === 1) {
    await deps.lifecycleOps.expireOverdue(new Date(deps.clock.now()), verdict.daemonId)
    const op = await deps.lifecycleOps.pendingForDaemon(verdict.daemonId)
    if (op?.op === 'upgrade' && op.targetVersion) {
      // An already-target process may READY now; any other version must re-auth after install.
      const commandEpoch =
        req.agentVersion === op.targetVersion
          ? BigInt(Math.max(0, verdict.okFrame.sessionEpoch - 1))
          : BigInt(verdict.okFrame.sessionEpoch)
      await deps.lifecycleOps.markAccepted(op.id, new Date(deps.clock.now()), commandEpoch)
      okFrame = {
        ...okFrame,
        lifecycle: { operationId: op.id, action: 'upgrade', targetVersion: op.targetVersion }
      }
    }
  }

  conn.replyTo(frame, 'auth/ok', okFrame)
}
