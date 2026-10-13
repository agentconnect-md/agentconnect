// A place layer is seen, read and changed only by whom the console shows a session of its conversation; an owner also sees the rest, to clear.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  MEMORY_PLACE_CLEAR_FEATURE,
  type MemoryChannelEntry,
  type MemoryChannelsReq,
  type MemoryEntriesReadReq,
  type MemoryEntriesReadResult,
  type MemoryEntriesWriteReq,
  type MemoryEntriesWriteResult
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEF_ORG, DEFAULT_DAEMON_CAPABILITIES, seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { HttpDeps } from '../../src/http/deps.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgAgentMemoryHistoryRepo } from '../../src/persistence/repositories/agent-memory.repo.js'
import { AgentId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMORY = `${ORG}/agents/${AGENT}/memory`
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

// A private channel, named by a current daemon.
const PRIVATE: MemoryChannelEntry = {
  channelKey: 'slack-C0EXAMPLE1-0a1b2c3d4e5f',
  channel: 'C0EXAMPLE1',
  platform: 'slack',
  name: 'launch-room'
}
// What a daemon from before names were recorded answers: the channel id alone.
const OLDER: MemoryChannelEntry = { channelKey: 'slack-C0EXAMPLE2-1a2b3c4d5e6f', channel: 'C0EXAMPLE2' }
// A layer whose conversation has no session the Control Plane knows of.
const ORPHAN: MemoryChannelEntry = { channelKey: 'slack-C0EXAMPLE3-2a3b4c5d6e7f', channel: 'C0EXAMPLE3' }
// A folder that never recorded whose it is.
const NAMELESS: MemoryChannelEntry = { channelKey: 'scope-0example--C0EXAMPLE4-3a4b5c6d7e8f' }
// A private channel whose session a linked chat account owns.
const LINKED: MemoryChannelEntry = { channelKey: 'slack-C0EXAMPLE5-4a5b6c7d8e9f', channel: 'C0EXAMPLE5' }
const LINKED_IDENTITY = 'slack:T0EXAMPLE:U0EXAMPLE'

/** The daemon side: the place-layer list, and every frame that would carry a layer's content, counted. */
class PlaceDaemon {
  content: string[] = []
  cleared: string[] = []
  constructor(readonly channels: MemoryChannelEntry[] = [PRIVATE, OLDER, ORPHAN, NAMELESS, LINKED]) {}
  async memoryChannels(_daemon: string, req: MemoryChannelsReq) {
    const channels = req.channelKey ? this.channels.filter((c) => c.channelKey === req.channelKey) : this.channels
    return { agentId: req.agentId, channels }
  }
  async memoryList(_daemon: string, req: { agentId: string }) {
    this.content.push('list')
    return { agentId: req.agentId, exists: true, entries: [] }
  }
  async memoryRead(_daemon: string, req: { agentId: string; path: string }) {
    this.content.push('read')
    return { agentId: req.agentId, path: req.path, exists: false }
  }
  async memoryWrite(_daemon: string, req: { agentId: string; path: string }) {
    this.content.push('write')
    return { agentId: req.agentId, path: req.path, size: 1, mtime: '2026-10-13T00:00:00.000Z' }
  }
  async memoryHistory(_daemon: string, req: { agentId: string; path: string }) {
    this.content.push('history')
    return { agentId: req.agentId, path: req.path, events: [] }
  }
  async memoryEntriesRead(_daemon: string, req: MemoryEntriesReadReq): Promise<MemoryEntriesReadResult> {
    this.content.push(`entries.${req.operation}`)
    switch (req.operation) {
      case 'describe':
        return {
          operation: 'describe',
          result: {
            version: 1,
            operations: ['list', 'get'],
            supportedScopes: ['agent'],
            writeConsistency: 'last-write-wins',
            exactEdit: false,
            exactCreate: false,
            enumeration: 'live',
            graph: false,
            limits: { maxItemBytes: 1000, maxPageItems: 20 }
          }
        }
      case 'list':
        return { operation: 'list', result: { entries: [], consistency: 'live', order: 'backend' } }
      case 'get':
        return { operation: 'get', result: null }
      case 'search':
        return { operation: 'search', result: { hits: [], kind: 'lexical', coverage: 'complete' } }
      case 'history':
        return { operation: 'history', result: { events: [], order: 'newest-first' } }
    }
  }
  async memoryEntriesWrite(_daemon: string, req: MemoryEntriesWriteReq): Promise<MemoryEntriesWriteResult> {
    this.content.push(`entries.${req.operation}`)
    return { operation: 'completed', result: { operationId: randomUUID(), state: 'completed' } }
  }
  async memoryChannelClear(_daemon: string, req: { agentId: string; channelKey: string }) {
    this.cleared.push(req.channelKey)
    return { agentId: req.agentId, channelKey: req.channelKey, cleared: true }
  }
}

let running: HttpApp[] = []
afterEach(async () => {
  await Promise.all(running.map((app) => app.close()))
  running = []
})

async function member(sub: string, role: 'collaborator' | 'viewer' | 'owner' = 'collaborator'): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** An agent every member can view, with sessions in its conversations, and the people who ask. */
async function world(opts: { features?: string[]; memory?: Record<string, unknown> } = {}) {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { ...DEFAULT_DAEMON_CAPABILITIES, features: opts.features ?? [MEMORY_PLACE_CLEAR_FEATURE] }
  })
  await seedAgent(prisma, AGENT, {
    daemonId: DAEMON,
    ...(opts.memory ? { runtimeOverrides: { memory: opts.memory } } : {})
  })
  const inside = await member('place-inside')
  const outside = await member('place-outside')
  const linked = await member('place-linked')
  // The private channel's session is the insider's own.
  await seedSessionMeta(prisma, randomUUID(), AGENT, {
    channel: PRIVATE.channel!,
    visibility: 'private',
    ownerIdentity: `user:${inside}`
  })
  // The other conversation's sessions show to every member, and one of them carries its name.
  const named = await seedSessionMeta(prisma, randomUUID(), AGENT, {
    channel: OLDER.channel!,
    lastActivityAt: new Date(Date.now() - 60_000)
  })
  await prisma.sessionMeta.update({ where: { id: named }, data: { channelName: 'general-chat' } })
  await seedSessionMeta(prisma, randomUUID(), AGENT, { channel: OLDER.channel! })
  // A session owned by a chat account, which only the member who linked it sees.
  await seedSessionMeta(prisma, randomUUID(), AGENT, {
    channel: LINKED.channel!,
    visibility: 'private',
    ownerIdentity: LINKED_IDENTITY
  })
  return { inside, outside, linked }
}

