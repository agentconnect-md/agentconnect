/** `facts/memory-connections` — revision-fenced, metadata-only probe facts. */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleMemoryConnections: Handler = async (frame, conn, deps) => {
  if (!isFrame('facts/memory-connections')(frame)) return
  const connections = deps.externalMemoryConnection
  if (!connections) return

  // Facts are metadata-only, but they still drive the static admission status
  // shown in the console. A revision fence alone is not an ownership check: a
  // daemon that learned another org's UUID could otherwise poison that
  // connection's status. Restrict the accepted set to definitions currently
  // placed on this authenticated daemon, matching every other daemon-originated
  // fact handler's ownership boundary.
  const allowed = new Set(
    (await connections.activeForDaemon(DaemonId(conn.daemonId))).map((connection) => connection.id)
  )
  await Promise.all(
    frame.payload.connections.map((fact) => {
      if (!allowed.has(fact.connectionId)) return Promise.resolve(false)
      return connections.updateProbeFact(fact.connectionId, fact.revision, {
        status: fact.status,
        ...(fact.version !== undefined ? { pluginVersion: fact.version } : {}),
        ...(fact.profile !== undefined ? { profile: fact.profile } : {}),
        ...(fact.manifestDigest !== undefined ? { manifestDigest: fact.manifestDigest } : {}),
        ...(fact.capabilities !== undefined ? { capabilities: fact.capabilities } : {}),
        ...(fact.declaredEgressHosts !== undefined ? { declaredEgressHosts: fact.declaredEgressHosts } : {}),
        ...(fact.reasonCode !== undefined ? { reasonCode: fact.reasonCode } : {})
      })
    })
  )
}
