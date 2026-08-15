/** Full external-memory binding replay to one freshly registered relay. */
import type {
  AgentRepo,
  ExternalMemoryConnectionRecord,
  ExternalMemoryConnectionRepo,
  ExternalMemoryConnectionSecretStore,
  ExternalMemoryGrantRepo,
  MemoryPluginInstallationRepo
} from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import type { RelayChannel } from '../ws/relay-registry.js'
import type { AgentDelivery } from './agentDelivery.js'
import type { ControlSender } from './outbound.js'
import { memoryConnectionSpec, memoryRcAssign, stdioMemoryConnectionSpec } from './memoryConnection.js'

export interface MemoryConnectionReplayDeps {
  connections: ExternalMemoryConnectionRepo
  installations: MemoryPluginInstallationRepo
  secrets: ExternalMemoryConnectionSecretStore
  grants: ExternalMemoryGrantRepo
  log?: { warn(obj: object, msg: string): void }
}

export interface MemoryConnectionDaemonSyncDeps extends MemoryConnectionReplayDeps {
  agents: AgentRepo
  /** The one resolver of a definition's delivery set — placement ∪ duty holders. */
  delivery: Pick<AgentDelivery, 'daemonsForAgents'>
  control: Pick<ControlSender, 'memoryConnectionUpsert'>
}

export async function replayMemoryConnectionsTo(
  channel: RelayChannel,
  deps: MemoryConnectionReplayDeps
): Promise<void> {
  for (const connection of await deps.connections.listAll()) {
    try {
      const installation = await deps.installations.get(connection.installationId)
      if (!installation || installation.transport !== 'streamable-http' || !installation.endpoint) continue
      const grants = await deps.grants.activeForConnection(connection.orgId, connection.id)
      if (grants.length === 0) continue
      const secrets = (await deps.secrets.get(connection.orgId, connection.id)) ?? {}
      channel.send(
        'rc/memoryconnection-assign',
        memoryRcAssign(
          connection,
          installation,
          secrets,
          grants.map((grant) => grant.key)
        )
      )
    } catch {
      // Error text can contain a secret-store/provider detail. Log only the opaque id.
      deps.log?.warn({ connectionId: connection.id }, 'memory connection replay failed — skipped')
    }
  }
}

/**
 * Re-project every bound connection after the selected relay changes or the first
 * relay appears. Without this hot sync, an agent bound while the relay pool was
 * empty would remain unprobed until its daemon reconnected.
 *
 * Driven from the CONNECTIONS, not from the daemon table: the targets are the
 * delivery set of the agents bound to each connection — placement ∪ duty holders —
 * so a member serving the agent through a duty is re-projected too. It also
 * projects each connection's spec once instead of once per target.
 */
export async function syncMemoryConnectionsToDaemons(
  relayBaseUrl: string,
  deps: MemoryConnectionDaemonSyncDeps
): Promise<void> {
  const byOrg = new Map<string, ExternalMemoryConnectionRecord[]>()
  for (const connection of await deps.connections.listAll()) {
    byOrg.set(connection.orgId, [...(byOrg.get(connection.orgId) ?? []), connection])
  }
  for (const [orgId, connections] of byOrg) {
    const agents = await deps.agents.list(OrgId(orgId))
    await Promise.all(
      connections.map(async (connection) => {
        try {
          const bound = agents.filter(
            (agent) => agent.memory?.provider === 'external' && agent.memory.connectionId === connection.id
          )
          const targets = await deps.delivery.daemonsForAgents(bound)
          if (targets.length === 0) return
          const installation = await deps.installations.get(connection.installationId)
          if (!installation) return
          let spec
          if (installation.transport === 'stdio') {
            const secrets = (await deps.secrets.get(connection.orgId, connection.id)) ?? {}
            spec = stdioMemoryConnectionSpec(connection, installation, secrets)
          } else {
            const [grants, secretKeys] = await Promise.all([
              deps.grants.activeForConnection(connection.orgId, connection.id),
              deps.secrets.keys(connection.orgId, connection.id)
            ])
            const grant = grants.at(-1)
            if (!grant) return
            spec = memoryConnectionSpec(connection, installation, secretKeys, grant.key, relayBaseUrl)
          }
          for (const daemonId of targets) {
            // Offline/version-skewed daemon or store blip. register/ok remains the
            // authoritative backstop; never log secret-bearing details here.
            await deps.control.memoryConnectionUpsert(daemonId, spec).catch(() => {})
          }
        } catch {
          // Same swallow: a store/projection failure must not starve the rest.
        }
      })
    )
  }
}
