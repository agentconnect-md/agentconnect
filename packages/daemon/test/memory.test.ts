import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureMemory,
  readIndex,
  readMemoryFile,
  writeMemoryFile,
  appendHistory,
  listMemory,
  listMemoryHistory,
  memoryDir,
  memoryTopicName,
  withMemoryDirLock,
  MemoryPathError,
  MemoryTooLargeError,
  MemoryConflictError,
  MEMORY_INDEX,
  MAX_INDEX_INJECT_BYTES,
  MAX_MEMORY_FILE_BYTES,
  MEMORY_HISTORY_FILENAME,
  MAX_HISTORY_FILE_BYTES,
  MAX_HISTORY_VALUE_BYTES,
  MAX_HISTORY_VERSIONS_PER_FILE,
  type MemoryHistoryRecord
} from '../src/memory/store.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { createMemoryReader, MemoryViolationError } from '../src/cp/memory-reader.js'
import { createManagedMemoryProvider } from '../src/memory/provider.js'
import { MEMORY_TOOLS } from '../src/memory/tools.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'

const local = (dir: string) => new LocalMemoryFs(dir)

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'ac-mem-'))
}
const indexPath = (dir: string) => join(memoryDir(dir), MEMORY_INDEX)

describe('memory/store (directory model)', () => {
  it('ensureMemory seeds memory/MEMORY.md only when absent (idempotent)', async () => {
    const dir = newDir()
    await ensureMemory(local(dir), 'bot-a')
    expect(existsSync(indexPath(dir))).toBe(true)
    expect(readFileSync(indexPath(dir), 'utf8')).toContain('# bot-a memory')
    // second call must not overwrite existing content
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'kept')
    await ensureMemory(local(dir), 'bot-a')
    expect(readFileSync(indexPath(dir), 'utf8')).toBe('kept')
  })

  it('reads/writes the index and topic files', async () => {
    const dir = newDir()
    expect(await readMemoryFile(local(dir), MEMORY_INDEX)).toBe('') // missing ⇒ ''
    await writeMemoryFile(local(dir), MEMORY_INDEX, '# index\n- [deploys](deploys.md)')
    await writeMemoryFile(local(dir), 'deploys.md', '# deploys\nrun make ship')
    expect(await readMemoryFile(local(dir), MEMORY_INDEX)).toContain('deploys.md')
    expect(await readMemoryFile(local(dir), 'deploys.md')).toBe('# deploys\nrun make ship')
  })

  it('listMemory returns the index first, then topics; skips .tmp', async () => {
    const dir = newDir()
    expect(await listMemory(local(dir))).toEqual([]) // missing dir ⇒ []
    await writeMemoryFile(local(dir), 'zeta.md', 'z')
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'i')
    await writeMemoryFile(local(dir), 'alpha.md', 'a')
    const names = (await listMemory(local(dir))).map((f) => f.name)
    expect(names).toEqual([MEMORY_INDEX, 'alpha.md', 'zeta.md']) // index first, then alphabetical
  })

  it('readIndex truncates a huge index to the inject cap', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'x'.repeat(MAX_INDEX_INJECT_BYTES + 5000))
    const injected = await readIndex(local(dir))
    expect(Buffer.byteLength(injected)).toBeLessThanOrEqual(MAX_INDEX_INJECT_BYTES)
    expect(injected).toContain('truncated')
  })

  it('readIndex truncates before a complete UTF-8 code point', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), MEMORY_INDEX, '🚀'.repeat(MAX_INDEX_INJECT_BYTES))
    const injected = await readIndex(local(dir))
    expect(Buffer.byteLength(injected)).toBeLessThanOrEqual(MAX_INDEX_INJECT_BYTES)
    expect(injected).not.toContain('\uFFFD')
    expect(injected).toContain('truncated')
  })

  it('contains paths to the memory dir (rejects escapes, absolutes, and subdirs)', () => {
    const dir = newDir()
    expect(memoryTopicName('deploys.md')).toBe('deploys.md')
    expect(() => memoryTopicName('../secret')).toThrow(MemoryPathError)
    expect(() => memoryTopicName('/etc/passwd')).toThrow(MemoryPathError)
    expect(() => memoryTopicName('sub/topic.md')).toThrow(MemoryPathError) // flat only
    expect(() => memoryTopicName('')).toThrow(MemoryPathError)
    expect(() => memoryTopicName(MEMORY_HISTORY_FILENAME)).toThrow(MemoryPathError)
  })

  it('reserves .history from ordinary managed-memory reads and writes', async () => {
    const dir = newDir()
    await expect(readMemoryFile(local(dir), MEMORY_HISTORY_FILENAME)).rejects.toBeInstanceOf(MemoryPathError)
    await expect(writeMemoryFile(local(dir), MEMORY_HISTORY_FILENAME, 'forged provenance')).rejects.toBeInstanceOf(
      MemoryPathError
    )
  })

  it('rejects a write over the size budget (MemoryTooLargeError)', async () => {
    const dir = newDir()
    await expect(writeMemoryFile(local(dir), 'big.md', 'x'.repeat(MAX_MEMORY_FILE_BYTES + 1))).rejects.toBeInstanceOf(
      MemoryTooLargeError
    )
    // at the limit is fine
    await expect(writeMemoryFile(local(dir), 'ok.md', 'x'.repeat(MAX_MEMORY_FILE_BYTES))).resolves.toBeTruthy()
  })

  it('enforces the ifMatchMtime precondition (optimistic concurrency)', async () => {
    const dir = newDir()
    const first = await writeMemoryFile(local(dir), 'notes.md', 'v1')
    // a stale mtime is rejected
    await expect(writeMemoryFile(local(dir), 'notes.md', 'v2', '1999-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(
      MemoryConflictError
    )
    // the current mtime succeeds
    await expect(writeMemoryFile(local(dir), 'notes.md', 'v2', first.mtime)).resolves.toBeTruthy()
    expect(await readMemoryFile(local(dir), 'notes.md')).toBe('v2')
    // a precondition on a brand-new (absent) file with a non-empty mtime is a conflict
    await expect(writeMemoryFile(local(dir), 'fresh.md', 'x', 'some-mtime')).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('does not follow a pre-planted predictable temp symlink', async () => {
    const dir = newDir()
    const outside = join(newDir(), 'outside.txt')
    const outsideHistory = join(newDir(), 'history.txt')
    writeFileSync(outside, 'keep')
    writeFileSync(outsideHistory, 'keep-history')
    mkdirSync(memoryDir(dir), { recursive: true })
    symlinkSync(outside, join(memoryDir(dir), 'notes.md.tmp'))
    symlinkSync(outsideHistory, join(memoryDir(dir), MEMORY_HISTORY_FILENAME))

    await writeMemoryFile(local(dir), 'notes.md', 'updated')

    expect(readFileSync(outside, 'utf8')).toBe('keep')
    expect(readFileSync(outsideHistory, 'utf8')).toBe('keep-history')
    expect(readFileSync(join(memoryDir(dir), 'notes.md'), 'utf8')).toBe('updated')
  })

  // O_NOFOLLOW has no Windows equivalent, so the planted symlink is followed — tracked separately.
  it.skipIf(process.platform === 'win32')('does not read through a planted symlink (topic or index)', async () => {
    const dir = newDir()
    const secret = join(newDir(), 'secret.txt')
    writeFileSync(secret, 'PRIVATE-KEY')
    mkdirSync(memoryDir(dir), { recursive: true })
    symlinkSync(secret, join(memoryDir(dir), 'leak.md'))
    symlinkSync(secret, join(memoryDir(dir), MEMORY_INDEX))

    await expect(readMemoryFile(local(dir), 'leak.md')).rejects.toBeInstanceOf(MemoryPathError)
    // the index rides the session-start path, so it degrades to no injection rather
    // than throwing — but it still must not read through the link
    await expect(readIndex(local(dir))).resolves.toBe('')
    // a symlinked entry is not even listed as a topic
    expect((await listMemory(local(dir))).map((f) => f.name)).not.toContain('leak.md')
  })
})

describe('memory/store (.history change log)', () => {
  const readHistory = (dir: string): MemoryHistoryRecord[] => {
    const raw = readFileSync(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), 'utf8')
    return raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as MemoryHistoryRecord)
  }

  it('records add then update in order, with before absent on add and present on update', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), 'notes.md', 'v1')
    await writeMemoryFile(local(dir), 'notes.md', 'v2')
    const log = readHistory(dir)
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ path: 'notes.md', event: 'add', after: 'v1', scope: 'agent', source: 'tool' })
    expect(log[0]!.before).toBeUndefined() // no prior content on a first write
    expect(log[1]).toMatchObject({ path: 'notes.md', event: 'update', before: 'v1', after: 'v2' })
  })

  it('attributes the source (tool default vs console)', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), 'a.md', 'x') // default source
    await writeMemoryFile(local(dir), 'b.md', 'y', undefined, 'console')
    const log = readHistory(dir)
    expect(log.find((r) => r.path === 'a.md')?.source).toBe('tool')
    expect(log.find((r) => r.path === 'b.md')?.source).toBe('console')
  })

  it('truncates an over-cap before/after snapshot (flagged), keeping the line bounded', async () => {
    const dir = newDir()
    const big = 'x'.repeat(MAX_HISTORY_VALUE_BYTES + 500)
    await writeMemoryFile(local(dir), 'big.md', big)
    const rec = readHistory(dir)[0]!
    expect(rec.truncated).toBe(true)
    expect(rec.after.endsWith('…')).toBe(true)
    expect(Buffer.byteLength(rec.after)).toBeLessThanOrEqual(MAX_HISTORY_VALUE_BYTES + 4) // + the '…' marker
  })

  it('does not surface .history as a topic in listMemory', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'i')
    await writeMemoryFile(local(dir), 'topic.md', 't')
    const names = (await listMemory(local(dir))).map((f) => f.name)
    expect(names).toEqual([MEMORY_INDEX, 'topic.md']) // .history excluded
    expect(existsSync(join(memoryDir(dir), MEMORY_HISTORY_FILENAME))).toBe(true) // but it exists
  })

  it('repairs a valid no-newline tail before appending the next event', async () => {
    const dir = newDir()
    mkdirSync(memoryDir(dir), { recursive: true })
    const first: MemoryHistoryRecord = {
      id: randomUUID(),
      path: 'notes.md',
      event: 'add',
      after: 'v1',
      at: '2026-01-01T00:00:00.000Z',
      scope: 'agent',
      source: 'tool'
    }
    writeFileSync(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), JSON.stringify(first))

    await appendHistory(local(dir), { ...first, id: undefined, event: 'update', before: 'v1', after: 'v2' })

    expect(readHistory(dir).map((event) => event.after)).toEqual(['v1', 'v2'])
  })

  it('discards a torn tail before appending without losing the new event', async () => {
    const dir = newDir()
    mkdirSync(memoryDir(dir), { recursive: true })
    const first: MemoryHistoryRecord = {
      id: randomUUID(),
      path: 'notes.md',
      event: 'add',
      after: 'v1',
      at: '2026-01-01T00:00:00.000Z',
      scope: 'agent',
      source: 'tool'
    }
    writeFileSync(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), `${JSON.stringify(first)}\n{"path":`)

    await appendHistory(local(dir), { ...first, id: undefined, event: 'update', before: 'v1', after: 'v2' })

    expect(readHistory(dir).map((event) => event.after)).toEqual(['v1', 'v2'])
  })

  it('does not use a planted .history.tmp symlink while compacting', async () => {
    const dir = newDir()
    const outside = join(newDir(), 'outside.txt')
    writeFileSync(outside, 'keep')
    mkdirSync(memoryDir(dir), { recursive: true })
    symlinkSync(outside, join(memoryDir(dir), `${MEMORY_HISTORY_FILENAME}.tmp`))
    writeFileSync(
      join(memoryDir(dir), MEMORY_HISTORY_FILENAME),
      JSON.stringify({
        path: 'notes.md',
        event: 'add',
        after: 'v1',
        at: '2026-01-01T00:00:00.000Z',
        scope: 'agent',
        source: 'tool'
      })
    )

    await expect(listMemoryHistory(local(dir), 'notes.md', undefined, 5)).resolves.toMatchObject({
      events: [{ after: 'v1' }]
    })
    expect(readFileSync(outside, 'utf8')).toBe('keep')
  })

  it('pages one file newest first without interleaved topic changes', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), 'notes.md', 'v1')
    await writeMemoryFile(local(dir), 'other.md', 'unrelated')
    for (let version = 2; version <= 7; version += 1) {
      await writeMemoryFile(local(dir), 'notes.md', `v${version}`)
    }

    const newest = await listMemoryHistory(local(dir), 'notes.md', undefined, 5)
    expect(newest.events.map((event) => event.after)).toEqual(['v7', 'v6', 'v5', 'v4', 'v3'])
    expect(newest.nextCursor).toBeDefined()
    expect(newest.events.every((event) => event.path === 'notes.md')).toBe(true)

    const older = await listMemoryHistory(local(dir), 'notes.md', newest.nextCursor, 5)
    expect(older.events.map((event) => event.after)).toEqual(['v2', 'v1'])
    expect(older.nextCursor).toBeUndefined()
  })

  it('retains the newest 100 changes for each memory file by default', async () => {
    const dir = newDir()
    for (let version = 0; version < MAX_HISTORY_VERSIONS_PER_FILE + 3; version += 1) {
      await writeMemoryFile(local(dir), 'notes.md', `v${version}`)
    }

    const log = readHistory(dir)
    expect(log).toHaveLength(MAX_HISTORY_VERSIONS_PER_FILE)
    expect(log[0]?.after).toBe('v3')
    expect(log.at(-1)?.after).toBe(`v${MAX_HISTORY_VERSIONS_PER_FILE + 2}`)
    expect(log.every((event) => typeof event.id === 'string')).toBe(true)
  })

  it('tightens a legacy sidecar over 2 MiB when history is read', async () => {
    const dir = newDir()
    mkdirSync(memoryDir(dir), { recursive: true })
    const legacy = Array.from({ length: 550 }, (_, index): MemoryHistoryRecord => ({
      id: randomUUID(),
      path: `topic-${index}.md`,
      event: 'add',
      after: `${index}:` + 'x'.repeat(MAX_HISTORY_VALUE_BYTES - String(index).length - 1),
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      scope: 'agent',
      source: 'tool'
    }))
    const historyPath = join(memoryDir(dir), MEMORY_HISTORY_FILENAME)
    const oversized = legacy.map((event) => JSON.stringify(event)).join('\n') + '\n'
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_HISTORY_FILE_BYTES)
    writeFileSync(historyPath, oversized)

    const page = await listMemoryHistory(local(dir), 'topic-549.md', undefined, 5)
    const compacted = readFileSync(historyPath, 'utf8')
    const retained = readHistory(dir)
    expect(page.events).toHaveLength(1)
    expect(Buffer.byteLength(compacted)).toBeLessThanOrEqual(MAX_HISTORY_FILE_BYTES)
    expect(retained[0]?.path).not.toBe('topic-0.md')
    expect(retained.at(-1)?.path).toBe('topic-549.md')
  })

  it('serializes concurrent appends so compaction does not drop changes', async () => {
    const dir = newDir()
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        appendHistory(local(dir), {
          path: 'concurrent.md',
          event: 'update',
          after: String(index),
          at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
          scope: 'agent',
          source: 'tool'
        })
      )
    )

    const log = readHistory(dir)
    expect(log).toHaveLength(24)
    expect(new Set(log.map((event) => event.after)).size).toBe(24)
    expect(new Set(log.map((event) => event.id)).size).toBe(24)
  })

  it('serializes history reads behind a dream-style directory mutation', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), 'notes.md', 'v1')
    let entered!: () => void
    let release!: () => void
    const enteredLock = new Promise<void>((resolve) => (entered = resolve))
    const releaseLock = new Promise<void>((resolve) => (release = resolve))
    const mutation = withMemoryDirLock(local(dir), async () => {
      entered()
      await releaseLock
      const adopted: MemoryHistoryRecord = {
        id: randomUUID(),
        path: 'notes.md',
        event: 'update',
        before: 'v1',
        after: 'dream-v2',
        at: '2026-01-01T00:00:00.000Z',
        scope: 'agent',
        source: 'dream'
      }
      writeFileSync(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), `${JSON.stringify(adopted)}\n`)
    })
    await enteredLock

    let settled = false
    const read = listMemoryHistory(local(dir), 'notes.md', undefined, 5).then((page) => {
      settled = true
      return page
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    release()
    await mutation
    await expect(read).resolves.toMatchObject({ events: [{ after: 'dream-v2', source: 'dream' }] })
  })
})

