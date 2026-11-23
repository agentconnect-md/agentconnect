// `history-retention/confirm` handler — a sweep re-confirms its orgs' history retention before it reclaims under it (org-session-policy.md, Reclaim).
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import { servedAgents } from '../../orchestrator/servedAgents.js'
import type { Handler } from './index.js'

export const handleHistoryRetentionConfirm: Handler = async (frame, conn, deps) => {
  if (!isFrame('history-retention/confirm')(frame)) return
  if (!deps.orgHistoryRetention) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'history retention is unavailable on this control plane', false)
    return
  }
  const asked = [...new Set(frame.payload.orgIds)]
  try {
    // Only orgs this daemon serves an agent in, by the same union its roster ships; a connection-scoped daemon only its own org.
    const { agents } = await servedAgents(DaemonId(conn.daemonId), {
      agents: deps.agent,
      ...(deps.dutyLease ? { duties: deps.dutyLease } : {}),
      now: new Date(deps.clock.now())
    })
    const served = new Set<string>(
      agents.map((agent) => agent.orgId as string).filter((orgId) => conn.orgId === null || orgId === conn.orgId)
    )
    const allowed = asked.filter((orgId) => served.has(orgId))
    const rows = await deps.orgHistoryRetention.historyRetention(allowed)
    const withPolicy = new Set(rows.map((row) => row.orgId))
    conn.replyTo(frame, 'history-retention/confirm/result', {
      entries: rows.map((row) => ({
        orgId: row.orgId,
        revision: row.revision,
        historyRetentionDays: row.historyRetentionDays
      })),
      noPolicy: allowed.filter((orgId) => !withPolicy.has(orgId)),
      denied: asked.filter((orgId) => !served.has(orgId))
    })
  } catch (err) {
    deps.log.error({ err, daemonId: conn.daemonId }, 'history-retention/confirm: read failed')
    conn.sendError(frame.id, 'INTERNAL', 'history retention could not be read', true)
  }
}
