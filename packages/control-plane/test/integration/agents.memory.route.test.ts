/**
 * Agent memory routes — proxied live from the owning daemon (the CP stores no
 * memory content, body-locality §1/§12). Memory is a directory: a MEMORY.md index
 * plus topic files.
 *
 * - `GET /agents/:id/memory` proxies the index; `GET …/memory/files` lists the dir;
 *   `GET …/memory/file?path=` reads a named file; `PUT …/memory/file?path=` writes;
 *   `GET …/memory/history?path=` pages managed provenance.
 * - A not-yet-created file/dir is data (`exists:false`). 404 unknown agent, 503
 *   unplaced/offline; PUT is edit-gated.
 *
 * Driven with `app.inject`, a spy `ControlSender`, and a liveness override.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { ProtocolError } from '../../src/domain/errors.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type {
  MemoryListReq,
  MemoryListPage,
  MemoryReadReq,
  MemoryReadContent,
  MemoryWriteReq,
  MemoryWriteOk,
  MemoryHistoryReq,
  MemoryHistoryPage,
  MemorySurfaceReq,
  MemorySurfaceInfo,
  MemoryRecordSearchReq,
  MemoryRecordSearchPage,
  MemoryRecordListReq,
  MemoryRecordListPage,
  MemoryRecordGetReq,
  MemoryRecordGetResult,
  MemoryRecordCreateReq,
  MemoryRecordCreateResult,
  MemoryRecordUpdateReq,
  MemoryRecordUpdateResult,
  MemoryRecordDeleteReq,
  MemoryRecordDeleteResult,
  MemoryRecordHistoryReq,
  MemoryRecordHistoryPage,
  CanonicalMemoryRecord
} from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

/** A ControlSender spy answering the memory frames with canned data. */
class SpyControl {
  listCalls: Array<{ daemonId: string; req: MemoryListReq }> = []
  readCalls: Array<{ daemonId: string; req: MemoryReadReq }> = []
  writeCalls: Array<{ daemonId: string; req: MemoryWriteReq }> = []
  historyCalls: Array<{ daemonId: string; req: MemoryHistoryReq }> = []
  constructor(
    private readonly list: MemoryListPage,
    private readonly read: MemoryReadContent,
    private readonly write: MemoryWriteOk,
    private readonly history: MemoryHistoryPage
  ) {}
  async memoryList(daemonId: string, req: MemoryListReq): Promise<MemoryListPage> {
    this.listCalls.push({ daemonId, req })
    return this.list
  }
  async memoryRead(daemonId: string, req: MemoryReadReq): Promise<MemoryReadContent> {
    this.readCalls.push({ daemonId, req })
    return this.read
  }
  async memoryWrite(daemonId: string, req: MemoryWriteReq): Promise<MemoryWriteOk> {
    this.writeCalls.push({ daemonId, req })
    return this.write
  }
  async memoryHistory(daemonId: string, req: MemoryHistoryReq): Promise<MemoryHistoryPage> {
    this.historyCalls.push({ daemonId, req })
    return this.history
  }
}

const spy = (
  over: Partial<{
    list: MemoryListPage
    read: MemoryReadContent
    write: MemoryWriteOk
    history: MemoryHistoryPage
  }> = {}
) =>
  new SpyControl(
    over.list ?? { agentId: AGENT, exists: false, entries: [] },
    over.read ?? { agentId: AGENT, path: 'MEMORY.md', exists: false },
    over.write ?? { agentId: AGENT, path: 'MEMORY.md', size: 0, mtime: '2026-07-07T00:00:00.000Z' },
    over.history ?? { agentId: AGENT, path: 'MEMORY.md', events: [] }
  )

