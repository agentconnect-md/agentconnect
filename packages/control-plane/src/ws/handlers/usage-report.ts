/**
 * `usage/report` handler (dashboard telemetry).
 *
 * A fire-and-forget EVT (no reply). The daemon meters each session's CUMULATIVE
 * token usage from the agent's ACP stream and reports it here; the CP upserts one
 * row per `(agentId, sessionId)` (latest-wins, idempotent) so the `/usage`
 * dashboard can aggregate real usage over time. Token counts + cost are metadata,
 * never the message stream (which stays daemon-local, §1/§12).
 * Reports are accepted only for agents currently placed on the authenticated
 * daemon.
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
    await deps.sessionUsage.record({
      sessionId: p.sessionId,
      agentId,
      platform: p.platform ?? null,
      channel: p.channel ?? null,
      ...(p.observedModel !== undefined ? { model: p.observedModel } : {}),
      lastActivityAt: new Date(p.lastActivityAt),
      usage: p.usage
    })
  })
}
