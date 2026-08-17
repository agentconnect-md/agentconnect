/**
 * `usage/report` handler — the DAEMON adapter of the usage report interface.
 *
 * A fire-and-forget EVT (no reply). The daemon meters each session's CUMULATIVE
 * token usage from the agent's ACP stream and reports it here; the handler hands the
 * payload to the shared `UsageWriter` stamped `daemon`, which upserts one row per
 * `(agentId, sessionId)` (latest-wins, idempotent) so the `/usage` dashboard can
 * aggregate real usage over time. Token counts + cost are metadata, never the message
 * stream (which stays daemon-local, §1/§12).
 * Reports are accepted only for agents currently placed on the authenticated daemon.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'
import { runForReportingAgent } from './reporting-agent.js'

export const handleUsageReport: Handler = async (frame, conn, deps) => {
  if (!isFrame('usage/report')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) return
  const p = frame.payload
  const agentId = AgentId(p.agentId)
  await runForReportingAgent(orgId, agentId, DaemonId(conn.daemonId), deps, async () => {
    await deps.usageWriter.record('daemon', p)
  })
}
