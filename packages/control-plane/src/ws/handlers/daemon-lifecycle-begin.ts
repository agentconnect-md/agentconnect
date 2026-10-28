// `daemon/lifecycle/begin`: a READY daemon opens the record of an upgrade it chose itself (daemon-auto-upgrade.md §6).
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

/** Preparation, the 10-minute idle re-check and the relaunch, together. */
export const AUTO_UPGRADE_DEADLINE_MS = 30 * 60_000

const CONFLICT_MESSAGE = 'a restart or upgrade is already in progress'

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && Reflect.get(err, 'code') === 'P2002'

export const handleDaemonLifecycleBegin: Handler = async (frame, conn, deps) => {
  if (!isFrame('daemon/lifecycle/begin')(frame)) return
  if (conn.state !== 'READY') {
    conn.sendError(frame.id, 'PROTOCOL_STATE', `daemon/lifecycle/begin illegal in ${conn.state}`, false)
    return
  }
  const daemonId = DaemonId(conn.daemonId)
  const now = new Date(deps.clock.now())
  // Expire stale operations before the partial unique index admits another one.
  await deps.lifecycleOps.expireOverdue(now, daemonId)
  if (await deps.lifecycleOps.pendingForDaemon(daemonId)) {
    conn.sendError(frame.id, 'CONFLICT', CONFLICT_MESSAGE, true)
    return
  }
  try {
    // The daemon is both sender and acceptor, so the row opens armed at this connection's epoch.
    const op = await deps.lifecycleOps.open({
      daemonId,
      op: 'upgrade',
      trigger: 'auto',
      targetVersion: frame.payload.targetVersion,
      commandEpoch: BigInt(conn.sessionEpoch),
      acceptedAt: now,
      deadline: new Date(now.getTime() + AUTO_UPGRADE_DEADLINE_MS)
    })
    conn.replyTo(frame, 'daemon/lifecycle/begin/ok', { operationId: op.id })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    conn.sendError(frame.id, 'CONFLICT', CONFLICT_MESSAGE, true)
  }
}
