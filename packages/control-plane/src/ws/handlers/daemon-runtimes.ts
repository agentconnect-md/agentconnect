/**
 * `facts/daemon-runtimes` handler (protocol §7.3a).
 *
 * A fire-and-forget EVT (no reply) carrying the daemon's FULL runtime snapshot,
 * emitted once its background probe sweep completes. Replace semantics: the C4
 * registry reconciles the stored runtime list to exactly this snapshot — every
 * entry upserted, absent runtimes pruned — so the console never keeps offering
 * a runtime that was uninstalled from the machine. The daemon-level `mcpServers`
 * list (name + transport, from config) rides the same frame with the same
 * semantics (replaced whole).
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleDaemonRuntimes: Handler = async (frame, conn, deps) => {
  if (!isFrame('facts/daemon-runtimes')(frame)) return
  // `seq` fences snapshot ordering: frames are dispatched without awaiting, so a
  // sweep frame and a catalog frame can commit out of order — the registry drops
  // any snapshot older than the last applied one (absent ⇒ latest-commit-wins).
  await deps.registry.replaceRuntimeProfiles(
    DaemonId(conn.daemonId),
    frame.payload.runtimes,
    frame.payload.mcpServers,
    frame.payload.seq
  )
}
