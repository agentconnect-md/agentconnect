/**
 * `channel/agents` (D→C REQ → `channel/agents/ok`) — the agent-collaboration
 * directory. A daemon asks "who else is in this channel?"; the CP returns EVERY
 * agent in the channel across ALL daemons (it is the only authority for the full
 * roster), as public metadata. Org-scoped to the requesting daemon's org.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import {
  PgIntegrationRepo,
  PgIntegrationChannelRepo,
  PgDaemonRepo,
  PgDaemonLifecycleOpRepo,
  PgRuntimeProfileRepo,
  PgAgentRepo
} from '../../src/persistence/index.js'
import { DaemonRegistryService } from '../../src/registry/registryService.js'
import { handleIntegrationChannels, handleChannelAgents } from '../../src/ws/handlers/index.js'
import { systemClock } from '../../src/domain/clock.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { AnyFrame, IntegrationChannel } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId } from '../../src/domain/ids.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const SLACK = { botToken: 'xoxb-abc-123', appToken: 'xapp-1-def-456' }

class SpyControl {
  async agentUpsert(): Promise<void> {}
  async agentRemove(): Promise<void> {}
  async integrationUpsert(): Promise<void> {}
  async integrationRemove(): Promise<void> {}
}

/** Create an agent (via REST, with displayName/description) + install its slack integration. */
async function installAgent(
  app: HttpApp,
  daemonId: string,
  agent: { name: string; displayName?: string; description?: string }
): Promise<{ agentId: string; integrationId: string }> {
  const created = await app.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: { ...agent, runtime: 'claude', daemonId }
  })
  expect(created.statusCode).toBe(201)
  const agentId = (created.json() as { id: string }).id
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: { name: `${agent.name}-bot`, platform: 'slack', agentId, slack: SLACK }
  })
  expect(res.statusCode).toBe(201)
  return { agentId, integrationId: (res.json() as { id: string }).id }
}

/** Populate an integration's channel membership via the real integration/channels handler. */
async function reportChannels(daemonId: string, integrationId: string, channels: IntegrationChannel[]): Promise<void> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'integration/channels',
    payload: { integrationId, channels }
  } as AnyFrame
  const deps = {
    integration: new PgIntegrationRepo(prisma),
    integrationChannel: new PgIntegrationChannelRepo(prisma),
    agent: new PgAgentRepo(prisma),
    agentMutations: new AgentMutationGate()
  } as unknown as DaemonWsDeps
  await handleIntegrationChannels(frame, { daemonId } as DaemonConnection, deps)
}

/** Dispatch a `channel/agents` REQ from `daemonId` and capture the reply payload.
 *  `requesterAgentId` is the trusted session-derived caller the CP checks membership
 *  and call-policy against (§2.2/§6.1). */
async function askChannelAgents(
  daemonId: string,
  channel: string,
  requesterAgentId: string
): Promise<{
  agents: Array<{ agentId: string; name: string; displayName?: string; description?: string; status: string }>
}> {
  let replied: { type: string; payload: unknown } | undefined
  const conn = {
    daemonId,
    replyTo: (_req: AnyFrame, type: string, payload: unknown) => {
      replied = { type, payload }
    }
  } as unknown as DaemonConnection
  const deps = {
    registry: new DaemonRegistryService(
      new PgDaemonRepo(prisma),
      new PgRuntimeProfileRepo(prisma),
      new PgDaemonLifecycleOpRepo(prisma),
      systemClock
    ),
    integration: new PgIntegrationRepo(prisma),
    agent: new PgAgentRepo(prisma)
  } as unknown as DaemonWsDeps
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'channel/agents',
    payload: { platform: 'slack', channel, requesterAgentId }
  } as AnyFrame
  await handleChannelAgents(frame, conn, deps)
  expect(replied?.type).toBe('channel/agents/ok')
  return replied!.payload as {
    agents: Array<{ agentId: string; name: string; displayName?: string; description?: string; status: string }>
  }
}

