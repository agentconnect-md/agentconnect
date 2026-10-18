import { isFrame, type AhpSessionListResult, type AhpSessionResult } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import type { Handler } from './index.js'
import { runForReportingAgent } from './reporting-agent.js'

export const handleAhpSession: Handler = async (frame, conn, deps) => {
  if (
    !isFrame('ahp/session/reserve')(frame) &&
    !isFrame('ahp/session/finalize')(frame) &&
    !isFrame('ahp/session/resolve')(frame) &&
    !isFrame('ahp/session/list')(frame)
  )
    return
  const { orgId, agentId } = frame.payload
  let result: AhpSessionResult | AhpSessionListResult = { ok: false, reason: 'unavailable' }
  if (conn.daemonId && deps.ahpSessions && (conn.orgId === null || conn.orgId === orgId)) {
    const daemonId = conn.daemonId
    try {
      await runForReportingAgent(OrgId(orgId), AgentId(agentId), DaemonId(daemonId), deps, async () => {
        if (isFrame('ahp/session/reserve')(frame)) result = await deps.ahpSessions!.reserve(frame.payload, daemonId)
        else if (isFrame('ahp/session/finalize')(frame))
          result = await deps.ahpSessions!.finalize(frame.payload, daemonId)
        else if (isFrame('ahp/session/resolve')(frame)) result = await deps.ahpSessions!.resolve(frame.payload)
        else if (isFrame('ahp/session/list')(frame)) result = await deps.ahpSessions!.list(frame.payload)
      })
    } catch {
      // Store/control loss cannot turn a retry into success or leak credential material in logs.
      result = { ok: false, reason: 'unavailable' }
    }
  }
  if (isFrame('ahp/session/list')(frame)) conn.replyTo(frame, 'ahp/session/list/ok', result as AhpSessionListResult)
  else if (isFrame('ahp/session/reserve')(frame))
    conn.replyTo(frame, 'ahp/session/reserve/ok', result as AhpSessionResult)
  else if (isFrame('ahp/session/finalize')(frame))
    conn.replyTo(frame, 'ahp/session/finalize/ok', result as AhpSessionResult)
  else conn.replyTo(frame, 'ahp/session/resolve/ok', result as AhpSessionResult)
}