describe('GET /agents/:id/memory (index) + /memory/files (list) + /memory/file', () => {
  it('proxies the index and defaults the path to MEMORY.md', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = spy({
      read: {
        agentId: AGENT,
        path: 'MEMORY.md',
        exists: true,
        size: 6,
        mtime: '2026-07-07T00:00:00.000Z',
        content: '# idx\n',
        offset: 0,
        nextOffset: 6,
        truncated: false
      }
    })
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/memory` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { path: string; exists: boolean; content: string | null }
    expect(body.exists).toBe(true)
    expect(body.content).toBe('# idx\n')
    expect(s.readCalls[0]!.req.path).toBe('MEMORY.md')
  })

  it('lists the memory dir', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = spy({
      list: {
        agentId: AGENT,
        exists: true,
        entries: [
          { name: 'MEMORY.md', size: 20, mtime: '2026-07-07T00:00:00.000Z' },
          { name: 'deploys.md', size: 40, mtime: '2026-07-07T00:00:00.000Z' }
        ]
      }
    })
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/memory/files` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { exists: boolean; files: { name: string }[] }
    expect(body.exists).toBe(true)
    expect(body.files.map((f) => f.name)).toEqual(['MEMORY.md', 'deploys.md'])
  })

  it('reads a named topic file via ?path=', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = spy({
      read: {
        agentId: AGENT,
        path: 'deploys.md',
        exists: true,
        size: 5,
        mtime: '2026-07-07T00:00:00.000Z',
        content: 'ship!',
        offset: 0,
        nextOffset: 5,
        truncated: false
      }
    })
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/memory/file?path=deploys.md` })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { content: string }).content).toBe('ship!')
    expect(s.readCalls[0]!.req.path).toBe('deploys.md')
  })

  it('404s for an unknown agent', async () => {
    running = buildHttpApp(prisma, undefined, LIVE)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${randomUUID()}/memory/files` })
    expect(res.statusCode).toBe(404)
  })

  it('503s when the agent has no owning daemon', async () => {
    await seedAgent(prisma, AGENT) // unplaced
    running = buildHttpApp(prisma, undefined, LIVE)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/memory` })
    expect(res.statusCode).toBe(503)
  })

  it('pages one managed file history newest first', async () => {
    const cursor = randomUUID()
    const nextCursor = randomUUID()
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = spy({
      history: {
        agentId: AGENT,
        path: 'deploys.md',
        events: [
          {
            path: 'deploys.md',
            event: 'update',
            before: 'v1',
            after: 'v2',
            at: '2026-07-07T01:02:03.000Z',
            scope: 'agent',
            source: 'console'
          }
        ],
        nextCursor
      }
    })
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/memory/history?path=deploys.md&cursor=${cursor}&limit=3`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      events: [{ event: 'update', before: 'v1', after: 'v2', source: 'console' }],
      nextCursor
    })
    expect(s.historyCalls[0]).toEqual({
      daemonId: DAEMON,
      req: { agentId: AGENT, path: 'deploys.md', cursor, limit: 3 }
    })
  })
})