function as(userId: string, daemon: PlaceDaemon, linkedUser?: string): HttpApp {
  const overrides: Partial<HttpDeps> = linkedUser
    ? {
        sessionAccessPlugins: [
          {
            provider: 'slack',
            available: false,
            addViewerIdentities: async (viewer) => {
              if (viewer.userId === linkedUser) viewer.identitySet.add(LINKED_IDENTITY)
            },
            resolve: async () => ({ allowedScopes: [], degraded: false })
          }
        ]
      }
    : {}
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, LIVE, daemon as unknown as ControlSender, overrides)
  running.push(app)
  return app
}

/** Every route that takes a place layer, by operation id, with a request that names one. */
const PLACE_ROUTES: Record<
  string,
  (key: string) => { method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: object }
> = {
  readAgentMemory: (key) => ({ method: 'GET', url: `${MEMORY}?channelKey=${key}` }),
  listAgentMemoryFiles: (key) => ({ method: 'GET', url: `${MEMORY}/files?channelKey=${key}` }),
  readAgentMemoryFile: (key) => ({ method: 'GET', url: `${MEMORY}/file?channelKey=${key}&path=notes.md` }),
  putAgentMemoryFile: (key) => ({
    method: 'PUT',
    url: `${MEMORY}/file?channelKey=${key}&path=notes.md`,
    payload: { content: '- a note' }
  }),
  listAgentMemoryFileHistory: (key) => ({ method: 'GET', url: `${MEMORY}/history?channelKey=${key}&path=notes.md` }),
  getAgentMemoryEntryCapabilities: (key) => ({ method: 'GET', url: `${MEMORY}/capabilities?channelKey=${key}` }),
  listAgentMemoryEntries: (key) => ({ method: 'GET', url: `${MEMORY}/entries?channelKey=${key}` }),
  getAgentMemoryEntry: (key) => ({ method: 'GET', url: `${MEMORY}/entries/opaque-ref?channelKey=${key}` }),
  listAgentMemoryEntryHistory: (key) => ({
    method: 'GET',
    url: `${MEMORY}/entries/opaque-ref/history?channelKey=${key}`
  }),
  searchAgentMemoryEntries: (key) => ({
    method: 'POST',
    url: `${MEMORY}/entries/search?channelKey=${key}`,
    payload: { query: 'launch' }
  }),
  createAgentMemoryEntry: (key) => ({
    method: 'POST',
    url: `${MEMORY}/entries?channelKey=${key}`,
    payload: { label: 'topic', text: 'hello' }
  }),
  updateAgentMemoryEntry: (key) => ({
    method: 'PATCH',
    url: `${MEMORY}/entries?channelKey=${key}`,
    payload: { ref: 'opaque-ref', revision: 'r1', edit: { oldText: 'hello', newText: 'hi' } }
  }),
  deleteAgentMemoryEntry: (key) => ({
    method: 'DELETE',
    url: `${MEMORY}/entries?channelKey=${key}`,
    payload: { ref: 'opaque-ref', revision: 'r1' }
  }),
  clearAgentMemoryChannel: (key) => ({ method: 'DELETE', url: `${MEMORY}/channels/${key}` })
}

