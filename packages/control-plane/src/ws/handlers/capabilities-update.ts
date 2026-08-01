/**
 * `capabilities/update` handler — a fire-and-forget D→C EVT full-replacing the
 * connection's registered `RegisterReq.capabilities`.
 *
 * `register` computes the daemon's feature set before its reconcile roster is
 * applied and before its runtime probe sweep runs, so a feature derived from
 * either (e.g. `webchat_remote_mcp_v1`, gated on the synced builtin agent)
 * would otherwise stay hidden until the next reconnect. The live index is the
 * copy every hot gate reads (webchat verification, org-knowledge); the C4 row
 * is the durable sibling the console renders.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleCapabilitiesUpdate: Handler = async (frame, conn, deps) => {
  if (!isFrame('capabilities/update')(frame)) return
  const state = deps.connReg.get(conn.daemonId)
  if (state) state.capabilities = frame.payload.capabilities
  await deps.registry.updateCapabilities(DaemonId(conn.daemonId), frame.payload.capabilities)
}
