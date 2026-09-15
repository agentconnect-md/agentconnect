import { createMemoryEntryService } from '../src/memory/entries/factory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_ENTRY_FRAME_BYTES } from '@agentconnect.md/protocol'
import { localMemoryHome } from '../src/memory/home.js'
import { LocalMemoryFs, MemorySandboxUnavailableError } from '../src/memory/fs.js'
import { ManagedMemoryProvider } from '../src/memory/providers/managed.js'
import { createMemoryProvider } from '../src/memory/provider.js'
import { MemoryEntries } from '../src/memory/entries/service.js'
import { MemoryEntryTokens } from '../src/memory/entries/tokens.js'
import { ExternalMemoryEntries } from '../src/memory/entries/external.js'
import { memoryContinuations, memoryEntryTokens } from '../src/memory/entries/state.js'
import type { MemoryEntriesView } from '../src/memory/entries/contract.js'
import type { MemoryRecord, RecordMemoryAdmin } from '../src/memory/types.js'
import type { MemoryProvider, MemoryScope } from '../src/memory/provider.js'
import { MemoryConflictError, type MemoryWriteSource } from '../src/memory/store.js'
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
async function service(db: LocalStore, resolve: () => Promise<MemoryEntriesView>, agent = 'a', write = false) {
  return new MemoryEntries(
    resolve,
    await memoryEntryTokens(db),
    memoryContinuations(db, agent),
    Date.now,
    write ? async () => {} : undefined
  )
}
const LIMITS = { maxItemBytes: 131072, maxPageItems: 7 }
async function fixture(kind: 'managed' | 'external', count = 37, options: { write?: boolean } = {}) {
  const { db, dir, path } = await store()
  const records = new Map<string, MemoryRecord>()
  const requests: { cursor?: string; limit: number }[] = []
  const mutations: Record<string, unknown>[] = []
  const recordScope = { kind: 'agent' as const, key: 'ac:agent:a' }
  let sequence = 0
  const root = new LocalMemoryFs(dir)
  const provider = new ManagedMemoryProvider(() => localMemoryHome(root))
  for (let i = 0; i < count; i++) {
    const id = `topic-${String(i).padStart(3, '0')}.md`
    const text = `Fact ${i}`
    records.set(id, { id, text, scope: { kind: 'agent', key: 'ac:agent:a' } })
    if (kind === 'managed') await root.writeFile(`memory/${id}`, text)
  }
  // A versioned in-memory backend: conditional when a version is supplied, last-write-wins otherwise.
  const admin: RecordMemoryAdmin = {
    shape: 'records',
    capabilities: new Set(options.write ? ['list', 'get', 'create', 'update', 'delete'] : ['list', 'get']),
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
    async create(_scope, request) {
      mutations.push(request)
      const record: MemoryRecord = {
        id: `record-${++sequence}`,
        text: request.text,
        scope: recordScope,
        version: '1',
        ...(request.metadata ? { metadata: request.metadata } : {})
      }
      records.set(record.id, record)
      return record
    },
    async update(_scope, request) {
      mutations.push(request)
      const current = records.get(request.id)
      if (!current) throw new Error('backend rejected the update')
      if (request.version && request.version !== current.version) throw new MemoryConflictError('stale version')
      const record: MemoryRecord = {
        ...current,
        text: request.text,
        version: String(Number(current.version ?? 0) + 1),
        ...(request.metadata ? { metadata: request.metadata } : {})
      }
      records.set(record.id, record)
      return record
    },
    async delete(_scope, request) {
      mutations.push(request)
      const current = records.get(request.id)
      if (!current) return false
      if (request.version && request.version !== current.version) throw new MemoryConflictError('stale version')
      records.delete(request.id)
      return true
    },
    async history() {
      throw new Error('unsupported')
    }
  }
  let binding = 'binding-1'
  const writeContext = options.write ? { source: 'tool' as const } : undefined
  const resolve = async () =>
    kind === 'managed'
      ? provider.entryView({ agentId: binding })
      : new ExternalMemoryEntries(admin, { agentId: 'a' }, binding, LIMITS, writeContext)
  const api = await service(db, resolve, 'a', options.write)
  return {
    path,
    api,
    db,
    root,
    provider,
    records,
    admin,
    requests,
    mutations,
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

it('lets an unreachable home escape the admin reader and writer with its reason', async () => {
  // A sleeping sandbox is refused on the wire with `sandbox-unavailable`, the code the console wakes on; folding it
  // into an in-band UNAVAILABLE would leave the entry browser unable to tell it from an offline plugin.
  const { db } = await store()
  const provider = new ManagedMemoryProvider(() => {
    throw new MemorySandboxUnavailableError('agent "a" has no running sandbox, so its memory cannot be reached')
  })
  const { createMemoryEntriesReader, createMemoryEntriesWriter } = await import('../src/cp/memory-entries.js')
  const read = createMemoryEntriesReader(provider, db, () => true)
  await expect(read({ agentId: 'a', operation: 'describe' })).rejects.toBeInstanceOf(MemorySandboxUnavailableError)
  await expect(read({ agentId: 'a', operation: 'list', request: { limit: 1 } })).rejects.toMatchObject({
    reason: 'sandbox-unavailable'
  })
  const write = createMemoryEntriesWriter(provider, db, () => true)
  await expect(write({ agentId: 'a', operation: 'create', request: { text: 'x' } })).rejects.toBeInstanceOf(
    MemorySandboxUnavailableError
  )
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

describe('unified external mutations', () => {
  it('projects declared record mutations with last-write-wins receipts, refusing what v1 cannot express', async () => {
    const f = await fixture('external', 2, { write: true })
    expect(await f.api.describe()).toMatchObject({
      operations: ['list', 'get', 'create', 'update', 'delete'],
      writeConsistency: 'last-write-wins',
      exactCreate: false,
      exactEdit: false
    })
    const created = await f.api.create({
      text: 'Deploy on Fridays only after the smoke test',
      metadata: { topic: 'ops' }
    })
    expect(created).toMatchObject({ state: 'completed', entry: { format: 'text', editable: true, revision: '1' } })
    expect(f.mutations.at(-1)).toMatchObject({ operationId: created.operationId, metadata: { topic: 'ops' } })
    const ref = created.entry!.ref
    expect(await f.api.get({ ref })).toMatchObject({
      text: 'Deploy on Fridays only after the smoke test',
      metadata: { topic: 'ops' },
      complete: true
    })
    await expect(f.api.create({ label: 'named', text: 'x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(f.api.create({ text: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(f.api.create({ text: 'x'.repeat(LIMITS.maxItemBytes + 1) })).rejects.toMatchObject({
      code: 'TOO_LARGE'
    })
    await expect(
      f.api.update({ ref, revision: '1', edit: { oldText: 'Fridays', newText: 'Mondays' } })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    // Omitted metadata is forwarded as omitted, so the backend keeps what it holds.
    const updated = await f.api.update({ ref, revision: '1', text: 'Deploy on Mondays' })
    expect(updated.entry).toMatchObject({ revision: '2', label: 'Deploy on Mondays' })
    expect(f.mutations.at(-1)).not.toHaveProperty('metadata')
    expect(await f.api.get({ ref })).toMatchObject({ text: 'Deploy on Mondays', metadata: { topic: 'ops' } })
    await expect(f.api.update({ ref, revision: '1', text: 'stale' })).rejects.toMatchObject({
      code: 'CONFLICT',
      currentRevision: '2'
    })
    expect(await f.api.get({ ref })).toMatchObject({ text: 'Deploy on Mondays' })
    // Without a revision the write is last-write-wins, exactly as advertised.
    expect((await f.api.update({ ref, text: 'Deploy on Tuesdays' })).entry).toMatchObject({ revision: '3' })
    await expect(f.api.delete({ ref, revision: '2' })).rejects.toMatchObject({ code: 'CONFLICT', currentRevision: '3' })
    expect(await f.api.delete({ ref, revision: '3' })).toMatchObject({ state: 'completed', deletedRef: ref })
    expect(await f.api.get({ ref })).toBeNull()
    await expect(f.api.delete({ ref })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A backend rejection after egress cannot be told from a lost apply, so it is never replayed.
    await expect(f.api.update({ ref, text: 'gone' })).rejects.toMatchObject({ code: 'AMBIGUOUS_WRITE' })
    expect(f.records.size).toBe(2)
  })

  it('keeps record mutations behind the write gate and the declared capability set', async () => {
    const readOnly = await fixture('external', 1)
    await expect(readOnly.api.create({ text: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await readOnly.api.list({ limit: 1 })).entries[0]).toMatchObject({ editable: false })
    const f = await fixture('external', 1, { write: true })
    ;(f.admin.capabilities as Set<string>).delete('update')
    expect((await f.api.describe()).operations).toEqual(['list', 'get', 'create', 'delete'])
    const page = await f.api.list({ limit: 1 })
    expect(page.entries[0]).toMatchObject({ editable: false })
    await expect(f.api.update({ ref: page.entries[0]!.ref, text: 'x' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(f.mutations).toHaveLength(0)
  })

  it('publishes external record mutations for console callers with bounded typed outcomes', async () => {
    const f = await fixture('external', 1, { write: true })
    const { createMemoryEntriesWriter } = await import('../src/cp/memory-entries.js')
    const provider = {
      entryView: async (scope: MemoryScope, writeSource?: MemoryWriteSource) =>
        new ExternalMemoryEntries(
          f.admin,
          scope,
          'binding-1',
          LIMITS,
          writeSource ? { source: writeSource } : undefined
        )
    } as unknown as MemoryProvider
    const write = createMemoryEntriesWriter(provider, f.db, (id) => id === 'a')
    const created = await write({ agentId: 'a', operation: 'create', request: { text: 'Console fact' } })
    expect(created).toMatchObject({
      operation: 'completed',
      result: { state: 'completed', entry: { editable: true, format: 'text', revision: '1' } }
    })
    if (created.operation !== 'completed') throw new Error('expected completion')
    const ref = created.result.entry!.ref
    expect(
      await write({ agentId: 'a', operation: 'update', request: { ref, revision: 'stale', text: 'x' } })
    ).toMatchObject({ operation: 'error', code: 'CONFLICT', currentRevision: '1' })
    expect(await write({ agentId: 'a', operation: 'delete', request: { ref, revision: '1' } })).toMatchObject({
      operation: 'completed',
      result: { deletedRef: ref }
    })
    expect(await write({ agentId: 'foreign', operation: 'create', request: { text: 'x' } })).toMatchObject({
      operation: 'error',
      code: 'FORBIDDEN'
    })
    expect(f.mutations).toHaveLength(3)
  })
})

describe('unified search', () => {
  it('managed lexical search matches every term over label, description and body, in a deterministic order', async () => {
    const f = await fixture('managed', 0)
    await f.root.writeFile(
      'memory/deploy.md',
      '---\nname: Deployment rules\ndescription: How releases reach production\n---\nDeploy on Fridays only after the smoke test passes.\n'
    )
    await f.root.writeFile(
      'memory/oncall.md',
      '---\nname: On-call\n---\nThe on-call engineer approves every Friday deploy.\n'
    )
    await f.root.writeFile('memory/lunch.md', 'Team lunch happens on Fridays.\n')
    expect(await f.api.describe()).toMatchObject({
      operations: ['list', 'get', 'search', 'history'],
      searchKind: 'lexical'
    })
    const page = await f.api.search({ query: 'friday DEPLOY' })
    expect(page).toMatchObject({ kind: 'lexical', coverage: 'complete' })
    expect(page.hits.map((hit) => hit.entry.label)).toEqual(['Deployment rules', 'On-call'])
    expect(page.hits[0]!.snippet).toBe('Deploy on Fridays only after the smoke test passes.')
    expect(page.hits[0]!.snippet).not.toContain('name:')
    expect(await f.api.get({ ref: page.hits[0]!.entry.ref })).toMatchObject({ entry: { label: 'Deployment rules' } })
    expect((await f.api.search({ query: 'production' })).hits.map((hit) => hit.entry.label)).toEqual([
      'Deployment rules'
    ])
    expect((await f.api.search({ query: 'nothing-like-this' })).hits).toEqual([])
    expect((await f.api.search({ query: 'fridays', limit: 1 })).hits).toHaveLength(1)
    await expect(f.api.search({ query: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(f.api.search({ query: 'x', limit: 21 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('managed search sees the channel overlay and keeps the generated index out of hits', async () => {
    const f = await fixture('managed', 0)
    await f.root.writeFile('memory/MEMORY.md', '# Index\n- shared secret phrase\n')
    await f.root.writeFile('memory/topic.md', 'base shared secret phrase\n')
    await f.root.writeFile('channels/c1/memory/topic.md', 'channel override without the phrase\n')
    await f.root.writeFile('channels/c1/memory/extra.md', 'channel-only shared secret phrase\n')
    const view = () => f.provider.entryView({ agentId: 'binding-1', channelKey: 'c1' })
    const api = await service(f.db, view)
    const page = await api.search({ query: 'shared secret phrase' })
    expect(page.hits.map((hit) => [hit.entry.label, hit.entry.origin])).toEqual([['extra', 'active']])
  })

  it('external search projects recall hits and never claims lexical kind or complete coverage', async () => {
    const f = await fixture('external', 3)
    ;(f.admin.capabilities as Set<string>).add('recall')
    f.admin.search = async (_scope, request) =>
      [...f.records.values()].filter((record) => record.text.includes(request.query)).slice(0, request.topK)
    expect((await f.api.describe()).operations).toEqual(['list', 'get', 'search'])
    const page = await f.api.search({ query: 'Fact 1', limit: 2 })
    expect(page).toMatchObject({ kind: 'unknown', coverage: 'unknown' })
    expect(page.hits.map((hit) => hit.snippet)).toEqual(['Fact 1'])
    expect(await f.api.get({ ref: page.hits[0]!.entry.ref })).toMatchObject({ text: 'Fact 1' })
  })

  it('projects search through MCP and the admin reader with the same bounded result', async () => {
    const f = await fixture('managed', 0)
    await f.root.writeFile('memory/deploy.md', 'Deploy on Fridays.\n')
    const { executeTool } = await import('../src/mcp/ops.js')
    const { MEMORY_TOOLS } = await import('../src/memory/tools.js')
    const ctx = { agentId: 'a', platform: 'slack', isDm: false, channel: 'C', thread: 'T', tools: MEMORY_TOOLS }
    const deps = { memory: f.provider, memoryEntryStore: f.db } as unknown as import('../src/mcp/ops.js').OpsDeps
    expect(await executeTool(ctx, 'searchMemoryEntries', { query: 'fridays' }, deps)).toMatchObject({
      kind: 'lexical',
      hits: [{ entry: { label: 'deploy' }, snippet: 'Deploy on Fridays.' }]
    })
    await expect(
      executeTool(ctx, 'searchMemoryEntries', { query: 'fridays' }, { ...deps, memoryAccessDecision: () => 'deny' })
    ).rejects.toThrow()
    const { createMemoryEntriesReader } = await import('../src/cp/memory-entries.js')
    const read = createMemoryEntriesReader(f.provider, f.db, (id) => id === 'a')
    expect(await read({ agentId: 'a', operation: 'search', request: { query: 'fridays', limit: 5 } })).toMatchObject({
      operation: 'search',
      result: { kind: 'lexical', coverage: 'complete', hits: [{ snippet: 'Deploy on Fridays.' }] }
    })
  })
})

it('annotates managed reads with one hop of wiki links as refs, never spliced into the text', async () => {
  const f = await fixture('managed', 0)
  // The writer pins a header name to its topic slug, so links name slugs.
  const deployText = '---\nname: deploy\ndescription: Release rules\n---\nSee [[oncall]] and [[missing]].\n'
  await f.root.writeFile('memory/deploy.md', deployText)
  await f.root.writeFile('memory/oncall.md', 'Page the [[deploy]] owner.\n')
  await f.root.writeFile('channels/c1/memory/rota.md', 'Channel rota links to [[deploy]].\n')
  expect((await f.api.describe()).graph).toBe(true)
  const page = await f.api.list({ limit: 10 })
  const deploy = page.entries.find((entry) => entry.label === 'deploy')!
  const content = (await f.api.get({ ref: deploy.ref }))!
  expect(content.text).toBe(deployText)
  expect(content.links).toEqual([
    { label: 'oncall', ref: expect.any(String), exists: true },
    { label: 'missing', exists: false }
  ])
  expect(content.backlinks).toEqual([{ label: 'oncall', ref: expect.any(String), exists: true }])
  expect(await f.api.get({ ref: content.links![0]!.ref! })).toMatchObject({ entry: { label: 'oncall' } })
  await expect(f.api.get({ ref: content.links![0]!.ref!, agentId: 'x' })).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT'
  })
  // The channel view sees the overlay edge and mints refs into its own partition.
  const overlay = await service(f.db, () => f.provider.entryView({ agentId: 'binding-1', channelKey: 'c1' }))
  const base = (await overlay.list({ limit: 10 })).entries.find((entry) => entry.label === 'deploy')!
  const viewed = (await overlay.get({ ref: base.ref }))!
  expect(viewed.backlinks?.map((edge) => edge.label).sort()).toEqual(['oncall', 'rota'])
  const rota = viewed.backlinks!.find((edge) => edge.label === 'rota')!
  expect(await overlay.get({ ref: rota.ref! })).toMatchObject({ entry: { label: 'rota', origin: 'active' } })
  await expect(f.api.get({ ref: rota.ref! })).rejects.toMatchObject({ code: 'STALE_BINDING' })
})

describe('unified history', () => {
  it('pages a managed entry change log newest first through the home sink, with view-bound cursors', async () => {
    const f = await fixture('managed', 0)
    const scope = { agentId: 'binding-1' }
    await f.provider.write(scope, 'deploy.md', 'Deploy on Fridays.', undefined, 'console')
    await f.provider.write(scope, 'deploy.md', 'Deploy on Mondays.', undefined, 'tool')
    await f.provider.write(scope, 'deploy.md', 'Deploy on Tuesdays.', undefined, 'tool')
    expect((await f.api.describe()).operations).toContain('history')
    const deploy = (await f.api.list({ limit: 10 })).entries.find((entry) => entry.label === 'deploy')!
    const first = await f.api.history({ ref: deploy.ref, limit: 2 })
    expect(first.order).toBe('newest-first')
    expect(first.events.map((event) => [event.kind, event.source, event.after])).toEqual([
      ['update', 'tool', 'Deploy on Tuesdays.'],
      ['update', 'tool', 'Deploy on Mondays.']
    ])
    expect(first.events[0]!.before).toBe('Deploy on Mondays.')
    expect(first.nextCursor).toBeTruthy()
    const rest = await f.api.history({ ref: deploy.ref, limit: 2, cursor: first.nextCursor })
    expect(rest.events.map((event) => [event.kind, event.source])).toEqual([['create', 'console']])
    expect(rest.nextCursor).toBeUndefined()
    await expect(f.api.history({ ref: deploy.ref, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    await expect(f.api.history({ ref: 'deploy.md' })).rejects.toMatchObject({ code: 'STALE_BINDING' })
    f.replaceBinding()
    await expect(f.api.history({ ref: deploy.ref })).rejects.toMatchObject({ code: 'STALE_BINDING' })
  })

  it('projects external record history in backend order with bounded snapshots, or none when undeclared', async () => {
    const f = await fixture('external', 1)
    expect((await f.api.describe()).operations).not.toContain('history')
    const ref = (await f.api.list({ limit: 1 })).entries[0]!.ref
    await expect(f.api.history({ ref })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    ;(f.admin.capabilities as Set<string>).add('history')
    const calls: unknown[] = []
    f.admin.history = async (_scope, request) => {
      calls.push(request)
      return {
        events: [
          {
            id: 'ev-2',
            event: 'update',
            at: '2026-09-14T12:00:00.000Z',
            record: { id: 'topic-000.md', text: 'x'.repeat(5000), scope: { kind: 'agent', key: 'ac:agent:a' } }
          },
          { id: 'ev-1', event: 'create', at: '2026-09-13T12:00:00.000Z' }
        ],
        ...(request.cursor ? {} : { nextCursor: 'backend-2' })
      }
    }
    const page = await f.api.history({ ref, limit: 5 })
    expect(calls[0]).toMatchObject({ id: 'topic-000.md', limit: 5 })
    expect(page.order).toBe('backend')
    expect(page.events.map((event) => event.kind)).toEqual(['update', 'create'])
    expect(page.events[0]!.after!.length).toBeLessThanOrEqual(4001)
    expect(page.events[0]!.truncated).toBe(true)
    expect(page.events[1]).not.toHaveProperty('after')
    const older = await f.api.history({ ref, limit: 5, cursor: page.nextCursor })
    expect(calls[1]).toMatchObject({ cursor: 'backend-2' })
    expect(older.nextCursor).toBeUndefined()
  })

  it('retains a budget-cut remainder in the continuation instead of re-reading a live page', async () => {
    const f = await fixture('managed', 0)
    const scope = { agentId: 'binding-1' }
    // Six quote-only versions: each event's two snapshots escape to ~16 KiB, so a five-event page exceeds the budget.
    for (let version = 0; version < 6; version++)
      await f.provider.write(scope, 'big.md', `${version}${'"'.repeat(4000)}`, undefined, 'tool')
    const ref = (await f.api.list({ limit: 10 })).entries.find((entry) => entry.label === 'big')!.ref
    const first = await f.api.history({ ref, limit: 5 })
    expect(first.events.length).toBeGreaterThan(0)
    expect(first.events.length).toBeLessThan(5)
    expect(first.nextCursor).toBeTruthy()
    // A write landing between pages must neither repeat nor hide an event the first fetch already covered.
    await f.provider.write(scope, 'big.md', 'seventh', undefined, 'tool')
    const second = await f.api.history({ ref, limit: 5, cursor: first.nextCursor })
    const versions = [...first.events, ...second.events].map((event) => event.after!.slice(0, 1))
    expect(versions).toEqual(['5', '4', '3', '2', '1'])
    const third = await f.api.history({ ref, limit: 5, cursor: second.nextCursor })
    expect(third.events.map((event) => [event.kind, event.after!.slice(0, 1)])).toEqual([['create', '0']])
    expect(third.nextCursor).toBeUndefined()
  })

  it('serves history to admin callers and refuses it through the model tool surface', async () => {
    const f = await fixture('managed', 0)
    await f.provider.write({ agentId: 'binding-1' }, 'deploy.md', 'Deploy on Fridays.', undefined, 'console')
    const { createMemoryEntriesReader } = await import('../src/cp/memory-entries.js')
    const read = createMemoryEntriesReader(f.provider, f.db, (id) => id === 'binding-1')
    const list = await read({ agentId: 'binding-1', operation: 'list', request: { limit: 1 } })
    if (list.operation !== 'list') throw new Error('expected list')
    expect(
      await read({
        agentId: 'binding-1',
        operation: 'history',
        request: { ref: list.result.entries[0]!.ref, limit: 5 }
      })
    ).toMatchObject({ operation: 'history', result: { events: [{ kind: 'create', source: 'console' }] } })
    const { MEMORY_TOOLS } = await import('../src/memory/tools.js')
    expect(MEMORY_TOOLS.map((tool) => tool.name)).not.toContain('historyMemoryEntries')
  })
})