/** What someone who can see the conversation gets: the content, except a clear, which is an owner's alone. */
const ALLOWED_STATUS: Record<string, number> = { clearAgentMemoryChannel: 403 }

describe('a place layer is reached only by someone who can see its conversation', () => {
  it('answers 404 on every route that names a layer, and works for a member who can see it', async () => {
    const { inside, outside } = await world()
    const daemon = new PlaceDaemon()
    const doc = (await as(outside, daemon).app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as {
      paths: Record<
        string,
        Record<string, { operationId?: string; parameters?: { name: string; description?: string }[] }>
      >
    }
    // Every operation that takes a layer is in the table, so a new one cannot skip the rule unnoticed.
    const taking = Object.values(doc.paths)
      .flatMap((methods) => Object.values(methods))
      .filter((op) => op.parameters?.some((parameter) => parameter.name === 'channelKey'))
    expect(taking.map((op) => op.operationId).sort()).toEqual(Object.keys(PLACE_ROUTES).sort())
    // And each says what naming a layer means.
    for (const op of taking)
      expect(op.parameters?.find((parameter) => parameter.name === 'channelKey')?.description, op.operationId).toMatch(
        /answers 404/
      )

    for (const [operationId, request] of Object.entries(PLACE_ROUTES)) {
      const refused = await as(outside, daemon).app.inject(request(PRIVATE.channelKey))
      expect(refused.statusCode, `${operationId} as an outsider`).toBe(404)
      expect(refused.json().message, operationId).toBe('memory layer not found')
    }
    expect(daemon.content).toEqual([])
    expect(daemon.cleared).toEqual([])

    for (const [operationId, request] of Object.entries(PLACE_ROUTES)) {
      const answered = await as(inside, daemon).app.inject(request(PRIVATE.channelKey))
      expect(answered.statusCode, `${operationId} as a member who sees it`).toBe(ALLOWED_STATUS[operationId] ?? 200)
    }
    expect(daemon.content.length).toBeGreaterThan(0)
    expect(daemon.cleared).toEqual([])
  })

  it('answers 404 to an owner who cannot see the conversation, and for a layer that holds nothing', async () => {
    await world()
    const daemon = new PlaceDaemon()
    const owner = as(DEFAULT_OWNER_ID, daemon)
    expect((await owner.app.inject(PLACE_ROUTES.listAgentMemoryFiles!(PRIVATE.channelKey))).statusCode).toBe(404)
    expect((await owner.app.inject(PLACE_ROUTES.listAgentMemoryFiles!(ORPHAN.channelKey))).statusCode).toBe(404)
    expect((await owner.app.inject(PLACE_ROUTES.listAgentMemoryFiles!('slack-C0EXAMPLE9-absent'))).statusCode).toBe(404)
    // The shared layer is unchanged: everyone who can view the agent reads it.
    expect((await owner.app.inject({ method: 'GET', url: `${MEMORY}/files` })).statusCode).toBe(200)
    expect(daemon.content).toEqual(['list'])
  })

  it('judges a session a linked chat account owns as that member’s', async () => {
    const { linked, outside } = await world()
    const daemon = new PlaceDaemon()
    expect(
      (await as(linked, daemon, linked).app.inject(PLACE_ROUTES.listAgentMemoryFiles!(LINKED.channelKey))).statusCode
    ).toBe(200)
    expect(
      (await as(outside, daemon, linked).app.inject(PLACE_ROUTES.listAgentMemoryFiles!(LINKED.channelKey))).statusCode
    ).toBe(404)
  })
})

describe('the layer list', () => {
  const list = async (app: HttpApp) => {
    const res = await app.app.inject({ method: 'GET', url: `${MEMORY}/channels` })
    expect(res.statusCode).toBe(200)
    return (res.json() as { channels: Record<string, unknown>[] }).channels
  }

  it('lists only the layers whose conversation shows the caller a session, each named', async () => {
    const { inside, outside } = await world()
    const daemon = new PlaceDaemon()
    expect(await list(as(inside, daemon))).toEqual([
      {
        channelKey: PRIVATE.channelKey,
        channel: 'C0EXAMPLE1',
        transportScope: null,
        platform: 'slack',
        name: 'launch-room',
        visible: true,
        clearable: false
      },
      // An older daemon names nothing: the agent's sessions there give the platform and the newest name.
      {
        channelKey: OLDER.channelKey,
        channel: 'C0EXAMPLE2',
        transportScope: null,
        platform: 'slack',
        name: 'general-chat',
        visible: true,
        clearable: false
      }
    ])
    expect((await list(as(outside, daemon))).map((c) => c.channelKey)).toEqual([OLDER.channelKey])
  })

  it('also shows an owner the layers they may not read, named, to clear', async () => {
    await world()
    const channels = await list(as(DEFAULT_OWNER_ID, new PlaceDaemon()))
    expect(channels).toEqual([
      expect.objectContaining({ channelKey: PRIVATE.channelKey, name: 'launch-room', visible: false, clearable: true }),
      expect.objectContaining({ channelKey: OLDER.channelKey, name: 'general-chat', visible: true, clearable: true }),
      expect.objectContaining({ channelKey: ORPHAN.channelKey, name: null, platform: null, visible: false }),
      expect.objectContaining({ channelKey: NAMELESS.channelKey, channel: null, name: null, visible: false }),
      expect.objectContaining({ channelKey: LINKED.channelKey, visible: false, clearable: true })
    ])
  })

  it('offers no clear toward a daemon that cannot', async () => {
    await world({ features: [] })
    const channels = await list(as(DEFAULT_OWNER_ID, new PlaceDaemon()))
    expect(channels.length).toBeGreaterThan(0)
    expect(channels.every((c) => c.clearable === false)).toBe(true)
  })
})

describe('clearing a layer', () => {
  it('lets an owner clear a layer they cannot read, returning no content, and audits it without content', async () => {
    await world()
    const daemon = new PlaceDaemon()
    const res = await as(DEFAULT_OWNER_ID, daemon).app.inject({
      method: 'DELETE',
      url: `${MEMORY}/channels/${PRIVATE.channelKey}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ cleared: true })
    expect(daemon.cleared).toEqual([PRIVATE.channelKey])
    expect(daemon.content).toEqual([])
    const audit = await prisma.auditEvent.findMany({ where: { kind: 'memory_change' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      actorUserId: DEFAULT_OWNER_ID,
      details: { operation: 'clear', layer: 'place', channelKey: PRIVATE.channelKey, cleared: true }
    })
  })

  it('refuses everyone but an owner: 403 to a member who sees it, 404 to one who does not', async () => {
    const { inside, outside } = await world()
    const daemon = new PlaceDaemon()
    const url = `${MEMORY}/channels/${PRIVATE.channelKey}`
    expect((await as(inside, daemon).app.inject({ method: 'DELETE', url })).statusCode).toBe(403)
    expect((await as(outside, daemon).app.inject({ method: 'DELETE', url })).statusCode).toBe(404)
    expect(daemon.cleared).toEqual([])
    expect(await prisma.auditEvent.count({ where: { kind: 'memory_change' } })).toBe(0)
  })

  it('refuses toward a daemon that cannot clear, before asking it', async () => {
    await world({ features: [] })
    const daemon = new PlaceDaemon()
    const res = await as(DEFAULT_OWNER_ID, daemon).app.inject({
      method: 'DELETE',
      url: `${MEMORY}/channels/${PRIVATE.channelKey}`
    })
    expect(res.statusCode).toBe(409)
    expect(daemon.cleared).toEqual([])
  })

  it('drops the change log a Control-Plane home keeps for the cleared layer, and only that one', async () => {
    const { inside, outside } = await world({ memory: { provider: 'managed', home: 'control-plane' } })
    const history = new PgAgentMemoryHistoryRepo(prisma)
    const record = (after: string) => ({
      id: randomUUID(),
      path: 'notes.md',
      event: 'add' as const,
      after,
      at: new Date(),
      source: 'tool' as const,
      bytes: 10
    })
    const retention = { maxVersionsPerFile: 10, maxBytesPerRoot: 10_000 }
    await history.append(AgentId(AGENT), DEF_ORG, `channels/${PRIVATE.channelKey}/memory`, [record('room')], retention)
    await history.append(AgentId(AGENT), DEF_ORG, 'memory', [record('shared')], retention)
    // The table answers a place layer's history only to someone who sees its conversation.
    const read = PLACE_ROUTES.listAgentMemoryFileHistory!(PRIVATE.channelKey)
    const seen = await as(inside, new PlaceDaemon()).app.inject(read)
    expect(seen.json().events.map((e: { after: string }) => e.after)).toEqual(['room'])
    expect((await as(outside, new PlaceDaemon()).app.inject(read)).statusCode).toBe(404)
    const res = await as(DEFAULT_OWNER_ID, new PlaceDaemon()).app.inject({
      method: 'DELETE',
      url: `${MEMORY}/channels/${PRIVATE.channelKey}`
    })
    expect(res.statusCode).toBe(200)
    const left = await prisma.agentMemoryHistory.findMany({ where: { agentId: AGENT } })
    expect(left.map((row) => row.root)).toEqual(['memory'])
  })
})
