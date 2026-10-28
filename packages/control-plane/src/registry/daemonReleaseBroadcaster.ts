// Pushes a changed deployment release to this replica's READY auto-upgrade daemons (daemon-auto-upgrade.md §4.1).
import { CONFIG_KEY_UPGRADE_LATEST, DAEMON_AUTO_UPGRADE_FEATURE } from '@agentconnect.md/protocol'
import type { DaemonConnState } from '../ws/registry.js'
import type { AnnouncedRelease, DaemonReleaseResolver } from './daemonRelease.js'

export interface ReleaseBroadcastDeps {
  resolver: Pick<DaemonReleaseResolver, 'onChange'>
  /** This replica's live connections; a daemon's socket lives on exactly one replica. */
  connections: { reachableDaemons(): Pick<DaemonConnState, 'daemonId' | 'state' | 'capabilities'>[] }
  /** `ControlSender.configPush`; throws NoConnection when the socket is gone. */
  control: { configPush(daemonId: string, keys: Record<string, unknown>): void }
  log?: { warn(obj: unknown, msg?: string): void }
}

export class DaemonReleaseBroadcaster {
  private unsubscribe: (() => void) | undefined

  constructor(private readonly deps: ReleaseBroadcastDeps) {}

  start(): void {
    this.unsubscribe ??= this.deps.resolver.onChange((release) => {
      this.broadcast(release)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /** Push `upgrade.latest` to every eligible daemon; returns how many pushes were sent. */
  broadcast(release: AnnouncedRelease): number {
    let sent = 0
    for (const conn of this.deps.connections.reachableDaemons()) {
      if (conn.state !== 'READY') continue
      if (!conn.capabilities?.features.includes(DAEMON_AUTO_UPGRADE_FEATURE)) continue
      try {
        this.deps.control.configPush(conn.daemonId, {
          [CONFIG_KEY_UPGRADE_LATEST]: { channel: release.channel, version: release.version }
        })
        sent++
      } catch (err) {
        // A socket gone since the scan converges from the register/ok `release` on reconnect.
        this.deps.log?.warn({ err, daemonId: conn.daemonId }, 'daemon-release: push failed')
      }
    }
    return sent
  }
}
