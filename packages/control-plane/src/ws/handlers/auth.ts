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
    conn,
    sessionEpoch: verdict.okFrame.sessionEpoch,
    state: 'REGISTERING',
    maxAgents: 0,
    load: { cpu: 0, mem: 0, agents: 0 },
    health: 'ok',
    lastBeatAt: deps.clock.now(),
    reachable: true,
    assignments: new Set(),
    launches: new Map()
  })

  conn.replyTo(frame, 'auth/ok', verdict.okFrame)
}
