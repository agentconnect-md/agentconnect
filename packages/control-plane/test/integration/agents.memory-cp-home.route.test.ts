// A Control-Plane memory home is read, listed and cleared in the console from the CP's own tables, with no daemon online (memory-evolution.md §3.2.1).
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { memoryPersonKey } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEF_ORG, seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import {
  PgAgentMemoryFileRepo,
  PgAgentMemoryHistoryRepo
} from '../../src/persistence/repositories/agent-memory.repo.js'
import { AgentId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a2a2a2a2-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMORY = `${ORG}/agents/${AGENT}/memory`
const PLACE = 'slack-C0EXAMPLE1-0a1b2c3d4e5f'
const CP_HOME = { provider: 'managed', home: 'control-plane' }
// The agent's daemon is placed but not connected.
const OFFLINE: DaemonLiveness = { get: () => undefined }

/** The agent's daemon, gone: every memory frame fails as a dropped connection would, and is counted. */
class OfflineDaemon {
  calls: string[] = []
  private gone(name: string): never {
    this.calls.push(name)
    throw new Error('connection closed')
  }
  async memoryChannels() {
    return this.gone('memoryChannels')
  }
  async memoryChannelClear() {
    return this.gone('memoryChannelClear')
  }
  async memoryList() {
    return this.gone('memoryList')
  }
  async memoryRead() {
    return this.gone('memoryRead')
  }
  async memoryWrite() {
    return this.gone('memoryWrite')
  }
  async memoryHistory() {
    return this.gone('memoryHistory')
  }
}

let running: HttpApp[] = []
afterEach(async () => {
  await Promise.all(running.map((app) => app.close()))
  running = []
})

function as(userId: string, daemon: OfflineDaemon): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, OFFLINE, daemon as unknown as ControlSender)
  running.push(app)
  return app
}

async function member(sub: string): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
  return userId
}

const files = new PgAgentMemoryFileRepo(prisma)

/** Publish one file the way a daemon's write lands: a staged temp beside it, committed. */
async function put(path: string, content: string): Promise<void> {
  const temp = `${path.slice(0, path.lastIndexOf('/'))}/.agentconnect-memory-${randomUUID()}.tmp`
  await files.append(AgentId(AGENT), DEF_ORG, temp, Buffer.from(content), true, new Date())
  const done = await files.commit(AgentId(AGENT), path, temp, undefined, new Date())
  expect(done.ok).toBe(true)
}

/** A CP-homed agent on an offline daemon, with a shared store, one place layer and one person's layer. */
async function world(memory: Record<string, unknown> = CP_HOME) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, runtimeOverrides: { memory } })
  const inside = await member('cp-home-inside')
  const outside = await member('cp-home-outside')
  await seedSessionMeta(prisma, randomUUID(), AGENT, {
    channel: 'C0EXAMPLE1',
    visibility: 'private',
    ownerIdentity: `user:${inside}`
  })
  await put('memory/MEMORY.md', '# Memory\n- [deploys](deploys.md)\n')
  await put('memory/deploys.md', 'shared deploy notes')
  await put('memory/team.md', 'shared team')
  await put(
    `channels/${PLACE}/channel.json`,
    JSON.stringify({ channel: 'C0EXAMPLE1', platform: 'slack', name: 'launch-room' })
  )
  await put(`channels/${PLACE}/memory/MEMORY.md`, '# Room\n')
  await put(`channels/${PLACE}/memory/deploys.md`, 'room deploy notes')
  const person = `people/${memoryPersonKey(`user:${inside}`)}/memory`
  await put(`${person}/MEMORY.md`, '# Mine\n')
  await put(`${person}/prefs.md`, 'likes short answers')
  // Never listed: a write still staged, a nested path, and an empty folder's marker.
  await files.append(AgentId(AGENT), DEF_ORG, 'memory/half.md', Buffer.from('staged'), true, new Date())
  await put('memory/nested/deep.md', 'not a topic')
  await put(`channels/slack-C0EXAMPLE9-9a9b9c9d9e9f/memory/.marker`, '')
  return { inside, outside }
}

const get = async (app: HttpApp, url: string) => {
  const res = await app.app.inject({ method: 'GET', url })
  return { status: res.statusCode, body: res.json() as Record<string, unknown> }
}
const names = (body: Record<string, unknown>) => (body.files as { name: string }[]).map((file) => file.name)

