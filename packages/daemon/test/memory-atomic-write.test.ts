import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { MemoryTransactionResult } from '@agentconnect.md/protocol'
import { MemoryAmbiguousWriteError } from '../src/memory/atomic-write.js'
import { MemoryConflictError, type MemoryFs, type MemoryFsTransactionRequest } from '../src/memory/fs.js'
import { memoryWriteMarks, writeMemoryFile, type MemoryHistorySink } from '../src/memory/store.js'

const NOW = '2026-09-09T14:00:00.000Z'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
type Commit = Extract<MemoryFsTransactionRequest, { operation: 'commit' }>
function fixture(initial: Record<string, string> = {}) {
  const staged = new Map<string, string>()
  const commands: Commit[] = []
  const finish = (req: Commit): MemoryTransactionResult => ({
    operation: 'commit',
    replayed: false,
    receipt: {
      operationId: req.operationId,
      revision: 'b'.repeat(64),
      committedAt: NOW,
      files: req.changes.map((change) => ({
        path: change.path,
        revision: change.action === 'put' ? change.stagedRevision : null,
        mtime: NOW
      }))
    }
  })
  const commit = vi.fn(async (req: Commit) => finish(req))
  const fs: MemoryFs = {
    key: randomUUID(),
    root: '.',
    subdir: () => fs,
    readFile: vi.fn(async (path) =>
      path in initial ? { content: initial[path]!, size: Buffer.byteLength(initial[path]!), mtime: NOW } : null
    ),
    readdir: vi.fn(async () =>
      Object.entries(initial).map(([path, content]) => ({
        name: path.slice('memory/'.length),
        kind: 'file' as const,
        size: Buffer.byteLength(content),
        mtime: NOW
      }))
    ),
    writeFile: vi.fn(async () => {
      throw new Error('sequential publication forbidden')
    }),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => false),
    rm: vi.fn(async () => {}),
    utimes: vi.fn(async () => {}),
    stageTransactionFile: vi.fn(async (_root, content) => {
      const temp = `.agentconnect-memory-${randomUUID()}.tmp`
      staged.set(temp, content)
      return { temp, revision: hash(content) }
    }),
    atomicTransaction: vi.fn(async (req: MemoryFsTransactionRequest): Promise<MemoryTransactionResult> => {
      if (req.operation === 'snapshot') return { operation: 'snapshot', revision: 'a'.repeat(64) }
      commands.push(req)
      return commit(req)
    })
  }
  const history: MemoryHistorySink = { append: vi.fn(async () => {}), carryInto: vi.fn(async () => {}) }
  const write = (content: string, source: 'tool' | 'distill' = 'tool', ifMatch?: string) =>
    writeMemoryFile(fs, 'topic.md', content, ifMatch, source, history)
  return { fs, history, write, commands, staged, commit, finish }
}

