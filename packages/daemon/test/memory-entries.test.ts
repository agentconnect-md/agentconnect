import { createMemoryEntryService } from '../src/memory/entries/factory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_ENTRY_FRAME_BYTES } from '@agentconnect.md/protocol'
import { localMemoryHome } from '../src/memory/home.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { ManagedMemoryProvider } from '../src/memory/providers/managed.js'
import { createMemoryProvider } from '../src/memory/provider.js'
import { MemoryEntries } from '../src/memory/entries/service.js'
import { MemoryEntryTokens } from '../src/memory/entries/tokens.js'
import { ExternalMemoryEntries } from '../src/memory/entries/external.js'
import { memoryContinuations, memoryEntryTokens } from '../src/memory/entries/state.js'
import type { MemoryEntriesView } from '../src/memory/entries/contract.js'
import type { MemoryRecord, RecordMemoryAdmin } from '../src/memory/types.js'
import type { LocalStore } from '../src/store/local-store.js'
import { memoryStoreDatabase, openTestStore, usingPostgresStore } from './store-support.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-entries-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.sqlite')
  const db = await openTestStore(path)
  cleanup.push(() => db.close())
  return { db, dir, path }
}
async function service(db: LocalStore, resolve: () => Promise<MemoryEntriesView>, agent = 'a') {
  return new MemoryEntries(resolve, await memoryEntryTokens(db), memoryContinuations(db, agent))
}
async function fixture(kind: 'managed' | 'external', count = 37) {
  const { db, dir, path } = await store()
  const records = new Map<string, MemoryRecord>()
  const requests: { cursor?: string; limit: number }[] = []
  const root = new LocalMemoryFs(dir)
  const provider = new ManagedMemoryProvider(() => localMemoryHome(root))
  for (let i = 0; i < count; i++) {
    const id = `topic-${String(i).padStart(3, '0')}.md`
    const text = `Fact ${i}`
    records.set(id, { id, text, scope: { kind: 'agent', key: 'ac:agent:a' } })
    if (kind === 'managed') await root.writeFile(`memory/${id}`, text)
  }
  const admin: RecordMemoryAdmin = {
    shape: 'records',
    capabilities: new Set(['list', 'get']),
    async list(_scope, request) {
      requests.push(request)
      const rows = [...records.values()]
      const start = Number(request.cursor ?? 0)
      return {
        records: rows.slice(start, start + request.limit),
        ...(start + request.limit < rows.length ? { nextCursor: String(start + request.limit) } : {})
      }
    },
    async get(_scope, id) {
      return records.get(id) ?? null
    },
    async search() {
      throw new Error('unsupported')
    },
    async create() {
      throw new Error('unsupported')
    },
    async update() {
      throw new Error('unsupported')
    },
    async delete() {
      throw new Error('unsupported')
    },
    async history() {
      throw new Error('unsupported')
    }
  }
  let binding = 'binding-1'
  const resolve = async () =>
    kind === 'managed'
      ? provider.entryView({ agentId: binding })
      : new ExternalMemoryEntries(admin, { agentId: 'a' }, binding, { maxItemBytes: 131072, maxPageItems: 7 })
  const api = await service(db, resolve)
  return {
    path,
    api,
    db,
    root,
    provider,
    records,
    admin,
    requests,
    resolve,
    replaceBinding() {
      binding = 'binding-2'
    }
  }
}