describe('a Control-Plane memory home with no daemon online', () => {
  it('reads the shared store, a file slice and an absent file', async () => {
    const { outside } = await world()
    const daemon = new OfflineDaemon()
    const app = as(outside, daemon)

    const index = await get(app, MEMORY)
    expect(index.status).toBe(200)
    expect(index.body).toMatchObject({
      path: 'MEMORY.md',
      exists: true,
      content: '# Memory\n- [deploys](deploys.md)\n'
    })

    const listing = await get(app, `${MEMORY}/files`)
    expect(listing.body.exists).toBe(true)
    expect(names(listing.body)).toEqual(['MEMORY.md', 'deploys.md', 'team.md'])

    const slice = await get(app, `${MEMORY}/file?path=deploys.md&offset=7&limit=6`)
    expect(slice.body).toMatchObject({ exists: true, size: 19, content: 'deploy', offset: 7, nextOffset: 13 })
    expect(slice.body.truncated).toBe(true)
    expect(slice.body.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    expect((await get(app, `${MEMORY}/file?path=absent.md`)).body).toMatchObject({ exists: false })
    expect((await get(app, `${MEMORY}/file?path=half.md`)).body).toMatchObject({ exists: false })
    expect((await get(app, `${MEMORY}/file?path=..%2Fsecret.md`)).status).toBe(400)
    expect(daemon.calls).toEqual([])
  })

  it('lists and reads a place layer over the shared store, only for whom its conversation shows a session', async () => {
    const { inside, outside } = await world()
    const daemon = new OfflineDaemon()
    const member = as(inside, daemon)

    expect((await get(member, `${MEMORY}/channels`)).body).toEqual({
      channels: [
        {
          channelKey: PLACE,
          channel: 'C0EXAMPLE1',
          transportScope: null,
          platform: 'slack',
          name: 'launch-room',
          visible: true,
          clearable: false
        }
      ]
    })
    // The place layer shadows the shared store by name and keeps its own index.
    expect(names((await get(member, `${MEMORY}/files?channelKey=${PLACE}`)).body)).toEqual([
      'MEMORY.md',
      'deploys.md',
      'team.md'
    ])
    const read = (path: string) => get(member, `${MEMORY}/file?channelKey=${PLACE}&path=${path}`)
    expect((await read('MEMORY.md')).body.content).toBe('# Room\n')
    expect((await read('deploys.md')).body.content).toBe('room deploy notes')
    expect((await read('team.md')).body.content).toBe('shared team')
    expect((await get(member, `${MEMORY}/history?channelKey=${PLACE}&path=deploys.md`)).status).toBe(200)

    const stranger = as(outside, daemon)
    expect((await get(stranger, `${MEMORY}/channels`)).body).toEqual({ channels: [] })
    expect((await get(stranger, `${MEMORY}/files?channelKey=${PLACE}`)).status).toBe(404)
    expect((await get(stranger, `${MEMORY}/file?channelKey=${PLACE}&path=deploys.md`)).status).toBe(404)
    expect((await get(stranger, `${MEMORY}/history?channelKey=${PLACE}&path=deploys.md`)).status).toBe(404)
    expect(daemon.calls).toEqual([])
  })

  it('reads the signed-in caller’s own person layer and nobody else’s', async () => {
    const { inside, outside } = await world()
    const daemon = new OfflineDaemon()

    const mine = as(inside, daemon)
    expect(names((await get(mine, `${MEMORY}/mine/files`)).body)).toEqual(['MEMORY.md', 'prefs.md'])
    expect((await get(mine, `${MEMORY}/mine/file?path=prefs.md`)).body).toMatchObject({
      exists: true,
      content: 'likes short answers'
    })

    const theirs = as(outside, daemon)
    expect((await get(theirs, `${MEMORY}/mine/files`)).body).toEqual({ exists: false, files: [] })
    expect((await get(theirs, `${MEMORY}/mine/file?path=prefs.md`)).body).toMatchObject({ exists: false })
    expect(daemon.calls).toEqual([])
  })

  it('lets an owner clear a place layer, keeping only which conversation it was, and audits it', async () => {
    const { inside, outside } = await world()
    const history = new PgAgentMemoryHistoryRepo(prisma)
    const record = (after: string) => ({
      id: randomUUID(),
      path: 'deploys.md',
      event: 'add' as const,
      after,
      at: new Date(),
      source: 'tool' as const,
      bytes: 10
    })
    const retention = { maxVersionsPerFile: 10, maxBytesPerRoot: 10_000 }
    await history.append(AgentId(AGENT), DEF_ORG, `channels/${PLACE}/memory`, [record('room')], retention)
    await history.append(AgentId(AGENT), DEF_ORG, 'memory', [record('shared')], retention)
    const daemon = new OfflineDaemon()
    const url = `${MEMORY}/channels/${PLACE}`

    const owner = as(DEFAULT_OWNER_ID, daemon)
    expect((await get(owner, `${MEMORY}/channels`)).body.channels).toEqual([
      expect.objectContaining({ channelKey: PLACE, name: 'launch-room', visible: false, clearable: true })
    ])
    expect((await as(inside, daemon).app.inject({ method: 'DELETE', url })).statusCode).toBe(403)
    expect((await as(outside, daemon).app.inject({ method: 'DELETE', url })).statusCode).toBe(404)

    const res = await owner.app.inject({ method: 'DELETE', url })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ cleared: true })
    const left = await prisma.agentMemoryFile.findMany({ where: { agentId: AGENT }, select: { path: true } })
    expect(left.map((row) => row.path).filter((path) => path.startsWith(`channels/${PLACE}/`))).toEqual([
      `channels/${PLACE}/channel.json`
    ])
    expect(left.map((row) => row.path)).toContain('memory/deploys.md')
    expect((await prisma.agentMemoryHistory.findMany({ where: { agentId: AGENT } })).map((row) => row.root)).toEqual([
      'memory'
    ])
    const audit = await prisma.auditEvent.findMany({ where: { kind: 'memory_change' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      agentId: AGENT,
      actorUserId: DEFAULT_OWNER_ID,
      details: { operation: 'clear', layer: 'place', channelKey: PLACE, cleared: true }
    })

    // Gone from the list; the next write into it is still named by the kept record.
    expect((await get(owner, `${MEMORY}/channels`)).body).toEqual({ channels: [] })
    expect((await owner.app.inject({ method: 'DELETE', url })).statusCode).toBe(404)
    await put(`channels/${PLACE}/memory/deploys.md`, 'new notes')
    expect((await get(as(inside, daemon), `${MEMORY}/channels`)).body.channels).toEqual([
      expect.objectContaining({ channelKey: PLACE, name: 'launch-room', visible: true })
    ])
    expect(daemon.calls).toEqual([])
  })

  it('answers a home still receiving its copy as the daemon does, 503 with the migrating code', async () => {
    const { inside } = await world({ ...CP_HOME, homeMigration: 'pending' })
    const daemon = new OfflineDaemon()
    for (const [app, method, url] of [
      [as(inside, daemon), 'GET', MEMORY],
      [as(inside, daemon), 'GET', `${MEMORY}/files`],
      [as(inside, daemon), 'GET', `${MEMORY}/file?path=deploys.md`],
      [as(inside, daemon), 'GET', `${MEMORY}/files?channelKey=${PLACE}`],
      [as(inside, daemon), 'GET', `${MEMORY}/channels`],
      [as(inside, daemon), 'GET', `${MEMORY}/mine/files`],
      [as(inside, daemon), 'GET', `${MEMORY}/mine/file`],
      [as(DEFAULT_OWNER_ID, daemon), 'DELETE', `${MEMORY}/channels/${PLACE}`]
    ] as const) {
      const res = await app.app.inject({ method, url })
      expect(res.statusCode, url).toBe(503)
      expect(res.json().code, url).toBe('MEMORY_HOME_MIGRATING')
    }
    expect(await prisma.agentMemoryFile.count({ where: { agentId: AGENT, path: { startsWith: 'channels/' } } })).toBe(4)
    expect(daemon.calls).toEqual([])
  })

  it('still sends an edit to the daemon, which owns the write path', async () => {
    const { inside } = await world()
    const daemon = new OfflineDaemon()
    const res = await as(inside, daemon).app.inject({
      method: 'PUT',
      url: `${MEMORY}/file?path=deploys.md`,
      payload: { content: 'edited' }
    })
    expect(res.statusCode).toBe(503)
    expect(daemon.calls).toEqual(['memoryWrite'])
  })
})

