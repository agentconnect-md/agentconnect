/**
 * `channel/agents` (D→C REQ → `channel/agents/ok`) — the agent-collaboration peer
 * directory. The CP is the only authority for the full roster, so it returns EVERY
 * reachable peer across ALL daemons as public metadata, org-scoped to the requesting
 * daemon's org.
 *
 * TWO SCOPES: no `channel` ⇒ the ORG-WIDE directory (the default now that A2A delivery
 * is postless, #854 — includes agents with no IM integration at all); a `channel` ⇒ the
 * same directory additionally filtered to that channel's membership. Authorization is
 * the directional call policy in BOTH scopes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { prisma } from '../setup.db.js'
import { seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { buildDaemonApp, type DaemonApp } from '../fakes/build-app.js'
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
import { isFrame, type AnyFrame, type IntegrationChannel } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { AgentId } from '../../src/domain/ids.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined
let runningWs: DaemonApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
  await runningWs?.close()
  runningWs = undefined
})

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const SLACK = { botToken: 'xoxb-abc-123', appToken: 'xapp-1-def-456' }

class SpyControl {
  async agentUpsert(): Promise<void> {}
  async agentRemove(): Promise<void> {}
  async integrationUpsert(): Promise<void> {}
  async integrationRemove(): Promise<void> {}
  // Creating a PLACED agent publishes the collaboration snapshot too; this suite only
  // cares about the `channel/agents` REPLY (served from a live DB read), so the push is
  // accepted and ignored. Present so the fake does not diverge from ControlSender.
  async collaborationRoutes(): Promise<void> {}
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

/** Create an agent with NO integration — it exists only in the org peer directory and
 *  can appear in no channel-keyed structure at all (webchat / hook / memory-only agents). */
async function createAgent(
  app: HttpApp,
  daemonId: string,
  agent: { name: string; displayName?: string; description?: string }
): Promise<string> {
  const created = await app.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: { ...agent, runtime: 'claude', daemonId }
  })
  expect(created.statusCode).toBe(201)
  return (created.json() as { id: string }).id
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
type RosterReply = {
  platform: string
  channel?: string
  agents: Array<{ agentId: string; name: string; displayName?: string; description?: string; status: string }>
}

async function askChannelAgents(
  daemonId: string,
  channel: string | undefined,
  requesterAgentId: string,
  platform: 'slack' | 'webchat' = 'slack'
): Promise<RosterReply> {
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
    payload: { platform, ...(channel !== undefined ? { channel } : {}), requesterAgentId }
  } as AnyFrame
  await handleChannelAgents(frame, conn, deps)
  expect(replied?.type).toBe('channel/agents/ok')
  return replied!.payload as RosterReply
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