describe.each(['managed', 'external'] as const)('unified %s reads', (kind) => {
  it('enumerates over 20 records without omissions, and retrieves the same bytes', async () => {
    const f = await fixture(kind)
    const names: string[] = []
    let cursor: string | undefined
    do {
      const page = await f.api.list({ ...(cursor ? { cursor } : {}) })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MEMORY_ENTRY_FRAME_BYTES)
      expect(page.consistency).toBe('live')
      expect(page.order).toBe(kind === 'managed' ? 'topic' : 'backend')
      expect(page.entries.length).toBeLessThanOrEqual(kind === 'managed' ? 20 : 7)
      for (const entry of page.entries) {
        const content = await f.api.get({ ref: entry.ref })
        names.push(content!.text)
        expect(content!.complete).toBe(true)
        expect(entry.editable).toBe(false)
      }
      cursor = page.nextCursor
      expect(names.length).toBeLessThanOrEqual(37)
    } while (cursor)
    expect(new Set(names).size).toBe(37)
    expect(f.requests.every((request) => request.limit === 7)).toBe(true)
  })

  it('binds refs and continuations to the current store, and rejects forged arguments', async () => {
    const f = await fixture(kind)
    const first = await f.api.list({ limit: 2 })
    await expect(f.api.list({ cursor: first.nextCursor, limit: 3 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(f.api.get({ ref: first.entries[0]!.ref, agentId: 'other' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    await expect(f.api.get({ ref: 'topic-000.md' })).rejects.toMatchObject({ code: 'STALE_BINDING' })
    f.replaceBinding()
    await expect(f.api.get({ ref: first.entries[0]!.ref })).rejects.toMatchObject({ code: 'STALE_BINDING' })
    await expect(f.api.list({ cursor: first.nextCursor, limit: 2 })).rejects.toMatchObject({ code: 'STALE_BINDING' })
  })

  it('slices UTF-8 and JSON escapes within the encoded frame budget, with revision checks', async () => {
    const f = await fixture(kind, 1)
    const text = '\u0000\"\\中😀'.repeat(7000)
    if (kind === 'managed') await f.root.writeFile('memory/topic-000.md', text)
    else f.records.get('topic-000.md')!.text = text
    const { ref } = (await f.api.list()).entries[0]!
    let cursor: string | undefined
    let result = ''
    do {
      const page = await f.api.get({ ref, ...(cursor ? { cursor } : {}) })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MEMORY_ENTRY_FRAME_BYTES)
      expect(page!.text).not.toContain('\ufffd')
      result += page!.text
      cursor = page!.nextContentCursor
    } while (cursor)
    expect(result).toBe(text)
    const first = await f.api.get({ ref, maxBytes: 4 })
    if (kind === 'managed') await f.root.writeFile('memory/topic-000.md', 'changed')
    else f.records.get('topic-000.md')!.text = 'changed'
    await expect(f.api.get({ ref, cursor: first!.nextContentCursor, maxBytes: 4 })).rejects.toMatchObject({
      code: 'CONFLICT'
    })
  })

  it('distinguishes deletion from a service outage', async () => {
    const f = await fixture(kind, 1)
    const { ref } = (await f.api.list()).entries[0]!
    if (kind === 'managed') await f.root.rm('memory/topic-000.md')
    else f.records.clear()
    expect(await f.api.get({ ref })).toBeNull()
    const unavailable = await service(f.db, async () => {
      throw new Error('private backend endpoint')
    })
    await expect(unavailable.list()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'memory service is temporarily unavailable'
    })
  })
})

it('keeps managed Markdown, unknown YAML and empty shadows intact; keeps the index separate', async () => {
  const f = await fixture('managed', 0)
  const text = '---\nname: Deploy\ndescription: Release rules\nunknown:\n  nested: true # preserve\n---\n\n[[other]]\n'
  await f.root.writeFile('memory/rules.md', text)
  await f.root.writeFile('memory/MEMORY.md', 'Legacy index with unique knowledge')
  const api = await service(f.db, () => f.provider.entryView({ agentId: 'a', channelKey: 'channel' }))
  const first = await api.list()
  expect(first.entries).toHaveLength(1)
  expect(first.entries[0]).toMatchObject({
    label: 'Deploy',
    description: 'Release rules',
    origin: 'inherited',
    editable: false
  })
  expect((await api.get({ ref: first.entries[0]!.ref }))!.text).toBe(text)
  await f.provider.write({ agentId: 'a', channelKey: 'channel' }, 'rules.md', '')
  expect(await api.get({ ref: first.entries[0]!.ref })).toBeNull()
  const entry = (await api.list()).entries[0]!
  expect(entry.origin).toBe('active')
  expect(await api.get({ ref: entry.ref })).toMatchObject({ text: '', complete: true })
  expect((await api.context()).overview).toContain('Legacy index with unique knowledge')
})

it('retains captured managed summaries while live entries change', async () => {
  const f = await fixture('managed', 3)
  const first = await f.api.list({ limit: 1 })
  await f.root.rm('memory/topic-001.md')
  await f.root.writeFile('memory/aaa.md', 'new')
  const next = await f.api.list({ limit: 1, cursor: first.nextCursor })
  expect(next.entries[0]!.label).toBe('topic-001')
  expect(next.catalogRevision).toBe(first.catalogRevision)
  expect(await f.api.get({ ref: next.entries[0]!.ref })).toBeNull()
})

it('retains maximum plugin cursors, accepts empty continuing pages, and detects cursor loops', async () => {
  const f = await fixture('external', 0)
  const backendCursor = 'x'.repeat(2048)
  let calls = 0
  f.admin.list = async (_scope, request) => {
    calls++
    if (calls === 1) return { records: [], nextCursor: backendCursor }
    expect(request.cursor).toBe(backendCursor)
    return { records: [], nextCursor: backendCursor }
  }
  const page = await f.api.list()
  expect(page.entries).toEqual([])
  expect(page.nextCursor!.length).toBeLessThanOrEqual(2048)
  await expect(f.api.list({ cursor: page.nextCursor })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
})

it('checks live capabilities, and external catalogs make no completeness claim or enumeration call', async () => {
  const f = await fixture('external')
  expect(await f.api.context()).toEqual({ overview: '', freshness: 'unknown', coverage: 'unavailable' })
  expect(f.requests).toHaveLength(0)
  ;(f.admin.capabilities as Set<string>).delete('list')
  expect((await f.api.describe()).operations).toEqual(['get'])
  await expect(f.api.list()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
})

it('persists cursors and entry keys across restart, expires explicitly and bounds retained slots', async () => {
  const f = await fixture('managed', 3)
  const page = await f.api.list({ limit: 1 })
  const reopened = await openTestStore(f.path)
  cleanup.push(() => reopened.close())
  const restarted = await service(reopened, f.resolve)
  expect((await restarted.get({ ref: page.entries[0]!.ref }))!.text).toBe('Fact 0')
  expect((await restarted.list({ cursor: page.nextCursor, limit: 1 })).entries[0]!.label).toBe('topic-001')
  expect(await f.db.getMemoryEntryContinuation('other', page.nextCursor!, Date.now())).toBeUndefined()
  expect(await f.db.getMemoryEntryContinuation('a', page.nextCursor!, Date.now() + 31 * 60 * 1000)).toBeUndefined()
  for (let i = 0; i < 20; i++) await f.db.putMemoryEntryContinuation('a', '{}', Date.now() + 60 * 60 * 1000 + i)
  await expect(restarted.list({ cursor: page.nextCursor, limit: 1 })).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
})

it('binds a Dream to its staged root before consulting a changed live provider', async () => {
  const { db, dir } = await store()
  const staged = new LocalMemoryFs(join(dir, 'draft'))
  const provider = createMemoryProvider({
    memoryHomePortsFor: () => localMemoryHome(new LocalMemoryFs(dir)),
    agentDirByAgent: () => dir,
    runtimeFor: () => undefined,
    providerKindFor: () => 'external'
  })
  const api = await service(db, async () => (await provider.entryView({ agentId: 'a', root: staged }))!)
  expect((await api.list()).entries).toEqual([])
  await staged.writeFile('memory/draft.md', 'proposal only')
  expect((await api.list()).entries).toHaveLength(1)
})

it('rejects tampered refs even when the caller knows a provider coordinate', () => {
  const codec = new MemoryEntryTokens(randomBytes(32))
  const ref = codec.ref('view', { partition: 'agent', id: 'backend-id' })
  const bytes = Buffer.from(ref, 'base64url')
  bytes[bytes.length - 1]! ^= 1
  expect(() => codec.coordinate('view', bytes.toString('base64url'))).toThrow('current view')
})

it('rechecks caller read authority before resolving a memory home', async () => {
  const f = await fixture('managed', 1)
  let allowed = true
  const api = await createMemoryEntryService({
    provider: f.provider,
    scope: { agentId: 'a' },
    store: f.db,
    canRead: () => allowed
  })
  const page = await api.list()
  allowed = false
  await expect(api.get({ ref: page.entries[0]!.ref })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(api.describe()).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('invalidates references after a managed tree is replaced and reserves lineage from legacy writes', async () => {
  const f = await fixture('managed', 1)
  const page = await f.api.list()
  await expect(f.provider.write({ agentId: 'a' }, '.entry-lineage', 'forged')).rejects.toThrow('reserved')
  await f.root.rm('memory')
  await f.root.writeFile('memory/topic-000.md', 'new tree, same filename')
  await expect(f.api.get({ ref: page.entries[0]!.ref })).rejects.toMatchObject({ code: 'STALE_BINDING' })
})

it('reports changed catalogs without reading topic bodies on every context request', async () => {
  const f = await fixture('managed', 1)
  const initial = await f.api.context()
  expect(initial).toMatchObject({ freshness: 'cached', coverage: 'partial' })
  await f.provider.write({ agentId: 'binding-1' }, 'topic-000.md', '---\ndescription: updated\n---\nchanged body')
  const updated = await f.api.context({ seenRevision: initial.catalogRevision })
  expect(updated.catalogRevision).not.toBe(initial.catalogRevision)
  expect(updated.overview).toContain('updated')
  expect((await f.api.context({ seenRevision: updated.catalogRevision })).overview).toBe('')
})

it('never exposes another agent record even from a misbehaving adapter', async () => {
  const f = await fixture('external', 1)
  f.records.get('topic-000.md')!.scope.key = 'ac:agent:other'
  await expect(f.api.list()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
})

it('retains summaries that do not fit one encoded page rather than forwarding past them', async () => {
  const f = await fixture('managed', 0)
  for (let i = 0; i < 30; i++)
    await f.root.writeFile(
      `memory/item-${i}.md`,
      `---\nname: ${'中'.repeat(500)}\ndescription: ${'😀'.repeat(500)}\n---\n${i}`
    )
  let cursor: string | undefined
  const contents: string[] = []
  let pages = 0
  do {
    const page = await f.api.list({ limit: 100, ...(cursor ? { cursor } : {}) })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MEMORY_ENTRY_FRAME_BYTES)
    for (const entry of page.entries) contents.push((await f.api.get({ ref: entry.ref }))!.text)
    cursor = page.nextCursor
    pages++
  } while (cursor)
  expect(contents).toHaveLength(30)
  expect(new Set(contents).size).toBe(30)
  expect(pages).toBeGreaterThan(1)
})

it('rejects oversized metadata explicitly without silently dropping it', async () => {
  const f = await fixture('external', 1)
  f.records.get('topic-000.md')!.metadata = { huge: '\u0000'.repeat(12_000) }
  const { ref } = (await f.api.list()).entries[0]!
  await expect(f.api.get({ ref })).rejects.toMatchObject({ code: 'TOO_LARGE' })
})

it('retains every concurrent allocation from separate store handles while capacity is available', async () => {
  const database = usingPostgresStore() ? undefined : memoryStoreDatabase()
  const db = await openTestStore({ database })
  const peer = await openTestStore({ database })
  cleanup.push(() => db.close())
  const expiresAt = Date.now() + 60_000
  const tokens = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      (index % 2 ? db : peer).putMemoryEntryContinuation('concurrent-agent', String(index), expiresAt)
    )
  )
  const values = await Promise.all(
    tokens.map((token) => db.getMemoryEntryContinuation('concurrent-agent', token, Date.now()))
  )
  expect(values).toEqual(Array.from({ length: 16 }, (_, index) => String(index)))
})

it('projects bounded entry reads through MCP without changing legacy file tools', async () => {
  const f = await fixture('managed', 3)
  const { executeTool } = await import('../src/mcp/ops.js')
  const { MEMORY_TOOLS } = await import('../src/memory/tools.js')
  const ctx = { agentId: 'a', platform: 'slack', isDm: false, channel: 'C', thread: 'T', tools: MEMORY_TOOLS }
  const provider = new ManagedMemoryProvider(() => localMemoryHome(f.root))
  const deps = { memory: provider, memoryEntryStore: f.db } as unknown as import('../src/mcp/ops.js').OpsDeps
  const page = (await executeTool(
    ctx,
    'listMemoryEntries',
    { limit: 1 },
    deps
  )) as import('@agentconnect.md/protocol').MemoryEntryListResult
  expect(page.entries).toHaveLength(1)
  expect(page.nextCursor).toBeTruthy()
  expect(await executeTool(ctx, 'getMemoryEntry', { ref: page.entries[0]!.ref }, deps)).toMatchObject({
    text: 'Fact 0',
    complete: true
  })
  expect(await executeTool(ctx, 'readMemory', { path: 'topic-000.md' }, deps)).toMatchObject({ content: 'Fact 0' })
  await expect(executeTool(ctx, 'listMemoryEntries', { agentId: 'other' }, deps)).rejects.toThrow()
  await expect(executeTool(ctx, 'getMemoryEntry', { id: 'topic-00.md' }, deps)).rejects.toThrow()
  await expect(
    executeTool(ctx, 'listMemoryEntries', {}, { ...deps, memoryAccessDecision: () => 'deny' })
  ).rejects.toThrow()
  await expect(
    executeTool({ ...ctx, agentId: 'other' }, 'getMemoryEntry', { ref: page.entries[0]!.ref }, deps)
  ).rejects.toMatchObject({ code: 'STALE_BINDING' })
})

it('rechecks daemon ownership and returns bounded typed read errors to admin callers', async () => {
  const f = await fixture('managed', 2)
  const { createMemoryEntriesReader } = await import('../src/cp/memory-entries.js')
  let owned = true
  const read = createMemoryEntriesReader(f.provider, f.db, (id) => id === 'a' && owned)
  const list = await read({ agentId: 'a', operation: 'list', request: { limit: 1 } })
  expect(list.operation).toBe('list')
  if (list.operation !== 'list') throw new Error('expected list')
  const ref = list.result.entries[0]!.ref
  expect(await read({ agentId: 'a', operation: 'get', request: { ref, maxBytes: 32768 } })).toMatchObject({
    operation: 'get',
    result: { text: 'Fact 0' }
  })
  owned = false
  expect(await read({ agentId: 'a', operation: 'get', request: { ref, maxBytes: 32768 } })).toMatchObject({
    operation: 'error',
    code: 'FORBIDDEN'
  })
  expect(await read({ agentId: 'foreign', operation: 'describe' })).toMatchObject({
    operation: 'error',
    code: 'FORBIDDEN'
  })
})

it('pins synthetic MCP reads to the Dream draft even after the live provider changes', async () => {
  const { db, dir } = await store()
  const draft = new LocalMemoryFs(join(dir, 'draft'))
  await draft.writeFile('memory/draft.md', 'only the staged proposal')
  const memory = createMemoryProvider({
    memoryHomePortsFor: () => localMemoryHome(new LocalMemoryFs(dir)),
    agentDirByAgent: () => dir,
    runtimeFor: () => undefined,
    providerKindFor: () => 'external'
  })
  const { executeTool } = await import('../src/mcp/ops.js')
  const ctx = {
    agentId: 'a',
    platform: 'slack',
    isDm: false,
    channel: 'synthetic',
    thread: 'T',
    tools: [],
    memoryBinding: { source: 'dream' as const, scope: { agentId: 'a', root: draft } }
  }
  const deps = {
    memory,
    memoryEntryStore: db,
    memoryScope: () => ({ agentId: 'a', channelKey: 'live-channel' })
  } as unknown as import('../src/mcp/ops.js').OpsDeps
  const page = (await executeTool(
    ctx,
    'listMemoryEntries',
    {},
    deps
  )) as import('@agentconnect.md/protocol').MemoryEntryListResult
  expect(page.entries.map((entry) => entry.label)).toEqual(['draft'])
  expect(await executeTool(ctx, 'getMemoryEntry', { ref: page.entries[0]!.ref }, deps)).toMatchObject({
    text: 'only the staged proposal'
  })
})
