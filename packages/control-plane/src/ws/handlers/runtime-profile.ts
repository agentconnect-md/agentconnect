/**
 * `facts/runtime-profile` handler (design §3.4, §3.14; protocol §7.3).
 *
 * DEPRECATED compat path: current daemons report the full snapshot via
 * `facts/daemon-runtimes` (replace semantics — see `daemon-runtimes.ts`); this
 * per-runtime upsert is kept only so older daemons in the field keep working.
 *
 * A fire-and-forget EVT (no reply). Persists the daemon's observed runtime
 * capabilities — version, available `models[]`, context window, ACP coverage —
 * via the C4 registry (upsert on `(daemonId, runtime)`). The fleet read model
 * (`GET /daemons`) surfaces these so the console can offer per-machine model
 * choices without probing the harness.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleRuntimeProfile: Handler = async (frame, conn, deps) => {
  if (!isFrame('facts/runtime-profile')(frame)) return
  await deps.registry.recordRuntimeProfile(DaemonId(conn.daemonId), frame.payload)
}
