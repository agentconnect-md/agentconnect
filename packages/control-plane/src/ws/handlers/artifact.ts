/** `artifact/*` (artifacts.md §5.3, §7): only a daemon placed on the agent publishes, fetches, lists or shares for it. */
import { isFrame, type AnyFrame } from '@agentconnect.md/protocol'
import { ArtifactRefusal, type ArtifactService } from '../../artifacts/service.js'
import { AgentId, type OrgId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'

type Authorized = { orgId: OrgId; agent: AgentRecord; artifacts: ArtifactService }

/** The org, the agent and the service, or null once a refusal was sent. */
async function authorize(
  frame: AnyFrame & { payload: { agentId: string } },
  conn: DaemonConnection,
  deps: DaemonWsDeps
): Promise<Authorized | null> {
  const orgId = frameOrgId(frame, conn)
  if (!orgId || !deps.artifacts) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'artifacts are not enabled on this deployment', false, {
      reason: 'not-enabled'
    })
    return null
  }
  // Publication and reach need current placement authority: a daemon that no longer serves the agent gets nothing.
  const agent = await deps.agent.get(orgId, AgentId(frame.payload.agentId))
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return null
  }
  return { orgId, agent, artifacts: deps.artifacts }
}

function sendFailure(conn: DaemonConnection, deps: DaemonWsDeps, frame: AnyFrame, err: unknown): void {
  if (err instanceof ArtifactRefusal) {
    conn.sendError(frame.id, err.code, err.message, err.retryable, { reason: err.reason, ...err.details })
    return
  }
  deps.log.error({ err, type: frame.type }, 'artifact frame failed')
  conn.sendError(frame.id, 'INTERNAL', 'the artifact request failed', true)
}

export const handleArtifactPublishBegin: Handler = async (frame, conn, deps) => {
  if (!isFrame('artifact/publish/begin')(frame)) return
  const ok = await authorize(frame, conn, deps)
  if (!ok) return
  try {
    conn.replyTo(frame, 'artifact/publish/begin/ok', await ok.artifacts.begin(ok.orgId, ok.agent, frame.payload))
  } catch (err) {
    sendFailure(conn, deps, frame, err)
  }
}

export const handleArtifactPublishComplete: Handler = async (frame, conn, deps) => {
  if (!isFrame('artifact/publish/complete')(frame)) return
  const ok = await authorize(frame, conn, deps)
  if (!ok) return
  try {
    conn.replyTo(frame, 'artifact/publish/complete/ok', await ok.artifacts.complete(ok.orgId, frame.payload))
  } catch (err) {
    sendFailure(conn, deps, frame, err)
  }
}

export const handleArtifactFetch: Handler = async (frame, conn, deps) => {
  if (!isFrame('artifact/fetch')(frame)) return
  const ok = await authorize(frame, conn, deps)
  if (!ok) return
  try {
    conn.replyTo(frame, 'artifact/fetch/ok', await ok.artifacts.fetch(ok.orgId, frame.payload))
  } catch (err) {
    sendFailure(conn, deps, frame, err)
  }
}

export const handleArtifactList: Handler = async (frame, conn, deps) => {
  if (!isFrame('artifact/list')(frame)) return
  const ok = await authorize(frame, conn, deps)
  if (!ok) return
  try {
    conn.replyTo(frame, 'artifact/list/ok', await ok.artifacts.list(ok.orgId, frame.payload))
  } catch (err) {
    sendFailure(conn, deps, frame, err)
  }
}

export const handleArtifactShare: Handler = async (frame, conn, deps) => {
  if (!isFrame('artifact/share')(frame)) return
  const ok = await authorize(frame, conn, deps)
  if (!ok) return
  try {
    conn.replyTo(frame, 'artifact/share/ok', await ok.artifacts.share(ok.orgId, frame.payload))
  } catch (err) {
    sendFailure(conn, deps, frame, err)
  }
}

export const handleArtifactUnshare: Handler = async (frame, conn, deps) => {
  if (!isFrame('artifact/unshare')(frame)) return
  const ok = await authorize(frame, conn, deps)
  if (!ok) return
  try {
    conn.replyTo(frame, 'artifact/unshare/ok', await ok.artifacts.unshare(ok.orgId, frame.payload))
  } catch (err) {
    sendFailure(conn, deps, frame, err)
  }
}
