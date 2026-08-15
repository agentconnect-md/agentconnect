/** `facts/memory-connections` — revision-fenced, metadata-only probe facts. */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import { servedAgents } from '../../orchestrator/servedAgents.js'
import type { Handler } from './index.js'

export const handleMemoryConnections: Handler = async (frame, conn, deps) => {
  if (!isFrame('facts/memory-connections')(frame)) return
  const connections = deps.externalMemoryConnection
  if (!connections) return

  // Facts are metadata-only, but they still drive the static admission status
  // shown in the console. A revision fence alone is not an ownership check: a
  // daemon that learned another org's UUID could otherwise poison that
  // connection's status. The accepted set is therefore the connections bound by
  // the agents this daemon SERVES — the same `pinned-to-me ∪ duties I hold` union
  // the roster ships those definitions under, so a duty holder can report on what
  // it was given and on nothing else.
  const { agents } = await servedAgents(DaemonId(conn.daemonId), {
    agents: deps.agent,
    ...(deps.dutyLease ? { duties: deps.dutyLease } : {}),
    now: new Date(deps.clock.now())
  })
  const allowed = new Set(
    agents.flatMap((agent) =>
      agent.memory?.provider === 'external' && agent.memory.connectionId ? [agent.memory.connectionId] : []
    )
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
