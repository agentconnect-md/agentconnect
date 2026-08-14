/**
 * `CollabRoutesService` — builds the combined bot-agnostic collaboration routing
 * snapshot (agent-collaboration §2.3/§6.2) across every org and ships it to relays.
 *
 * The relay's `CollaborationRouter` is a FULL-REPLACE table keyed by
 * `(orgId, platform, channel)`, so a single combined snapshot (all orgs' channels)
 * is shipped — a per-org emit would wipe the other orgs' rows.
 *
 * Distribution (§6.5): pushed to a single relay on its (re)register (the reconnect
 * baseline via {@link broadcastTo}) and pool-wide via {@link broadcast} when placement,
 * policy, or channel membership changes.
 */
import type { RelayControlSender } from './relayControl.js'
import { NoConnection, type ControlSender } from './outbound.js'
import type { RelayChannel } from '../ws/relay-registry.js'
import type { AgentRepo, DaemonRecord, DaemonRepo, IntegrationRepo } from '../persistence/ports.js'
import { buildCollabSnapshot } from './collabSnapshot.js'
import type { CollabChannelRoute, CollabOrgAgent, CollabRoutesSnapshot } from '@agentconnect.md/protocol'
import type { OrgId } from '../domain/ids.js'

export class CollabRoutesService {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly daemons: DaemonRepo,
    private readonly integrations: IntegrationRepo,
    private readonly agents: AgentRepo,
    private readonly relayControl: RelayControlSender,
    private readonly control?: ControlSender
  ) {}

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /** Build the combined snapshot across every org that has a daemon. Both the
   *  channel-keyed routes AND the flat per-org peer directory are all-org here, for the
   *  same reason: the relay table is a FULL replacement, so omitting an org wipes it. */
  private async build(daemonRows: DaemonRecord[], generation: number): Promise<CollabRoutesSnapshot> {
    const orgIds = new Set<OrgId>()
    for (const daemon of daemonRows) {
      if (daemon.orgId) {
        orgIds.add(daemon.orgId)
        continue
      }
      for (const agent of await this.agents.listForDaemon(daemon.id)) orgIds.add(agent.orgId)
    }
    const channels: CollabChannelRoute[] = []
    const agents: CollabOrgAgent[] = []
    let platformKinds: CollabRoutesSnapshot['platformKinds'] = []
    for (const orgId of orgIds) {
      const placements = await this.integrations.channelPlacements(orgId)
      const orgAgents = await this.agents.orgDirectory(orgId)
      const snapshot = buildCollabSnapshot(orgId, placements, generation, orgAgents)
      channels.push(...snapshot.channels)
      agents.push(...snapshot.agents)
      platformKinds = snapshot.platformKinds // static classification — identical per org
    }
    return { generation, channels, agents, platformKinds }
  }

  private durableGeneration(rows: DaemonRecord[]): number {
    return rows.reduce((max, daemon) => Math.max(max, Number(daemon.routingEpoch)), 0)
  }

  /**
   * Bump every durable daemon epoch. The max is the relay's all-org generation;
   * each daemon receives its own epoch, exactly matching its register baseline.
   * Reconstructing this service after a CP restart therefore cannot reset either
   * generation domain back to an in-memory counter.
   */
  private async bumpRows(rows: DaemonRecord[]): Promise<DaemonRecord[]> {
    return Promise.all(
      rows.map(async (daemon) => ({
        ...daemon,
        routingEpoch: await this.daemons.bumpRoutingEpoch(daemon.id)
      }))
    )
  }

  /** Ship the current combined snapshot to a SINGLE relay (its (re)register baseline). */
  broadcastTo(ch: RelayChannel): Promise<void> {
    return this.serialize(() => this.broadcastToLocked(ch))
  }

  private async broadcastToLocked(ch: RelayChannel): Promise<void> {
    const rows = await this.daemons.list()
    this.relayControl.collabRoutesTo(ch, await this.build(rows, this.durableGeneration(rows)))
  }

  /**
   * Placement hot push. Relays receive the required ALL-org full replacement;
   * connected daemons receive their own org-scoped full replacement. When
   * `changedOrgId` is supplied only that org's daemon copies need refreshing,
   * while the relay copy still includes every org (a partial relay snapshot
   * would wipe unrelated tenants).
   */
  broadcast(changedOrgId?: OrgId): Promise<void> {
    return this.serialize(() => this.broadcastLocked(changedOrgId))
  }

  private async broadcastLocked(changedOrgId?: OrgId): Promise<void> {
    const daemonRows = await this.bumpRows(await this.daemons.list())
    const generation = this.durableGeneration(daemonRows)
    this.relayControl.collabRoutes(await this.build(daemonRows, generation))
    if (!this.control) return

    const targetRows = changedOrgId
      ? daemonRows.filter((d) => d.orgId === changedOrgId || d.orgId === null)
      : daemonRows
    await Promise.all(
      targetRows.map(async (daemon) => {
        const snapshot = await this.build([daemon], Number(daemon.routingEpoch))
        try {
          await this.control!.collaborationRoutes(daemon.id, snapshot)
        } catch (err) {
          // Register/ok is the durable backstop for disconnected daemons.
          if (!(err instanceof NoConnection)) throw err
        }
      })
    )
  }
}
