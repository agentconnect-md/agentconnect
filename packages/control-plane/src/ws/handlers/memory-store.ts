// The `control-plane` memory home's D→C pairs (memory-evolution.md §3.2.1): a memory-fs op, a change-log batch, and the
// one-way migration's completion.
// Authorization mirrors `knowledge/search` (org from the frame or connection, agent served by THIS daemon), which is what makes
// the CP the write fence across daemons: a member that lost the duty gets `SCOPE_DENIED` instead of racing its successor.
import { randomUUID } from 'node:crypto'
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { HISTORY_RETENTION } from '../../agent-memory/limits.js'
import { normalizeMemoryHistoryRoot, toHistoryInput } from '../../agent-memory/history.js'
import { memoryHomedInControlPlane } from '../../agent-memory/home.js'
import { MemoryStorePathError, MemoryStoreTooLargeError } from '../../agent-memory/paths.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

type Verdict = { agent: AgentRecord } | { denied: string }

/** The agent an op may be served for: in the frame's org, served by this connection, and homed in the CP. */
async function homedAgent(
  frame: Parameters<Handler>[0],
  agentId: string,
  conn: Parameters<Handler>[1],
  deps: Parameters<Handler>[2]
): Promise<Verdict> {
  const orgId = frameOrgId(frame, conn)
  const agent = orgId ? await deps.agent.get(orgId, AgentId(agentId)) : null
  if (!agent) return { denied: 'agent is not served by this daemon' }
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  if (!(await resolver.mayAct(agent, conn.daemonId))) return { denied: 'agent is not served by this daemon' }
  // An older binding carries no `home`, which is `daemon`; only a resolved `control-plane` is served here.
  if (!memoryHomedInControlPlane(agent.memory)) return { denied: 'the agent memory home is not the Control Plane' }
  return { agent }
}

export const handleMemoryStore: Handler = async (frame, conn, deps) => {
  if (!isFrame('memory/store')(frame)) return
  const store = deps.agentMemoryStore
  if (!store) {
    conn.sendError(frame.id, 'INTERNAL', 'the memory home is unavailable', true)
    return
  }
  const verdict = await homedAgent(frame, frame.payload.agentId, conn, deps)
  if ('denied' in verdict) {
    conn.sendError(frame.id, 'SCOPE_DENIED', verdict.denied, false)
    return
  }
  try {
    conn.replyTo(frame, 'memory/store/ok', await store.apply(verdict.agent, frame.payload.op))
  } catch (err) {
    if (err instanceof MemoryStoreTooLargeError) {
      conn.sendError(frame.id, 'BAD_PAYLOAD', err.message, false)
      return
    }
    // A thrown handler closes the socket; a failed op is this one request's error, not the connection's.
    deps.log.error({ err, agentId: verdict.agent.id, op: frame.payload.op.op }, 'memory/store: op failed')
    conn.sendError(frame.id, 'INTERNAL', 'memory store operation failed', true)
  }
}

export const handleMemoryHistoryAppend: Handler = async (frame, conn, deps) => {
  if (!isFrame('memory/history/append')(frame)) return
  const history = deps.agentMemoryHistory
  if (!history) {
    conn.sendError(frame.id, 'INTERNAL', 'the memory home is unavailable', true)
    return
  }
  const verdict = await homedAgent(frame, frame.payload.agentId, conn, deps)
  if ('denied' in verdict) {
    conn.sendError(frame.id, 'SCOPE_DENIED', verdict.denied, false)
    return
  }
  const { agent } = verdict
  try {
    // The root is stored normalized (`./memory` is `memory`), so the console's read filter finds what the batch wrote.
    const root = normalizeMemoryHistoryRoot(frame.payload.root)
    const records = frame.payload.records.map((record) => toHistoryInput(record, record.id ?? randomUUID()))
    await history.append(agent.id, agent.orgId, root, records, HISTORY_RETENTION)
    conn.replyTo(frame, 'memory/history/append/ok', { accepted: true })
  } catch (err) {
    if (err instanceof MemoryStorePathError) {
      conn.sendError(frame.id, 'BAD_PAYLOAD', err.message, false)
      return
    }
    deps.log.error({ err, agentId: agent.id }, 'memory/history/append: batch failed')
    conn.sendError(frame.id, 'INTERNAL', 'memory history append failed', true)
  }
}

// The owning daemon finished the one-way `daemon` → `control-plane` copy: clear the flag the binding change set. The
// clear is atomic against the binding (`settleMemoryHomeMigration`), a home that moved on since is `CONFLICT`, and a
// report after the flag is already clear is the same success — a retried copy simply reports twice.
export const handleMemoryHomeMigrated: Handler = async (frame, conn, deps) => {
  if (!isFrame('memory/home/migrated')(frame)) return
  const verdict = await homedAgent(frame, frame.payload.agentId, conn, deps)
  if ('denied' in verdict) {
    conn.sendError(frame.id, 'SCOPE_DENIED', verdict.denied, false)
    return
  }
  const { agent } = verdict
  try {
    const outcome = await deps.agent.settleMemoryHomeMigration(agent.orgId, agent.id)
    if (outcome === 'cleared') {
      conn.replyTo(frame, 'memory/home/migrated/ok', { accepted: true })
      return
    }
    conn.sendError(frame.id, 'CONFLICT', 'the agent memory home is no longer the Control Plane', false)
  } catch (err) {
    deps.log.error({ err, agentId: agent.id }, 'memory/home/migrated: settle failed')
    conn.sendError(frame.id, 'INTERNAL', 'memory home migration could not be recorded', true)
  }
}