describe('managed atomic publication', () => {
  it('publishes normalized topic plus derived index and leaves history to the transaction', async () => {
    const f = fixture({
      'memory/MEMORY.md': '# Personal memory\n',
      'memory/other.md': '---\ndescription: other\n---\n\nHi'
    })
    const result = await f.write('---\ndescription: ship: prod\nmetadata:\n  owner: me\n---\n\nSee [[other]]')
    expect(result.mtime).toBe(NOW)
    const req = f.commands[0]!
    expect(req.source).toBe('tool')
    expect(req.changes.map((c) => c.path)).toEqual(['topic.md', 'MEMORY.md'])
    const texts = [...f.staged.values()]
    expect(texts[0]).toContain('description: "ship: prod"')
    expect(texts[0]).toContain('metadata:\n  owner: me')
    expect(texts[0]).toContain('[[other]]')
    expect(texts[1]).toContain('# Personal memory')
    expect(texts[1]).toContain('[topic](topic.md) — ship: prod')
    expect(texts[1]).toContain('[other](other.md) — other')
    expect(f.history.append).not.toHaveBeenCalled()
    expect(f.fs.writeFile).not.toHaveBeenCalled()
    expect(memoryWriteMarks(f.fs)).toMatchObject({ total: 1, nonDistill: 1 })
  })

  it('keeps a handwritten index until a described topic adopts it and treats empty text as a write', async () => {
    const f = fixture({ 'memory/MEMORY.md': '# Handwritten\nKeep me' })
    await f.write('')
    expect(f.commands[0]!.changes.map((c) => c.path)).toEqual(['topic.md'])
    expect([...f.staged.values()]).toEqual([''])
  })

  it('retains the legacy path for non-Markdown filenames outside the atomic contract', async () => {
    const f = fixture()
    vi.mocked(f.fs.writeFile).mockResolvedValue({ size: 0, mtime: NOW })
    await writeMemoryFile(f.fs, 'notes.txt', '', undefined, 'tool', f.history)
    expect(f.fs.atomicTransaction).not.toHaveBeenCalled()
    expect(f.fs.writeFile).toHaveBeenCalledWith('memory/notes.txt', '', {})
    expect(f.history.append).toHaveBeenCalledTimes(1)
  })

  it('checks legacy conditional mtime before staging, including a missing target', async () => {
    const f = fixture()
    await expect(f.write('new', 'tool', NOW)).rejects.toBeInstanceOf(MemoryConflictError)
    expect(f.fs.stageTransactionFile).not.toHaveBeenCalled()
    expect(f.commands).toHaveLength(0)
  })

  it('returns a root conflict without retrying against newer content and cleans staging', async () => {
    const f = fixture()
    f.commit.mockResolvedValue({ operation: 'error', code: 'CONFLICT', message: 'tree changed' })
    await expect(f.write('---\ndescription: hi\n---\n\nNew')).rejects.toBeInstanceOf(MemoryConflictError)
    expect(f.commands).toHaveLength(1)
    expect(f.fs.rm).toHaveBeenCalledTimes(2)
    expect(memoryWriteMarks(f.fs).total).toBe(0)
  })

  it('replays exactly the same prepared operation after a lost response, counting it once', async () => {
    const f = fixture()
    f.commit
      .mockRejectedValueOnce(new Error('reply lost'))
      .mockImplementationOnce(async (req) => ({ ...f.finish(req), replayed: true }) as MemoryTransactionResult)
    await f.write('new')
    expect(f.commands).toHaveLength(2)
    expect(f.commands[0]).toBe(f.commands[1])
    expect(f.fs.stageTransactionFile).toHaveBeenCalledTimes(1)
    expect(memoryWriteMarks(f.fs).total).toBe(1)
  })

  it('keeps staging and blocks Dream rebase when a distillation publication remains ambiguous', async () => {
    const f = fixture()
    f.commit.mockRejectedValue(new Error('connection lost'))
    await expect(f.write('new', 'distill')).rejects.toBeInstanceOf(MemoryAmbiguousWriteError)
    expect(f.commands).toHaveLength(2)
    expect(f.fs.rm).not.toHaveBeenCalled()
    expect(memoryWriteMarks(f.fs)).toMatchObject({ total: 1, nonDistill: 1 })
  })

  it('does not interpret a denial after a lost reply as proof that the first write failed', async () => {
    const f = fixture()
    f.commit
      .mockRejectedValueOnce(new Error('reply lost'))
      .mockResolvedValueOnce({ operation: 'error', code: 'FORBIDDEN', message: 'home changed' })
    await expect(f.write('new')).rejects.toBeInstanceOf(MemoryAmbiguousWriteError)
    expect(f.fs.rm).not.toHaveBeenCalled()
  })

  it('rejects an incomplete receipt instead of claiming the index committed', async () => {
    const f = fixture()
    f.commit.mockImplementationOnce(async (req) => {
      const result = f.finish(req)
      if (result.operation !== 'commit') throw new Error('expected receipt')
      result.receipt.files.pop()
      return result
    })
    await expect(f.write('---\ndescription: hi\n---\n\nNew')).rejects.toBeInstanceOf(MemoryAmbiguousWriteError)
    expect(f.fs.rm).not.toHaveBeenCalled()
    expect(memoryWriteMarks(f.fs).nonDistill).toBe(1)
  })

  it('cleans an already staged topic when staging its index fails, with no publication', async () => {
    const f = fixture()
    vi.mocked(f.fs.stageTransactionFile!)
      .mockImplementationOnce(async (_root, content) => ({
        temp: '.agentconnect-memory-staged.tmp',
        revision: hash(content)
      }))
      .mockRejectedValueOnce(new Error('stage failed'))
    await expect(f.write('---\ndescription: hi\n---\n\nNew')).rejects.toThrow('stage failed')
    expect(f.fs.rm).toHaveBeenCalledWith('memory/.agentconnect-memory-staged.tmp')
    expect(f.commands).toHaveLength(0)
  })
})
