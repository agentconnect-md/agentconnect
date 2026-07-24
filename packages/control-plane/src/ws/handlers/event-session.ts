/**
 * `event/session` handler — session metadata sync (dashboard + deep links).
 *
 * A fire-and-forget EVT (no reply). Sessions are created on the Slack/Discord→
 * daemon path; the daemon reports each one's converged milestone here (start /
 * plan / problem / end + the sessionKey echo) and the CP upserts one `SessionMeta`
 * row per `sessionId` (latest-wins, idempotent). This is what makes a session
 * deep-link (`…/sessions/:id`) resolvable from CP-stored metadata, even when the
 * daemon is offline. Metadata only — list/detail fields and sessionKey echo —
 * never the message stream (that stays daemon-local, §1/§12).
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, LaunchId, SessionId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleEventSession: Handler = async (frame, conn, deps) => {
  if (!isFrame('event/session')(frame)) return
  const p = frame.payload
  await deps.session.recordMilestone({
    sessionId: SessionId(p.sessionId),
    ...(p.parentSessionId !== undefined ? { parentSessionId: SessionId(p.parentSessionId) } : {}),
    agentId: AgentId(p.agentId),
    ...(p.launchId !== undefined ? { launchId: LaunchId(p.launchId) } : {}),
    phase: p.phase,
    ...(p.platform !== undefined ? { platform: p.platform } : {}),
    ...(p.channel !== undefined ? { channel: p.channel } : {}),
    ...(p.thread !== undefined ? { thread: p.thread } : {}),
    ...(p.link !== undefined ? { link: p.link } : {}),
    ...(p.summary !== undefined ? { summary: p.summary } : {}),
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(p.lastActivityAt !== undefined ? { lastActivityAt: new Date(p.lastActivityAt) } : {}),
    ...(p.triggeredBy !== undefined ? { triggeredBy: p.triggeredBy } : {}),
    ...(p.channelName !== undefined ? { channelName: p.channelName } : {}),
    ...(p.triggeredByName !== undefined ? { triggeredByName: p.triggeredByName } : {}),
    ...(p.threadUrl !== undefined ? { threadUrl: p.threadUrl } : {}),
    ...(p.runtime !== undefined ? { runtime: p.runtime } : {}),
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.effort !== undefined ? { effort: p.effort } : {}),
    ...(p.fastMode !== undefined ? { fastMode: p.fastMode } : {}),
    ...(p.permissionMode !== undefined ? { permissionMode: p.permissionMode } : {}),
    ...(p.outputMode !== undefined ? { outputMode: p.outputMode } : {}),
    // The reporting daemon comes from the AUTHENTICATED connection, not the
    // frame payload — a daemon cannot attribute a session to another daemon.
    daemonId: DaemonId(conn.daemonId),
    at: new Date(p.ts)
  })
  // Publish only after the metadata commit. Browser subscribers use this as an
  // invalidation signal and immediately re-read `/sessions`; publishing first
  // would race that GET against the upsert and leave the new row invisible.
  deps.events.publish(DaemonId(conn.daemonId), p)
}
