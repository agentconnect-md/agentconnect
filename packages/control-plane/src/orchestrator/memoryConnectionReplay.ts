/** Full external-memory binding replay to one freshly registered relay. */
import type {
  ExternalMemoryConnectionRepo,
  ExternalMemoryConnectionSecretStore,
  ExternalMemoryGrantRepo,
  MemoryPluginInstallationRepo,
  DaemonRepo
} from '../persistence/ports.js'
import type { RelayChannel } from '../ws/relay-registry.js'
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
  daemons: DaemonRepo
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
 * Re-project every placed connection after the selected relay changes or the
 * first relay appears. Without this hot sync, an agent bound while the relay
 * pool was empty would remain unprobed until its daemon reconnected.
 */
export async function syncMemoryConnectionsToDaemons(
  relayBaseUrl: string,
  deps: MemoryConnectionDaemonSyncDeps
): Promise<void> {
  await Promise.all(
    (await deps.daemons.list()).map(async (daemon) => {
      await Promise.all(
        (await deps.connections.activeForDaemon(daemon.id)).map(async (connection) => {
          try {
            const installation = await deps.installations.get(connection.installationId)
            if (!installation) return
            if (installation.transport === 'stdio') {
              const secrets = (await deps.secrets.get(connection.orgId, connection.id)) ?? {}
              await deps.control.memoryConnectionUpsert(
                daemon.id,
                stdioMemoryConnectionSpec(connection, installation, secrets)
              )
              return
            }
            const [grants, secretKeys] = await Promise.all([
              deps.grants.activeForConnection(connection.orgId, connection.id),
              deps.secrets.keys(connection.orgId, connection.id)
            ])
            const grant = grants.at(-1)
            if (!grant) return
            await deps.control.memoryConnectionUpsert(
              daemon.id,
              memoryConnectionSpec(connection, installation, secretKeys, grant.key, relayBaseUrl)
            )
          } catch {
            // Offline/version-skewed daemon or store blip. register/ok remains the
            // authoritative backstop; never log secret-bearing details here.
          }
        })
      )
    })
  )
}