describe('a daemon memory home', () => {
  it('is still read through its daemon, so an offline one answers 503', async () => {
    const { inside } = await world({ provider: 'managed', home: 'daemon' })
    const daemon = new OfflineDaemon()
    const app = as(inside, daemon)
    expect((await get(app, `${MEMORY}/files`)).status).toBe(503)
    expect((await get(app, `${MEMORY}/channels`)).status).toBe(503)
    expect((await get(app, `${MEMORY}/mine/files`)).status).toBe(503)
    expect(daemon.calls).toEqual(['memoryList', 'memoryChannels'])
  })
})

// assistant-mode.md §5.17: the people directory in a Control-Plane home is read and cleared from the CP's tables.
describe('the people directory in a Control-Plane memory home', () => {
  const directory = (inside: string) =>
    [
      '# Members',
      '',
      `## Inside \`user:${inside}\``,
      'Role: release manager (self, 2026-10-02)',
      '',
      '## Bob (@bob on Slack) `slack:T0EXAMPLE:U0BOB`',
      'Works on: billing (#release-train, 2026-10-15)',
      ''
    ].join('\n')
  const fileText = async (path: string) =>
    Buffer.from((await files.read(AgentId(AGENT), path, 0, 1024 * 1024))?.slice ?? []).toString('utf8')

  it('shows a person only their own entry, and lets them clear it, which keeps them out', async () => {
    const { inside, outside } = await world()
    await put('memory/members.md', directory(inside))
    const daemon = new OfflineDaemon()

    const mine = await get(as(inside, daemon), `${MEMORY}/mine/member`)
    expect(mine.body).toEqual({
      entries: [
        { key: `user:${inside}`, text: `## Inside \`user:${inside}\`\nRole: release manager (self, 2026-10-02)` }
      ],
      clearable: true
    })
    expect((await get(as(outside, daemon), `${MEMORY}/mine/member`)).body).toEqual({ entries: [], clearable: true })

    const res = await as(inside, daemon).app.inject({ method: 'DELETE', url: `${MEMORY}/mine/member` })
    expect(res.json()).toEqual({ cleared: true })
    expect(await fileText('memory/members.md')).not.toContain('Inside')
    expect(await fileText('memory/members.md')).toContain('`slack:T0EXAMPLE:U0BOB`')
    expect(JSON.parse(await fileText('people/.directory-opt-out.json')).keys).toHaveProperty(`user:${inside}`)
    expect(daemon.calls).toEqual([])
  })

  it('lists entries by name to everyone and lets only an owner clear one, audited without content', async () => {
    const { inside } = await world()
    await put('memory/members.md', directory(inside))
    const daemon = new OfflineDaemon()
    const url = `${MEMORY}/members/${encodeURIComponent('slack:T0EXAMPLE:U0BOB')}`

    expect((await get(as(inside, daemon), `${MEMORY}/members`)).body).toEqual({
      entries: [
        { key: `user:${inside}`, name: 'Inside' },
        { key: 'slack:T0EXAMPLE:U0BOB', name: 'Bob (@bob on Slack)' }
      ],
      clearable: false
    })
    expect((await as(inside, daemon).app.inject({ method: 'DELETE', url })).statusCode).toBe(403)

    const owner = as(DEFAULT_OWNER_ID, daemon)
    expect((await get(owner, `${MEMORY}/members`)).body.clearable).toBe(true)
    const res = await owner.app.inject({ method: 'DELETE', url })
    expect(res.json()).toEqual({ cleared: true })
    expect(await fileText('memory/members.md')).not.toContain('Bob')
    const audit = await prisma.auditEvent.findMany({ where: { kind: 'memory_change' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      agentId: AGENT,
      actorUserId: DEFAULT_OWNER_ID,
      frameType: 'memory/member/clear',
      details: { operation: 'clear', layer: 'shared', file: 'members.md', key: 'slack:T0EXAMPLE:U0BOB', cleared: true }
    })
    expect(JSON.stringify([audit[0]!.message, audit[0]!.details])).not.toContain('billing')
    expect(
      (await owner.app.inject({ method: 'DELETE', url: `${MEMORY}/members/${encodeURIComponent('Bob')}` })).statusCode
    ).toBe(400)
    expect(daemon.calls).toEqual([])
  })
})