describe('channel/agents (agent collaboration directory)', () => {
  it('returns every agent in the channel across daemons, with public metadata', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)

    // Two agents on DIFFERENT daemons, both bots members of #deploys (C1).
    const a1 = await installAgent(running, DAEMON, {
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      description: 'ships and rolls back deploys'
    })
    const a2 = await installAgent(running, OTHER_DAEMON, { name: 'triager' }) // no displayName/description
    // A third agent in a DIFFERENT channel — must NOT appear.
    const a3 = await installAgent(running, DAEMON, { name: 'reviewer' })

    await reportChannels(DAEMON, a1.integrationId, [{ id: 'C1', name: 'deploys' }])
    await reportChannels(OTHER_DAEMON, a2.integrationId, [{ id: 'C1', name: 'deploys' }])
    await reportChannels(DAEMON, a3.integrationId, [{ id: 'C9', name: 'random' }])

    // The requesting daemon sees the FULL channel roster (both daemons), not just its own.
    // The requester is deploy-bot (a member of C1).
    const { agents } = await askChannelAgents(DAEMON, 'C1', a1.agentId)
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]))
    expect(Object.keys(byName).sort()).toEqual(['deploy-bot', 'triager'])
    expect(byName['deploy-bot']!.displayName).toBe('Deploy Bot')
    expect(byName['deploy-bot']!.description).toBe('ships and rolls back deploys')
    expect(byName['deploy-bot']!.status).toBe('active')
    // Optional fields are omitted (not null) when unset.
    expect(byName['triager']!.displayName).toBeUndefined()
    expect(byName['triager']!.description).toBeUndefined()
  })

  it('returns an empty roster for a channel with no agents', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)

    const { agents } = await askChannelAgents(DAEMON, 'C-EMPTY', randomUUID())
    expect(agents).toEqual([])
  })

  it('rejects a requester that is NOT a member of the target channel (no probing)', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)

    // `insider` is in #private (C-PRIV); `outsider` is only in #other (C-OTHER).
    const insider = await installAgent(running, DAEMON, { name: 'insider' })
    const outsider = await installAgent(running, DAEMON, { name: 'outsider' })
    await reportChannels(DAEMON, insider.integrationId, [{ id: 'C-PRIV', name: 'private', isPrivate: true }])
    await reportChannels(DAEMON, outsider.integrationId, [{ id: 'C-OTHER', name: 'other' }])

    // A member (insider) sees the private-channel roster...
    const asMember = await askChannelAgents(DAEMON, 'C-PRIV', insider.agentId)
    expect(asMember.agents.map((a) => a.name)).toEqual(['insider'])

    // ...but a NON-member (outsider) probing the same private channel gets nothing —
    // the roster is not leaked, even though the daemon and org match.
    const asOutsider = await askChannelAgents(DAEMON, 'C-PRIV', outsider.agentId)
    expect(asOutsider.agents).toEqual([])
  })

  it('filters out peers the requester is not allowed to call (callPolicy=selected)', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)

    const caller = await installAgent(running, DAEMON, { name: 'caller' })
    const openPeer = await installAgent(running, DAEMON, { name: 'open-peer' }) // callPolicy=all (default)
    const privatePeer = await installAgent(running, DAEMON, { name: 'private-peer' })
    for (const p of [caller, openPeer, privatePeer]) {
      await reportChannels(DAEMON, p.integrationId, [{ id: 'C1', name: 'deploys' }])
    }

    // private-peer only allows some OTHER agent to call it — not `caller`.
    const agentRepo = new PgAgentRepo(prisma)
    await agentRepo.setCallPolicy(AgentId(privatePeer.agentId), {
      callPolicy: 'selected',
      allowedCallerAgentIds: [randomUUID()]
    })

    const { agents } = await askChannelAgents(DAEMON, 'C1', caller.agentId)
    // caller sees itself + the open peer, but NOT the private (non-callable) peer.
    expect(agents.map((a) => a.name).sort()).toEqual(['caller', 'open-peer'])
  })

  it('reveals a callPolicy=selected peer to a caller on its allow-list', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)

    const caller = await installAgent(running, DAEMON, { name: 'caller' })
    const privatePeer = await installAgent(running, DAEMON, { name: 'private-peer' })
    await reportChannels(DAEMON, caller.integrationId, [{ id: 'C1', name: 'deploys' }])
    await reportChannels(DAEMON, privatePeer.integrationId, [{ id: 'C1', name: 'deploys' }])

    const agentRepo = new PgAgentRepo(prisma)
    await agentRepo.setCallPolicy(AgentId(privatePeer.agentId), {
      callPolicy: 'selected',
      allowedCallerAgentIds: [caller.agentId]
    })

    const { agents } = await askChannelAgents(DAEMON, 'C1', caller.agentId)
    expect(agents.map((a) => a.name).sort()).toEqual(['caller', 'private-peer'])
  })

  it("filters peers outside the requester's selected outbound policy", async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)

    const caller = await installAgent(running, DAEMON, { name: 'caller' })
    const allowedPeer = await installAgent(running, DAEMON, { name: 'allowed-peer' })
    const hiddenPeer = await installAgent(running, DAEMON, { name: 'hidden-peer' })
    for (const peer of [caller, allowedPeer, hiddenPeer]) {
      await reportChannels(DAEMON, peer.integrationId, [{ id: 'C1', name: 'deploys' }])
    }

    const agentRepo = new PgAgentRepo(prisma)
    await agentRepo.setCallPolicy(AgentId(caller.agentId), {
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [allowedPeer.agentId]
    })

    const { agents } = await askChannelAgents(DAEMON, 'C1', caller.agentId)
    expect(agents.map((candidate) => candidate.name).sort()).toEqual(['allowed-peer', 'caller'])
  })
})