describe('PUT /agents/:id/memory/file (replace, edit-gated, proxied)', () => {
  it('writes the named file and returns path + size + mtime', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = spy({ write: { agentId: AGENT, path: 'deploys.md', size: 21, mtime: '2026-07-07T01:02:03.000Z' } })
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/memory/file?path=deploys.md`,
      payload: { content: '# new\n- remember this' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { path: string; size: number; mtime: string }
    expect(body.path).toBe('deploys.md')
    expect(body.size).toBe(21)
    expect(s.writeCalls[0]!.req.path).toBe('deploys.md')
    expect(s.writeCalls[0]!.req.content).toBe('# new\n- remember this')
  })

  it('defaults the path to MEMORY.md when ?path is omitted', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = spy()
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)
    await running.app.inject({ method: 'PUT', url: `${ORG}/agents/${AGENT}/memory/file`, payload: { content: 'x' } })
    expect(s.writeCalls[0]!.req.path).toBe('MEMORY.md')
  })

  it('forwards ifMatchMtime and maps a daemon CONFLICT to 409', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    // A spy whose memoryWrite rejects with a CONFLICT ProtocolError (stale precondition).
    const s = {
      writeCalls: [] as Array<{ req: MemoryWriteReq }>,
      async memoryWrite(_d: string, req: MemoryWriteReq): Promise<MemoryWriteOk> {
        this.writeCalls.push({ req })
        throw new ProtocolError('CONFLICT', 'the memory file changed; reload and retry')
      }
    }
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/memory/file?path=notes.md`,
      payload: { content: 'x', ifMatchMtime: '2026-07-07T00:00:00.000Z' }
    })
    expect(res.statusCode).toBe(409)
    expect(s.writeCalls[0]!.req.ifMatchMtime).toBe('2026-07-07T00:00:00.000Z')
  })

  it('maps a daemon BAD_PAYLOAD (over-budget / bad path) to 400', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = {
      async memoryWrite(): Promise<MemoryWriteOk> {
        throw new ProtocolError('BAD_PAYLOAD', 'memory file exceeds the limit')
      }
    }
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)
    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/memory/file`,
      payload: { content: 'x' }
    })
    expect(res.statusCode).toBe(400)
  })

  it("answers a sleeping sandbox with the workspace reader's 503 + code on every file route", async () => {
    // A cluster agent's memory tree is on its sandbox volume; the daemon refuses with the workspace
    // reader's reason, and the console wakes the sandbox on this code (#1077) — never a 400.
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const asleep = () => {
      throw new ProtocolError('BAD_PAYLOAD', 'memory/list failed: agent has no running sandbox', {
        details: { reason: 'sandbox-unavailable' }
      })
    }
    const s = {
      memoryList: asleep,
      memoryRead: asleep,
      memoryWrite: asleep,
      memoryHistory: asleep,
      memoryChannels: asleep
    }
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)
    for (const request of [
      { method: 'GET' as const, url: `${ORG}/agents/${AGENT}/memory/files` },
      { method: 'GET' as const, url: `${ORG}/agents/${AGENT}/memory` },
      { method: 'GET' as const, url: `${ORG}/agents/${AGENT}/memory/file?path=deploys.md` },
      { method: 'GET' as const, url: `${ORG}/agents/${AGENT}/memory/history?path=MEMORY.md` },
      { method: 'GET' as const, url: `${ORG}/agents/${AGENT}/memory/channels` },
      { method: 'PUT' as const, url: `${ORG}/agents/${AGENT}/memory/file`, payload: { content: 'x' } }
    ]) {
      const res = await running.app.inject(request)
      expect(res.statusCode, request.url).toBe(503)
      expect((res.json() as { code?: string }).code, request.url).toBe('WORKSPACE_SANDBOX_UNAVAILABLE')
    }
  })

  it('rejects an unknown body field (.strict)', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    running = buildHttpApp(prisma, undefined, LIVE)
    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/memory/file`,
      payload: { content: 'x', extra: 'nope' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('503s when the agent has no owning daemon', async () => {
    await seedAgent(prisma, AGENT) // unplaced
    running = buildHttpApp(prisma, undefined, LIVE)
    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/memory/file`,
      payload: { content: 'x' }
    })
    expect(res.statusCode).toBe(503)
  })
})

describe('provider-aware external record routes', () => {
  const CONNECTION = '11111111-1111-4111-8111-111111111111'
  const record: CanonicalMemoryRecord = {
    id: 'record-1',
    text: 'deploy in sea',
    scope: { kind: 'agent', key: `ac:agent:${AGENT}` },
    updatedAt: '2026-07-16T00:00:00.000Z',
    version: 'v1'
  }

  class RecordSpy {
    surfaceCalls: MemorySurfaceReq[] = []
    searchCalls: MemoryRecordSearchReq[] = []
    listCalls: MemoryRecordListReq[] = []
    createCalls: MemoryRecordCreateReq[] = []
    updateCalls: MemoryRecordUpdateReq[] = []
    deleteCalls: MemoryRecordDeleteReq[] = []
    historyCalls: MemoryRecordHistoryReq[] = []
    async memorySurface(_daemonId: string, req: MemorySurfaceReq): Promise<MemorySurfaceInfo> {
      this.surfaceCalls.push(req)
      return {
        agentId: AGENT,
        shape: 'records',
        capabilities: ['recall', 'list', 'get', 'create', 'update', 'delete', 'history']
      }
    }
    async memoryRecordSearch(_daemonId: string, req: MemoryRecordSearchReq): Promise<MemoryRecordSearchPage> {
      this.searchCalls.push(req)
      return { agentId: AGENT, records: [record] }
    }
    async memoryRecordList(_daemonId: string, req: MemoryRecordListReq): Promise<MemoryRecordListPage> {
      this.listCalls.push(req)
      return { agentId: AGENT, records: [record], nextCursor: 'next' }
    }
    async memoryRecordGet(_daemonId: string, _req: MemoryRecordGetReq): Promise<MemoryRecordGetResult> {
      return { agentId: AGENT, record }
    }
    async memoryRecordCreate(_daemonId: string, req: MemoryRecordCreateReq): Promise<MemoryRecordCreateResult> {
      this.createCalls.push(req)
      return { agentId: AGENT, record: { ...record, id: 'record-new', text: req.text } }
    }
    async memoryRecordUpdate(_daemonId: string, req: MemoryRecordUpdateReq): Promise<MemoryRecordUpdateResult> {
      this.updateCalls.push(req)
      return { agentId: AGENT, record: { ...record, text: req.text, version: 'v2' } }
    }
    async memoryRecordDelete(_daemonId: string, req: MemoryRecordDeleteReq): Promise<MemoryRecordDeleteResult> {
      this.deleteCalls.push(req)
      return { agentId: AGENT, id: req.id, deleted: true }
    }
    async memoryRecordHistory(_daemonId: string, req: MemoryRecordHistoryReq): Promise<MemoryRecordHistoryPage> {
      this.historyCalls.push(req)
      return {
        agentId: AGENT,
        events: [{ id: 'event-1', event: 'update', at: '2026-07-16T00:00:00.000Z', record }]
      }
    }
  }

  const seedExternal = async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.agent.update({
      where: { id: AGENT },
      data: { runtimeOverrides: { memory: { provider: 'external', connectionId: CONNECTION } } }
    })
  }

  it('discovers records/capabilities and proxies search/list without backend identity', async () => {
    await seedExternal()
    const s = new RecordSpy()
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const surface = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/memory/surface` })
    expect(surface.statusCode).toBe(200)
    expect(surface.json()).toEqual({
      shape: 'records',
      capabilities: ['recall', 'list', 'get', 'create', 'update', 'delete', 'history']
    })
    expect(JSON.stringify(surface.json())).not.toContain('plugin')

    const list = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/memory/records?limit=10&cursor=first`
    })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject({ records: [{ id: 'record-1', version: 'v1' }], nextCursor: 'next' })
    expect(s.listCalls[0]).toMatchObject({ agentId: AGENT, limit: 10, cursor: 'first' })

    const search = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/memory/records/search`,
      payload: { query: 'deploy', topK: 3, maxBytes: 4096 }
    })
    expect(search.statusCode).toBe(200)
    expect(s.searchCalls[0]).toMatchObject({ query: 'deploy', topK: 3, maxBytes: 4096 })

    const files = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/memory/files` })
    expect(files.statusCode).toBe(400)
    expect(files.json()).toMatchObject({ message: 'external memory does not expose files' })

    const managedHistory = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/memory/history?path=MEMORY.md`
    })
    expect(managedHistory.statusCode).toBe(400)
  })

  it('generates operation ids and preserves record version across create/update/delete/history', async () => {
    await seedExternal()
    const s = new RecordSpy()
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const created = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/memory/records`,
      payload: { text: 'ship safely', metadata: { source: 'console' } }
    })
    expect(created.statusCode).toBe(200)
    expect(s.createCalls[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.createCalls[0]?.metadata).toEqual({ source: 'console' })

    const oversized = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/memory/records`,
      payload: { text: 'small', metadata: { blob: 'x'.repeat(70 * 1024) } }
    })
    expect(oversized.statusCode).toBe(400)
    expect(s.createCalls).toHaveLength(1)

    const updated = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/memory/records/record-1`,
      payload: { text: 'ship and verify', version: 'v1' }
    })
    expect(updated.statusCode).toBe(200)
    expect(s.updateCalls[0]).toMatchObject({ id: 'record-1', text: 'ship and verify', version: 'v1' })
    expect(s.updateCalls[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/)

    const deleted = await running.app.inject({
      method: 'DELETE',
      url: `${ORG}/agents/${AGENT}/memory/records/record-1`,
      payload: { version: 'v2' }
    })
    expect(deleted.statusCode).toBe(200)
    expect(s.deleteCalls[0]).toMatchObject({ id: 'record-1', version: 'v2' })
    expect(s.deleteCalls[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/)

    const history = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/memory/records/record-1/history?limit=5`
    })
    expect(history.statusCode).toBe(200)
    expect(history.json()).toMatchObject({ events: [{ id: 'event-1', event: 'update' }], nextCursor: null })
    expect(s.historyCalls[0]).toMatchObject({ id: 'record-1', limit: 5 })
  })

  it('maps capability rejection to 400 and does not expose record routes for managed memory', async () => {
    await seedExternal()
    const rejected = {
      async memoryRecordList(): Promise<MemoryRecordListPage> {
        throw new ProtocolError('BAD_PAYLOAD', 'this memory provider does not support list')
      }
    }
    running = buildHttpApp(prisma, undefined, LIVE, rejected as unknown as ControlSender)
    const unavailable = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/memory/records`
    })
    expect(unavailable.statusCode).toBe(400)
    await running.close()

    await prisma.agent.update({ where: { id: AGENT }, data: { runtimeOverrides: {} } })
    running = buildHttpApp(prisma, undefined, LIVE)
    const managed = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/memory/records` })
    expect(managed.statusCode).toBe(400)
  })

  it('maps a daemon optimistic-concurrency rejection to HTTP 409', async () => {
    await seedExternal()
    const conflicted = {
      async memoryRecordUpdate(): Promise<MemoryRecordUpdateResult> {
        throw new ProtocolError('CONFLICT', 'memory record changed since the supplied version')
      }
    }
    running = buildHttpApp(prisma, undefined, LIVE, conflicted as unknown as ControlSender)
    const response = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/memory/records/record-1`,
      payload: { text: 'replacement', version: 'v1' }
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'Conflict', statusCode: 409 })
  })
})