describe('cp/memory-reader', () => {
  const reader = (dir: string | undefined) => createMemoryReader(() => (dir === undefined ? undefined : local(dir)))

  it('list returns exists:false for an empty/missing memory dir', async () => {
    const rep = await reader(newDir()).list({ agentId: 'bot-a' })
    expect(rep).toEqual({ agentId: 'bot-a', exists: false, entries: [] })
  })

  it('list returns the files once written', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'i')
    await writeMemoryFile(local(dir), 'deploys.md', 'd')
    const rep = await reader(dir).list({ agentId: 'bot-a' })
    expect(rep.exists).toBe(true)
    expect(rep.entries.map((e) => e.name)).toEqual([MEMORY_INDEX, 'deploys.md'])
  })

  it('read returns exists:false for a not-yet-created file', async () => {
    const rep = await reader(newDir()).read({ agentId: 'bot-a', path: MEMORY_INDEX, offset: 0, limit: 65536 })
    expect(rep).toEqual({ agentId: 'bot-a', path: MEMORY_INDEX, exists: false })
  })

  it('read returns a topic file slice with size/mtime/nextOffset', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), 'deploys.md', '# mem\nhello')
    const rep = await reader(dir).read({ agentId: 'bot-a', path: 'deploys.md', offset: 0, limit: 65536 })
    expect(rep.exists).toBe(true)
    expect(rep.content).toBe('# mem\nhello')
    expect(rep.nextOffset).toBe(rep.size)
    expect(rep.truncated).toBe(false)
  })

  it('write overwrites a named file and echoes size/mtime', async () => {
    const dir = newDir()
    const ok = await reader(dir).write({ agentId: 'bot-a', path: 'deploys.md', content: 'brand new' })
    expect(ok.path).toBe('deploys.md')
    expect(ok.size).toBe(Buffer.byteLength('brand new'))
    expect(readFileSync(join(memoryDir(dir), 'deploys.md'), 'utf8')).toBe('brand new')
  })

  it('returns bounded managed history pages through the dedicated reader method', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), 'deploys.md', 'v1')
    await writeMemoryFile(local(dir), 'deploys.md', 'v2', undefined, 'console')

    const page = await reader(dir).history({ agentId: 'bot-a', path: 'deploys.md', limit: 5 })
    expect(page).toMatchObject({
      agentId: 'bot-a',
      path: 'deploys.md',
      events: [
        { event: 'update', before: 'v1', after: 'v2', source: 'console' },
        { event: 'add', after: 'v1', source: 'tool' }
      ]
    })
  })

  it('rejects an unknown agent with MemoryViolationError', async () => {
    await expect(
      reader(undefined).read({ agentId: 'nope', path: MEMORY_INDEX, offset: 0, limit: 1 })
    ).rejects.toBeInstanceOf(MemoryViolationError)
  })

  it('rejects a path escape via MemoryPathError', async () => {
    await expect(
      reader(newDir()).read({ agentId: 'bot-a', path: '../escape', offset: 0, limit: 1 })
    ).rejects.toBeInstanceOf(MemoryPathError)
  })

  it('surfaces a stale ifMatchMtime as MemoryConflictError on write', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'v1')
    await expect(
      reader(dir).write({ agentId: 'bot-a', path: MEMORY_INDEX, content: 'v2', ifMatchMtime: 'stale' })
    ).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('routes legacy file frames through the selected file provider', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'managed content must stay hidden')
    const writes: Array<{ path: string; content: string; ifMatch?: string; source?: string }> = []
    const files = createMemoryReader(() => local(dir), {
      adminSurfaceForAgent: () => ({
        shape: 'files',
        list: async () => [
          { name: 'projects/workspace/memory/MEMORY.md', size: 14, mtime: '2026-07-16T00:00:00.000Z' }
        ],
        read: async (_scope, path) => ({ path, content: 'native content' }),
        write: async (_scope, path, content, ifMatch, source) => {
          writes.push({ path, content, ...(ifMatch ? { ifMatch } : {}), ...(source ? { source } : {}) })
          return { ok: true, path, size: Buffer.byteLength(content), mtime: '2026-07-16T00:01:00.000Z' }
        }
      })
    })

    await expect(files.list({ agentId: 'bot-a' })).resolves.toMatchObject({
      entries: [{ name: 'projects/workspace/memory/MEMORY.md' }]
    })
    await expect(
      files.read({ agentId: 'bot-a', path: 'projects/workspace/memory/MEMORY.md', offset: 0, limit: 65_536 })
    ).resolves.toMatchObject({ content: 'native content', size: 14, mtime: '2026-07-16T00:00:00.000Z' })
    await expect(
      files.write({
        agentId: 'bot-a',
        path: 'projects/workspace/memory/MEMORY.md',
        content: 'updated native',
        ifMatchMtime: '2026-07-16T00:00:00.000Z'
      })
    ).resolves.toMatchObject({ size: 14, mtime: '2026-07-16T00:01:00.000Z' })
    await expect(
      files.history({ agentId: 'bot-a', path: 'projects/workspace/memory/MEMORY.md', limit: 5 })
    ).rejects.toBeInstanceOf(MemoryViolationError)
    expect(writes).toEqual([
      {
        path: 'projects/workspace/memory/MEMORY.md',
        content: 'updated native',
        ifMatch: '2026-07-16T00:00:00.000Z',
        source: 'console'
      }
    ])
    expect(await readMemoryFile(local(dir), MEMORY_INDEX)).toBe('managed content must stay hidden')
  })

  it('routes an external provider through records and blocks the underlying file surface', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'must stay hidden')
    const record = {
      id: 'record-1',
      text: 'deploy in sea',
      scope: { kind: 'agent' as const, key: 'ac:agent:bot-a' },
      version: 'v1'
    }
    let updatedVersion: string | undefined
    const records = createMemoryReader(() => local(dir), {
      adminSurfaceForAgent: () => ({
        shape: 'records',
        capabilities: new Set(['recall', 'list', 'get', 'create', 'update', 'delete', 'history'] as const),
        search: async () => [record],
        list: async () => ({ records: [record], nextCursor: 'next' }),
        get: async () => record,
        create: async (_scope, req) => ({ ...record, id: 'record-new', text: req.text }),
        update: async (_scope, req) => {
          updatedVersion = req.version
          return { ...record, text: req.text, version: 'v2' }
        },
        delete: async () => true,
        history: async () => ({
          events: [{ id: 'event-1', event: 'update', at: '2026-07-16T00:00:00.000Z', record }]
        })
      })
    })

    await expect(records.surface({ agentId: 'bot-a' })).resolves.toMatchObject({
      shape: 'records',
      capabilities: expect.arrayContaining(['list', 'update'])
    })
    await expect(records.recordList({ agentId: 'bot-a', limit: 20 })).resolves.toMatchObject({
      records: [{ id: 'record-1' }],
      nextCursor: 'next'
    })
    await expect(
      records.recordUpdate({
        agentId: 'bot-a',
        operationId: 'op-1',
        id: 'record-1',
        text: 'deploy safely',
        version: 'v1'
      })
    ).resolves.toMatchObject({ record: { text: 'deploy safely', version: 'v2' } })
    expect(updatedVersion).toBe('v1')
    await expect(records.read({ agentId: 'bot-a', path: MEMORY_INDEX, offset: 0, limit: 10 })).rejects.toThrow(
      'does not expose files'
    )
  })

  it('hides unsupported record actions at the router boundary', async () => {
    const records = createMemoryReader(() => local(newDir()), {
      adminSurfaceForAgent: () => ({
        shape: 'records',
        capabilities: new Set(['recall', 'capture'] as const),
        search: async () => [],
        list: async () => ({ records: [] }),
        get: async () => null,
        create: async () => {
          throw new Error('must not call')
        },
        update: async () => {
          throw new Error('must not call')
        },
        delete: async () => false,
        history: async () => ({ events: [] })
      })
    })
    await expect(records.recordList({ agentId: 'bot-a', limit: 20 })).rejects.toThrow('does not support list')
  })
})

