/**
 * `usage/report` handler (dashboard telemetry).
 *
 * A fire-and-forget EVT (no reply). The daemon meters each session's CUMULATIVE
 * token usage from the agent's ACP stream and reports it here; the CP upserts one
 * row per `(agentId, sessionId)` (latest-wins, idempotent) so the `/usage`
 * dashboard can aggregate real usage over time. Token counts + cost are metadata,
 * never the message stream (which stays daemon-local, §1/§12).
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleUsageReport: Handler = async (frame, _conn, deps) => {
  if (!isFrame('usage/report')(frame)) return
  const p = frame.payload
  await deps.sessionUsage.record({
    sessionId: p.sessionId,
    agentId: AgentId(p.agentId),
    platform: p.platform ?? null,
    channel: p.channel ?? null,
    lastActivityAt: new Date(p.lastActivityAt),
    usage: p.usage
  })
}
