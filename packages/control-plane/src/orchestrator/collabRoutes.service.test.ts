import { describe, expect, it } from 'vitest'
import type { CollabRoutesSnapshot, RcCollabRoutes } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, IntegrationId, OrgId } from '../domain/ids.js'
import type {
  AgentRepo,
  ChannelPlacementRecord,
  DaemonRecord,
  DaemonRepo,
  IntegrationRepo,
  OrgAgentRecord
} from '../persistence/ports.js'
import type { RelayControlSender } from './relayControl.js'
import type { ControlSender } from './outbound.js'
import { NoConnection } from './outbound.js'
import { CollabRoutesService } from './collabRoutes.service.js'

const ORG_A = OrgId('11111111-1111-4111-8111-111111111111')
const ORG_B = OrgId('22222222-2222-4222-8222-222222222222')
const D_A = DaemonId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const D_B = DaemonId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

const daemons = [
  { id: D_A, orgId: ORG_A, routingEpoch: 4n },
  { id: D_B, orgId: ORG_B, routingEpoch: 9n }
] as DaemonRecord[]

function daemonRepo(): DaemonRepo {
  const epochs = new Map(daemons.map((daemon) => [daemon.id, daemon.routingEpoch]))
  return {
    list: async () => daemons.map((daemon) => ({ ...daemon, routingEpoch: epochs.get(daemon.id)! })),
    bumpRoutingEpoch: async (daemonId: DaemonId) => {
      const next = epochs.get(daemonId)! + 1n
      epochs.set(daemonId, next)
      return next
    }
  } as unknown as DaemonRepo
}

function placement(daemonId: string, suffix: string): ChannelPlacementRecord {
  return {
    platform: 'slack',
    channelId: `C-${suffix}`,
    agentId: AgentId(
      `${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}-${suffix}${suffix}${suffix}${suffix}-4${suffix}${suffix}${suffix}-8${suffix}${suffix}${suffix}-${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}`
    ),
    daemonId: DaemonId(daemonId),
    integrationId: IntegrationId(
      `${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}-${suffix}${suffix}${suffix}${suffix}-4${suffix}${suffix}${suffix}-8${suffix}${suffix}${suffix}-${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}`
    ),
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    outboundPolicy: 'all',
    allowedTargetAgentIds: [],
    name: `agent-${suffix}`
  }
}

/** Flat org peer directory (agent-collaboration §2.5): one placed agent per org, with
 *  NO integration — so it can only ever reach a snapshot through `agents[]`. */
function agentRepo(byOrg: Record<string, OrgAgentRecord[]> = {}): AgentRepo {
  return { orgDirectory: async (orgId: string) => byOrg[orgId] ?? [] } as unknown as AgentRepo
}

function orgAgent(orgId: string, daemonId: string, suffix: string): OrgAgentRecord {
  return {
    agentId: placement(daemonId, suffix).agentId,
    name: `agent-${suffix}`,
    displayName: null,
    description: null,
    status: 'active',
    placementKind: 'daemon',
    daemonId,
    setId: null,
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    outboundPolicy: 'all',
    allowedTargetAgentIds: []
  }
}

describe('CollabRoutesService placement broadcast', () => {
  it('sends an all-org full replacement to relays and org-scoped copies to daemons', async () => {
    let relay: RcCollabRoutes | undefined
    const daemonSends: Array<{ daemonId: string; snapshot: CollabRoutesSnapshot }> = []
    const service = new CollabRoutesService(
      daemonRepo(),
      {
        channelPlacements: async (orgId: string) => (orgId === ORG_A ? [placement(D_A, '1')] : [placement(D_B, '2')])
      } as unknown as IntegrationRepo,
      agentRepo({ [ORG_A]: [orgAgent(ORG_A, D_A, '3')], [ORG_B]: [orgAgent(ORG_B, D_B, '4')] }),
      { collabRoutes: (snapshot: RcCollabRoutes) => void (relay = snapshot) } as unknown as RelayControlSender,
      {
        collaborationRoutes: async (daemonId: string, snapshot: CollabRoutesSnapshot) => {
          daemonSends.push({ daemonId, snapshot })
        }
      } as unknown as ControlSender
    )

    await service.broadcast()

    expect(relay?.channels.map((c) => c.orgId).sort()).toEqual([ORG_A, ORG_B].sort())
    expect(daemonSends).toHaveLength(2)
    expect(daemonSends.find((s) => s.daemonId === D_A)?.snapshot.channels.map((c) => c.orgId)).toEqual([ORG_A])
    expect(daemonSends.find((s) => s.daemonId === D_B)?.snapshot.channels.map((c) => c.orgId)).toEqual([ORG_B])
    expect(daemonSends.find((s) => s.daemonId === D_A)?.snapshot.generation).toBe(5)
    expect(daemonSends.find((s) => s.daemonId === D_B)?.snapshot.generation).toBe(10)
    expect(relay?.generation).toBe(10)
    // The flat directory is all-org too: the relay table is a FULL replacement, so a
    // per-org emit would wipe the other tenant's peers just like `channels`.
    expect(relay?.agents.map((a) => a.orgId).sort()).toEqual([ORG_A, ORG_B].sort())
    expect(daemonSends.find((s) => s.daemonId === D_A)?.snapshot.agents.map((a) => a.orgId)).toEqual([ORG_A])
  })

  it('refreshes only the changed org daemons and tolerates disconnected ones', async () => {
    const sent: string[] = []
    const service = new CollabRoutesService(
      daemonRepo(),
      { channelPlacements: async () => [] } as unknown as IntegrationRepo,
      agentRepo(),
      { collabRoutes: () => undefined } as unknown as RelayControlSender,
      {
        collaborationRoutes: async (daemonId: string) => {
          sent.push(daemonId)
          throw new NoConnection(daemonId)
        }
      } as unknown as ControlSender
    )

    await expect(service.broadcast(ORG_A)).resolves.toBeUndefined()
    expect(sent).toEqual([D_A])
  })

  it('reconstructs relay generations from durable routing epochs after a CP restart', async () => {
    const repo = daemonRepo()
    const generations: number[] = []
    const relay = {
      collabRoutes: (snapshot: RcCollabRoutes) => void generations.push(snapshot.generation)
    } as unknown as RelayControlSender
    const integrations = { channelPlacements: async () => [] } as unknown as IntegrationRepo

    await new CollabRoutesService(repo, integrations, agentRepo(), relay).broadcast()
    await new CollabRoutesService(repo, integrations, agentRepo(), relay).broadcast()

    expect(generations).toEqual([10, 11])
  })

  it('serializes concurrent bump, placement read, and send cycles', async () => {
    const repo = daemonRepo()
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const blocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const entered = new Promise<void>((resolve) => (firstEntered = resolve))
    let reads = 0
    const generations: number[] = []
    const service = new CollabRoutesService(
      repo,
      {
        channelPlacements: async () => {
          reads += 1
          if (reads === 1) {
            firstEntered()
            await blocked
          }
          return []
        }
      } as unknown as IntegrationRepo,
      agentRepo(),
      {
        collabRoutes: (snapshot: RcCollabRoutes) => void generations.push(snapshot.generation)
      } as unknown as RelayControlSender
    )

    const first = service.broadcast()
    await entered
    const second = service.broadcast()
    await Promise.resolve()
    expect(reads).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(generations).toEqual([10, 11])
  })
})