describe('memory MCP tools (executeTool)', () => {
  const ctx: SessionContext = {
    agentId: 'bot-a',
    platform: 'slack',
    integrationId: 'int-x',
    isDm: false,
    channel: 'C1',
    thread: 'T1',
    tools: []
  }
  const depsFor = (dir: string) =>
    ({
      // gatewayFor returns undefined — a memory-only agent has no Slack connection.
      gatewayFor: () => undefined,
      memory: createManagedMemoryProvider(() => local(dir)),
      recordOutbound: () => {},
      now: () => 0
    }) as unknown as OpsDeps

  it('writeMemory writes a topic file without a Slack gateway; readMemory reads it back', async () => {
    const dir = newDir()
    const w = (await executeTool(ctx, 'writeMemory', { path: 'deploys.md', content: '# d\n- ship' }, depsFor(dir))) as {
      ok: boolean
      path: string
    }
    expect(w.ok).toBe(true)
    expect(w.path).toBe('deploys.md')
    expect(existsSync(join(memoryDir(dir), 'deploys.md'))).toBe(true)

    const read = (await executeTool(ctx, 'readMemory', { path: 'deploys.md' }, depsFor(dir))) as { content: string }
    expect(read.content).toBe('# d\n- ship')
  })

  it('writeMemory str-replace edits one exact occurrence in place', async () => {
    const dir = newDir()
    await executeTool(ctx, 'writeMemory', { path: 'deploys.md', content: '# d\n- ship v1\n- keep' }, depsFor(dir))
    const w = (await executeTool(
      ctx,
      'writeMemory',
      { path: 'deploys.md', oldString: '- ship v1', newString: '- ship v2' },
      depsFor(dir)
    )) as { ok: boolean }
    expect(w.ok).toBe(true)
    const read = (await executeTool(ctx, 'readMemory', { path: 'deploys.md' }, depsFor(dir))) as { content: string }
    expect(read.content).toBe('# d\n- ship v2\n- keep')
  })

  it('writeMemory str-replace validates the edit pair atomically', async () => {
    const dir = newDir()
    await executeTool(ctx, 'writeMemory', { path: 'm.md', content: 'a\nx\nx' }, depsFor(dir))
    // not found / non-unique oldString
    await expect(
      executeTool(ctx, 'writeMemory', { path: 'm.md', oldString: 'nope', newString: 'y' }, depsFor(dir))
    ).rejects.toThrow(/not found.*readMemory.*non-memory session context/)
    await expect(
      executeTool(ctx, 'writeMemory', { path: 'm.md', oldString: 'x', newString: 'y' }, depsFor(dir))
    ).rejects.toThrow(/multiple times/)
    // both modes at once
    await expect(
      executeTool(ctx, 'writeMemory', { path: 'm.md', content: 'z', oldString: 'a', newString: 'b' }, depsFor(dir))
    ).rejects.toThrow(/not both/)
    // half an edit pair: newString without oldString, and oldString without newString → both rejected
    await expect(executeTool(ctx, 'writeMemory', { path: 'm.md', newString: 'y' }, depsFor(dir))).rejects.toThrow(
      /BOTH `oldString` and `newString`/
    )
    await expect(executeTool(ctx, 'writeMemory', { path: 'm.md', oldString: 'a' }, depsFor(dir))).rejects.toThrow(
      /BOTH `oldString` and `newString`/
    )
  })

  it('writeMemory str-replace deletes the matched text on an explicit empty newString', async () => {
    const dir = newDir()
    await executeTool(ctx, 'writeMemory', { path: 'm.md', content: 'keep\nDROP ME\ntail' }, depsFor(dir))
    await executeTool(ctx, 'writeMemory', { path: 'm.md', oldString: 'DROP ME\n', newString: '' }, depsFor(dir))
    const read = (await executeTool(ctx, 'readMemory', { path: 'm.md' }, depsFor(dir))) as { content: string }
    expect(read.content).toBe('keep\ntail')
  })

  it('writeMemory defaults to the MEMORY.md index when no path given', async () => {
    const dir = newDir()
    await executeTool(ctx, 'writeMemory', { content: '# index' }, depsFor(dir))
    expect(readFileSync(indexPath(dir), 'utf8')).toBe('# index')
  })

  it('readMemory defaults to the index', async () => {
    const dir = newDir()
    await writeMemoryFile(local(dir), MEMORY_INDEX, 'the index')
    const read = (await executeTool(ctx, 'readMemory', {}, depsFor(dir))) as { path: string; content: string }
    expect(read.path).toBe('MEMORY.md')
    expect(read.content).toBe('the index')
  })

  it('rejects a path escape', async () => {
    await expect(executeTool(ctx, 'writeMemory', { path: '../evil', content: 'x' }, depsFor(newDir()))).rejects.toThrow(
      /invalid memory path/
    )
  })

  it('executes stable record tools with trusted agent scope and core operation ids', async () => {
    const record = {
      id: 'record-1',
      text: 'deploy in sea',
      scope: { kind: 'agent' as const, key: 'ac:agent:bot-a' },
      version: 'v1'
    }
    let searchScope: { agentId: string } | undefined
    let createOperationId: string | undefined
    let updateVersion: string | undefined
    const surface = {
      shape: 'records' as const,
      capabilities: new Set(['recall', 'create', 'get', 'update', 'delete'] as const),
      search: async (scope: { agentId: string }) => {
        searchScope = scope
        return [record]
      },
      list: async () => ({ records: [record] }),
      get: async () => record,
      create: async (_scope: { agentId: string }, req: { operationId: string; text: string }) => {
        createOperationId = req.operationId
        return { ...record, text: req.text }
      },
      update: async (
        _scope: { agentId: string },
        req: { operationId: string; id: string; text: string; version?: string }
      ) => {
        updateVersion = req.version
        return { ...record, text: req.text, version: 'v2' }
      },
      delete: async () => true,
      history: async () => ({ events: [] })
    }
    const deps = {
      gatewayFor: () => undefined,
      memory: {
        adminSurface: () => null,
        adminSurfaceForAgent: (agentId: string) => (agentId === 'bot-a' ? surface : null)
      },
      recordOutbound: () => {},
      now: () => 0
    } as unknown as OpsDeps

    await expect(executeTool(ctx, 'searchMemory', { query: 'where?' }, deps)).resolves.toEqual({ records: [record] })
    expect(searchScope).toEqual({ agentId: 'bot-a' })
    await expect(executeTool(ctx, 'saveMemory', { text: 'deploy safely' }, deps)).resolves.toMatchObject({
      record: { text: 'deploy safely' }
    })
    expect(createOperationId).toMatch(/^[0-9a-f-]{36}$/)
    await expect(
      executeTool(ctx, 'updateMemory', { id: 'record-1', text: 'deploy verified', version: 'v1' }, deps)
    ).resolves.toMatchObject({ record: { text: 'deploy verified', version: 'v2' } })
    expect(updateVersion).toBe('v1')
    await expect(executeTool(ctx, 'deleteMemory', { id: 'record-1', version: 'v2' }, deps)).resolves.toEqual({
      id: 'record-1',
      deleted: true
    })
  })
})