describe('channel/agents — ORG-WIDE scope (no channel)', () => {
  it('returns the whole org directory, including an agent with NO integration', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)

    // The caller reaches #deploys; `webchat-only` has no integration at all, so it is
    // absent from every channel-keyed structure and reachable ONLY org-wide.
    const caller = await installAgent(running, DAEMON, { name: 'caller' })
    await reportChannels(DAEMON, caller.integrationId, [{ id: 'C1', name: 'deploys' }])
    const solo = await createAgent(running, OTHER_DAEMON, {
      name: 'webchat-only',
      displayName: 'Webchat Only',
      description: 'no IM integration'
    })
    // A `restricted` agent is a console-access decision, NOT a peer-directory one —
    // it must remain discoverable (ResourceVisibility never gates A2A).
    const hidden = await createAgent(running, DAEMON, { name: 'restricted-peer' })
    await prisma.agent.update({
      where: { id: hidden },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })

    const reply = await askChannelAgents(DAEMON, undefined, caller.agentId)
    expect(reply.channel).toBeUndefined() // the reply echoes the org-wide scope
    expect(reply.agents.map((a) => a.name).sort()).toEqual(['caller', 'restricted-peer', 'webchat-only'])
    const byId = Object.fromEntries(reply.agents.map((a) => [a.agentId, a]))
    expect(byId[solo]).toMatchObject({ displayName: 'Webchat Only', description: 'no IM integration' })

    // Channel is now a FILTER, not a gate: the same caller scoped to #deploys sees
    // only the channel's members, while the org-wide ask above saw everyone.
    const scoped = await askChannelAgents(DAEMON, 'C1', caller.agentId)
    expect(scoped.channel).toBe('C1')
    expect(scoped.agents.map((a) => a.name)).toEqual(['caller'])
  })

  it('fails closed (empty roster) for a requester outside the requesting daemon org', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    await createAgent(running, DAEMON, { name: 'local-agent' })

    // A foreign-org agent id cannot be in this org's directory, so nothing resolves —
    // cross-org discovery never succeeds and the roster is not leaked.
    const foreignOrgId = `org-foreign-${randomUUID().slice(0, 8)}`
    await prisma.org.create({ data: { id: foreignOrgId, slug: foreignOrgId } })
    const foreignAgent = await prisma.agent.create({
      data: { id: randomUUID(), orgId: foreignOrgId, name: 'foreigner', runtime: 'claude' }
    })

    const reply = await askChannelAgents(DAEMON, undefined, foreignAgent.id)
    expect(reply.agents).toEqual([])
  })

  it('applies the bidirectional call policy org-wide, exactly as in the channel scope', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const agentRepo = new PgAgentRepo(prisma)

    const caller = await createAgent(running, DAEMON, { name: 'caller' })
    const openPeer = await createAgent(running, DAEMON, { name: 'open-peer' })
    const refusingPeer = await createAgent(running, DAEMON, { name: 'refusing-peer' })
    const unlistedPeer = await createAgent(running, DAEMON, { name: 'unlisted-peer' })

    // Inbound: refusing-peer admits somebody else, not the caller.
    await agentRepo.setCallPolicy(AgentId(refusingPeer), {
      callPolicy: 'selected',
      allowedCallerAgentIds: [randomUUID()]
    })
    // Outbound: the caller only targets open-peer + refusing-peer, so unlisted-peer is
    // invisible even though ITS inbound policy is open.
    await agentRepo.setCallPolicy(AgentId(caller), {
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [openPeer, refusingPeer]
    })

    const reply = await askChannelAgents(DAEMON, undefined, caller)
    // Self is always visible even though the caller omits itself from its own list.
    expect(reply.agents.map((a) => a.name).sort()).toEqual(['caller', 'open-peer'])
    expect(unlistedPeer).toBeTruthy()
  })

  // The org roster and the flat `CollabRoutesSnapshot.agents[]` wakes are authorized
  // against come from the SAME `orgDirectory` read, and the snapshot drops daemonId-less
  // rows — so an UNPLACED agent must not be advertised here either, or the model discovers
  // a peer it cannot call and only learns so from a bare 'not_allowed'. (Twin of
  // collabSnapshot.test.ts "drops an unplaced agent from the flat directory".)
  it('omits an UNPLACED agent from the org-wide roster (no owning daemon ⇒ not callable)', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)

    const caller = await createAgent(running, DAEMON, { name: 'caller' })
    // Created WITHOUT a daemonId: a real state (agent configured before placement, or
    // drained off its daemon) that no wake can be routed to.
    const created = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'unplaced-peer', runtime: 'claude' }
    })
    expect(created.statusCode).toBe(201)
    expect((created.json() as { daemonId: string | null }).daemonId).toBeNull()

    const reply = await askChannelAgents(DAEMON, undefined, caller)
    expect(reply.agents.map((a) => a.name)).toEqual(['caller'])
  })

  // The daemon's word on WHICH agent is asking is not evidence: with the roster widened to
  // the whole org, an unbound `requesterAgentId` would let any daemon read any org agent's
  // policy-filtered directory — the read-side twin of the relay's `claimedFromAgentId`
  // check. Fail closed, in both scopes.
  it('fails closed when the asserted requester is placed on ANOTHER daemon', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)

    const victim = await installAgent(running, OTHER_DAEMON, { name: 'victim' })
    const peer = await installAgent(running, OTHER_DAEMON, { name: 'peer' })
    await reportChannels(OTHER_DAEMON, victim.integrationId, [{ id: 'C1', name: 'deploys' }])
    await reportChannels(OTHER_DAEMON, peer.integrationId, [{ id: 'C1', name: 'deploys' }])

    // DAEMON impersonates `victim`, which the CP has placed on OTHER_DAEMON.
    expect((await askChannelAgents(DAEMON, undefined, victim.agentId)).agents).toEqual([])
    expect((await askChannelAgents(DAEMON, 'C1', victim.agentId)).agents).toEqual([])
    // ...while the daemon that actually owns it is served.
    expect((await askChannelAgents(OTHER_DAEMON, 'C1', victim.agentId)).agents.map((a) => a.name).sort()).toEqual([
      'peer',
      'victim'
    ])
  })

  // The CHANNEL-filtered half of the same invariant, and the one that survived the
  // `orgDirectory` fix: `agentsInChannel` joins INTEGRATIONS, not placements, so an agent
  // that lost its daemon while its bot stayed in the channel still comes back from that
  // query. Reachable with no DB surgery — `DELETE /daemons/:id` sets `Agent.daemonId` null
  // (onDelete: SetNull) and leaves the integration active. Both roster scopes must agree
  // with the snapshot, which drops daemonId-less rows.
  it('omits an UNPLACED-but-still-integrated agent from the CHANNEL roster too', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)

    const caller = await installAgent(running, DAEMON, { name: 'caller' })
    const ghost = await installAgent(running, OTHER_DAEMON, { name: 'ghost-peer' })
    await reportChannels(DAEMON, caller.integrationId, [{ id: 'C1', name: 'ops' }])
    await reportChannels(OTHER_DAEMON, ghost.integrationId, [{ id: 'C1', name: 'ops' }])
    // Both are callable while ghost-peer is placed.
    expect((await askChannelAgents(DAEMON, 'C1', caller.agentId)).agents.map((a) => a.name).sort()).toEqual([
      'caller',
      'ghost-peer'
    ])

    // Detach the daemon that hosted ghost-peer. Its integration + channel row survive.
    const deleted = await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${OTHER_DAEMON}` })
    expect(deleted.statusCode).toBe(204)
    expect(await prisma.agent.findUnique({ where: { id: ghost.agentId }, select: { daemonId: true } })).toEqual({
      daemonId: null
    })

    // Neither scope may advertise it now: there is no daemon to route a wake to.
    expect((await askChannelAgents(DAEMON, 'C1', caller.agentId)).agents.map((a) => a.name)).toEqual(['caller'])
    expect((await askChannelAgents(DAEMON, undefined, caller.agentId)).agents.map((a) => a.name)).toEqual(['caller'])
  })

  it('returns an empty roster for a channel-scoped webchat request instead of throwing', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const caller = await createAgent(running, DAEMON, { name: 'caller' })

    // `webchat` has no persisted integration (toDbPlatform rejects it by design), so a
    // channel-scoped ask must short-circuit to empty — never raise.
    const reply = await askChannelAgents(DAEMON, 'sess-abc', caller, 'webchat')
    expect(reply.agents).toEqual([])
    expect(reply.channel).toBe('sess-abc')
  })
})

/** The regression this PR fixes, over a REAL socket: a channel-scoped `channel/agents`
 *  for a session-identity platform used to raise inside the handler, and
 *  `ws/connection.ts` turns any handler throw into close(1011) — killing the whole
 *  daemon↔CP control connection (the daemon then failed the request with
 *  "connection closed"). Asserting the reply alone is not enough; the connection has to
 *  survive, so a FOLLOWING request must still be answered on the same socket. */
describe('channel/agents over a live control socket', () => {
  const WS_DAEMON = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'
  const SUBPROTOCOL = 'agentconnect.v1'

  function nextFrame(ws: WebSocket, type: string): Promise<AnyFrame> {
    return new Promise((resolve, reject) => {
      const onMsg = (data: Buffer): void => {
        const frame = JSON.parse(data.toString()) as AnyFrame
        if (frame.type === type) {
          ws.off('message', onMsg)
          resolve(frame)
        }
      }
      ws.on('message', onMsg)
      ws.once('close', (code) => reject(new Error(`closed waiting for ${type}: ${code}`)))
    })
  }

  function sendFrame(ws: WebSocket, type: string, payload: unknown): string {
    const id = randomUUID()
    ws.send(JSON.stringify({ v: 1, id, ts: new Date().toISOString(), type, payload }))
    return id
  }

  it('answers a webchat channel request and LEAVES THE CONNECTION OPEN', async () => {
    const app = buildDaemonApp(prisma)
    runningWs = app
    const address = await app.listen()
    const token = await app.mintToken(WS_DAEMON)
    const ws = new WebSocket(`${address.replace(/^http/, 'ws')}/daemon/ws`, SUBPROTOCOL)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    try {
      sendFrame(ws, 'auth', { apiKey: token, daemonId: WS_DAEMON, agentVersion: '1.4.0' })
      await nextFrame(ws, 'auth/ok')
      sendFrame(ws, 'register', {
        host: 'host-1',
        capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
        maxAgents: 4,
        localState: { assignments: [], crons: [], leases: [] }
      })
      const regOk = await nextFrame(ws, 'register/ok')
      if (!isFrame('register/ok')(regOk)) throw new Error('expected register/ok')
      // The negotiated feature the daemon keys its channel-less requests off.
      expect(regOk.payload.serverFeatures).toContain('agent-directory-org-scope-v1')

      const webchatId = sendFrame(ws, 'channel/agents', {
        platform: 'webchat',
        channel: 'sess-abc',
        requesterAgentId: randomUUID()
      })
      const first = await nextFrame(ws, 'channel/agents/ok')
      if (!isFrame('channel/agents/ok')(first)) throw new Error('expected channel/agents/ok')
      expect(first.corr).toBe(webchatId)
      expect(first.payload.agents).toEqual([])

      // Still alive: the org-wide follow-up is answered on the SAME socket.
      const orgWideId = sendFrame(ws, 'channel/agents', { platform: 'webchat', requesterAgentId: randomUUID() })
      const second = await nextFrame(ws, 'channel/agents/ok')
      if (!isFrame('channel/agents/ok')(second)) throw new Error('expected channel/agents/ok')
      expect(second.corr).toBe(orgWideId)
      expect(second.payload.channel).toBeUndefined()
      expect(ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      ws.close()
    }
  })
})