describe('memory/provider (ManagedMemoryProvider)', () => {
  const provider = (dir: string | undefined) =>
    createManagedMemoryProvider(() => (dir === undefined ? undefined : local(dir)))
  const scope = { agentId: 'bot-a' }

  it('kind is managed', () => {
    expect(provider(newDir()).kind).toBe('managed')
  })

  it('ensure seeds MEMORY.md and is idempotent', async () => {
    const dir = newDir()
    const p = provider(dir)
    await p.ensure(scope, 'bot-a')
    expect(readFileSync(indexPath(dir), 'utf8')).toContain('# bot-a memory')
    await p.write(scope, MEMORY_INDEX, 'kept')
    await p.ensure(scope, 'bot-a') // must not overwrite
    expect(readFileSync(indexPath(dir), 'utf8')).toBe('kept')
  })

  it('list delegates to listMemory (index first), read/write round-trip in tool shapes', async () => {
    const dir = newDir()
    const p = provider(dir)
    expect(await p.list(scope)).toEqual([]) // missing dir ⇒ []
    const w = await p.write(scope, 'deploys.md', '# d\n- ship')
    expect(w).toEqual({
      ok: true,
      path: 'deploys.md',
      size: Buffer.byteLength('# d\n- ship'),
      mtime: expect.any(String)
    })
    await p.write(scope, MEMORY_INDEX, 'i')
    expect((await p.list(scope)).map((f) => f.name)).toEqual([MEMORY_INDEX, 'deploys.md'])
    expect(await p.read(scope, 'deploys.md')).toEqual({ path: 'deploys.md', content: '# d\n- ship' })
    expect(await p.read(scope, 'missing.md')).toEqual({ path: 'missing.md', content: '' }) // ENOENT ⇒ ''
  })

  it('standingContextAtSessionStart equals readIndex, truncating a huge index', async () => {
    const dir = newDir()
    const p = provider(dir)
    await p.write(scope, MEMORY_INDEX, 'x'.repeat(MAX_INDEX_INJECT_BYTES + 5000))
    const injected = await p.standingContextAtSessionStart(scope)
    expect(injected).toBe(await readIndex(local(dir))) // byte-identical to the primitive
    expect(Buffer.byteLength(injected)).toBeLessThanOrEqual(MAX_INDEX_INJECT_BYTES)
    expect(injected).toContain('truncated')
  })

  it('lets the memory error classes propagate raw (guards the MCP + CP mappings)', async () => {
    const p = provider(newDir())
    await expect(p.read(scope, '../escape')).rejects.toBeInstanceOf(MemoryPathError)
    await expect(p.write(scope, 'big.md', 'x'.repeat(MAX_MEMORY_FILE_BYTES + 1))).rejects.toBeInstanceOf(
      MemoryTooLargeError
    )
    await p.write(scope, 'notes.md', 'v1')
    await expect(p.write(scope, 'notes.md', 'v2', 'stale-mtime')).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('throws the same "unknown agent" message the MCP path relies on', async () => {
    const p = provider(undefined)
    await expect(p.list(scope)).rejects.toThrow('unknown agent bot-a')
    await expect(p.read(scope, MEMORY_INDEX)).rejects.toThrow('unknown agent bot-a')
    await expect(p.write(scope, MEMORY_INDEX, 'x')).rejects.toThrow('unknown agent bot-a')
  })

  it('tools() are the MEMORY_TOOLS descriptors', () => {
    expect(provider(newDir()).tools()).toBe(MEMORY_TOOLS)
  })

  it('runtimeEnv disables the runtime own-memory for claude (managed keeps one store); recordTurn is a no-op', async () => {
    const p = provider(newDir())
    // managed turns OFF claude's auto-memory so ours is the only store
    expect(p.runtimeEnv({ command: 'claude', args: [], env: [] } as never)).toEqual({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
    })
    // Codex uses its structured runtime config to disable competing native memories.
    expect(p.runtimeEnv({ command: 'codex', args: [], env: [] } as never)).toEqual({
      CODEX_CONFIG: '{"features":{"memories":false}}'
    })
    await expect(p.recordTurn(scope, {} as never)).resolves.toBeUndefined()
  })
})
