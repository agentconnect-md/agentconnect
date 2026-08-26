import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import {
  createWorkspaceReader,
  WorkspaceConflictError,
  WorkspaceViolationError,
  type WorkspaceReader,
  type WorkspaceWriteCoordinator
} from '../src/cp/workspace-reader.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'

// One plane per test file — the isolation Vitest's per-file module registry used to give.
const workspaces = new WorkspaceManager()

const AGENT = 'bot-a'

let base: string // scratch dir; ws = the workspace root, outside/ = sibling secrets
let ws: string
let outside: string
let reader: WorkspaceReader
const directWrite: WorkspaceWriteCoordinator = (_agentId, write) => write()

const listReq = (over: Partial<Parameters<WorkspaceReader['list']>[0]> = {}) => ({
  agentId: AGENT,
  path: '',
  limit: 200,
  ...over
})
const readReq = (path: string, over: Partial<Parameters<WorkspaceReader['read']>[0]> = {}) => ({
  agentId: AGENT,
  path,
  offset: 0,
  limit: 65536,
  ...over
})
const writeReq = (
  path: string,
  content: string,
  ifMatchMtime: string,
  over: Partial<Parameters<WorkspaceReader['write']>[0]> = {}
) => ({
  agentId: AGENT,
  path,
  contentBase64: Buffer.from(content, 'utf8').toString('base64'),
  ifMatchMtime,
  ...over
})
const createReq = (path: string, content: string): Parameters<WorkspaceReader['write']>[0] => ({
  agentId: AGENT,
  path,
  contentBase64: Buffer.from(content, 'utf8').toString('base64')
})
const deleteReq = (path: string, ifMatchMtime: string): Parameters<WorkspaceReader['delete']>[0] => ({
  agentId: AGENT,
  path,
  ifMatchMtime
})

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ws-reader-'))
  ws = join(base, 'workspace')
  outside = join(base, 'outside')
  mkdirSync(ws)
  mkdirSync(outside)
  reader = createWorkspaceReader(
    workspaces,
    async (id) => (id === AGENT ? { root: ws, scratch: true } : undefined),
    directWrite
  )
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('workspace list', () => {
  it('selects an isolated session worktree without changing the primary checkout', async () => {
    const worktree = join(base, 'worktree')
    mkdirSync(worktree)
    writeFileSync(join(ws, 'primary.txt'), 'primary')
    writeFileSync(join(worktree, 'session.txt'), 'session')
    const scoped = createWorkspaceReader(
      workspaces,
      async (id, sessionId) =>
        id === AGENT
          ? { root: sessionId === 'session-a' ? worktree : ws, scratch: sessionId === undefined }
          : undefined,
      directWrite
    )

    expect((await scoped.list(listReq())).entries.map((entry) => entry.name)).toEqual(['primary.txt'])
    expect((await scoped.list(listReq({ sessionId: 'session-a' }))).entries.map((entry) => entry.name)).toEqual([
      'session.txt'
    ])
  })

  it('lists the root: dirs first, then case-insensitive alphabetical, with size/mtime on files', async () => {
    writeFileSync(join(ws, 'Zebra.txt'), 'zz')
    writeFileSync(join(ws, 'apple.txt'), 'aaaa')
    mkdirSync(join(ws, 'src'))
    mkdirSync(join(ws, 'Docs'))

    const page = await reader.list(listReq())
    expect(page.exists).toBe(true)
    expect(page.path).toBe('')
    expect(page.entries.map((e) => e.name)).toEqual(['Docs', 'src', 'apple.txt', 'Zebra.txt'])
    expect(page.entries.map((e) => e.type)).toEqual(['dir', 'dir', 'file', 'file'])
    const apple = page.entries.find((e) => e.name === 'apple.txt')!
    expect(apple.size).toBe(4)
    expect(apple.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(page.nextCursor).toBeUndefined()
  })

  it('lists a nested dir', async () => {
    mkdirSync(join(ws, 'src', 'lib'), { recursive: true })
    writeFileSync(join(ws, 'src', 'lib', 'a.ts'), 'x')

    const page = await reader.list(listReq({ path: 'src/lib' }))
    expect(page.exists).toBe(true)
    expect(page.path).toBe('src/lib')
    expect(page.entries).toEqual([{ name: 'a.ts', type: 'file', size: 1, mtime: expect.any(String) }])
  })

  it('paginates with an opaque cursor walk', async () => {
    for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) writeFileSync(join(ws, n), n)

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await reader.list(listReq({ limit: 2, ...(cursor ? { cursor } : {}) }))
      seen.push(...page.entries.map((e) => e.name))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== undefined)
    expect(pages).toBe(3)
    expect(seen).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'])
  })

  it('filters out .git', async () => {
    mkdirSync(join(ws, '.git'))
    writeFileSync(join(ws, 'README.md'), 'hi')

    const page = await reader.list(listReq())
    expect(page.entries.map((e) => e.name)).toEqual(['README.md'])
  })

  it('missing workspace root → exists:false (data, not an error)', async () => {
    rmSync(ws, { recursive: true })
    const page = await reader.list(listReq())
    expect(page).toMatchObject({ exists: false, entries: [] })
  })

  it('missing dir inside the workspace → exists:false', async () => {
    const page = await reader.list(listReq({ path: 'no/such/dir' }))
    expect(page).toMatchObject({ exists: false, entries: [] })
  })
})

describe('path containment', () => {
  it('rejects direct reads of git internals', async () => {
    mkdirSync(join(ws, '.git'))
    writeFileSync(join(ws, '.git', 'config'), 'url = https://user:token@example.test/repo')
    symlinkSync(join(ws, '.git'), join(ws, 'metadata'))

    await expect(reader.list(listReq({ path: '.git' }))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.read(readReq('.git/config'))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.list(listReq({ path: 'metadata' }))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.read(readReq('metadata/config'))).rejects.toBeInstanceOf(WorkspaceViolationError)
  })

  it("rejects '..' escapes on list and read", async () => {
    writeFileSync(join(outside, 'secret.env'), 'TOKEN=x')
    await expect(reader.list(listReq({ path: '../outside' }))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.read(readReq('../outside/secret.env'))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(
      reader.write(
        writeReq('../outside/secret.env', 'changed', statSync(join(outside, 'secret.env')).mtime.toISOString())
      )
    ).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(
      reader.delete(deleteReq('../outside/secret.env', statSync(join(outside, 'secret.env')).mtime.toISOString()))
    ).rejects.toBeInstanceOf(WorkspaceViolationError)
    // deeper mixed escape too
    await expect(reader.read(readReq('src/../../outside/secret.env'))).rejects.toBeInstanceOf(WorkspaceViolationError)
  })

  it('rejects absolute paths', async () => {
    await expect(reader.list(listReq({ path: outside }))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.read(readReq(join(outside, 'x')))).rejects.toBeInstanceOf(WorkspaceViolationError)
  })

  it('rejects a symlink inside the workspace pointing outside (list and read through it)', async () => {
    writeFileSync(join(outside, 'secret.env'), 'TOKEN=x')
    symlinkSync(outside, join(ws, 'sneaky-dir'))
    symlinkSync(join(outside, 'secret.env'), join(ws, 'sneaky-file'))

    await expect(reader.list(listReq({ path: 'sneaky-dir' }))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.read(readReq('sneaky-dir/secret.env'))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.read(readReq('sneaky-file'))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.write(createReq('sneaky-dir/new.txt', 'nope'))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(
      reader.delete(deleteReq('sneaky-file', statSync(join(outside, 'secret.env')).mtime.toISOString()))
    ).rejects.toBeInstanceOf(WorkspaceViolationError)
  })

  it('unknown agent → violation (BAD_PAYLOAD, not INTERNAL)', async () => {
    await expect(reader.list(listReq({ agentId: 'nope' }))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.read(readReq('a.txt', { agentId: 'nope' }))).rejects.toBeInstanceOf(WorkspaceViolationError)
  })
})

describe('workspace read', () => {
  it('missing file → exists:false (data, not an error)', async () => {
    const r = await reader.read(readReq('nope.txt'))
    expect(r).toEqual({ agentId: AGENT, path: 'nope.txt', exists: false })
  })

  it('binary file → encoding none, no content', async () => {
    writeFileSync(join(ws, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]))
    const r = await reader.read(readReq('blob.bin'))
    expect(r.exists).toBe(true)
    expect(r.encoding).toBe('none')
    expect(r.content).toBeUndefined()
    expect(r.size).toBe(6)
    expect(r.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('reads a text slice with offset/limit and sets truncated', async () => {
    writeFileSync(join(ws, 'notes.txt'), 'hello world!')

    const whole = await reader.read(readReq('notes.txt'))
    expect(whole).toMatchObject({
      exists: true,
      encoding: 'utf8',
      content: 'hello world!',
      size: 12,
      offset: 0,
      truncated: false
    })

    const head = await reader.read(readReq('notes.txt', { limit: 5 }))
    expect(head).toMatchObject({ content: 'hello', offset: 0, truncated: true })

    const mid = await reader.read(readReq('notes.txt', { offset: 6, limit: 5 }))
    expect(mid).toMatchObject({ content: 'world', offset: 6, truncated: true })

    const tail = await reader.read(readReq('notes.txt', { offset: 6, limit: 100 }))
    expect(tail).toMatchObject({ content: 'world!', offset: 6, truncated: false })

    const past = await reader.read(readReq('notes.txt', { offset: 100 }))
    expect(past).toMatchObject({ content: '', offset: 100, truncated: false })
  })

  it('directory read → DATA (type:dir, no content), so it is not an offline-looking error', async () => {
    mkdirSync(join(ws, 'src'))
    const r = await reader.read(readReq('src'))
    expect(r).toEqual({
      agentId: AGENT,
      path: 'src',
      exists: true,
      type: 'dir',
      mtime: statSync(join(ws, 'src')).mtime.toISOString()
    })
    expect(r.content).toBeUndefined()
    expect(r.encoding).toBeUndefined()
    // A regular file still names itself, so the console can branch on one field.
    writeFileSync(join(ws, 'src', 'a.txt'), 'hi')
    expect((await reader.read(readReq('src/a.txt'))).type).toBe('file')
  })

  // Needs a FIFO and O_NOFOLLOW semantics, neither of which Windows offers — tracked separately.
  it.skipIf(process.platform === 'win32')(
    'a non-regular, non-directory target keeps the violation — with a machine-readable reason',
    async () => {
      // A FIFO is neither a file nor a directory: reading it would block on a writer,
      // so it stays a violation the CP can answer with a code (not a 503).
      execFileSync('mkfifo', [join(ws, 'pipe')])
      await expect(reader.read(readReq('pipe'))).rejects.toMatchObject({
        name: 'WorkspaceViolationError',
        reason: 'not-a-file'
      })
    }
  )

  it('write and delete still refuse a directory (a mutation cannot be data)', async () => {
    mkdirSync(join(ws, 'docs'))
    const mtime = statSync(join(ws, 'docs')).mtime.toISOString()
    await expect(reader.write(writeReq('docs', 'x', mtime))).rejects.toMatchObject({ reason: 'not-a-file' })
    await expect(reader.delete(deleteReq('docs', mtime))).rejects.toMatchObject({ reason: 'not-a-file' })
  })

  it('reports nextOffset (not a client recount) so paging is exact', async () => {
    writeFileSync(join(ws, 'notes.txt'), 'hello world!')
    const head = await reader.read(readReq('notes.txt', { limit: 5 }))
    expect(head).toMatchObject({ content: 'hello', offset: 0, nextOffset: 5, truncated: true })
    const next = await reader.read(readReq('notes.txt', { offset: head.nextOffset!, limit: 5 }))
    expect(next).toMatchObject({ content: ' worl', offset: 5, nextOffset: 10 })
  })

  it('never splits a multi-byte UTF-8 char at the slice boundary', async () => {
    // 'a' (1 byte) + '€' (3 bytes: E2 82 AC) = 4 bytes.
    writeFileSync(join(ws, 'utf.txt'), 'a€')
    // limit=2 lands mid-'€'; the incomplete char must be dropped, not corrupted.
    const first = await reader.read(readReq('utf.txt', { limit: 2 }))
    expect(first.content).toBe('a')
    expect(first.nextOffset).toBe(1) // only the complete 'a' byte was consumed
    expect(first.truncated).toBe(true)
    expect(first.content).not.toContain('�') // no replacement char
    // resuming at nextOffset yields the whole '€'
    const rest = await reader.read(readReq('utf.txt', { offset: first.nextOffset! }))
    expect(rest.content).toBe('€')
    expect(rest.truncated).toBe(false)
  })

  it('bounds a control-byte file so the JSON-escaped REP stays under the frame cap', async () => {
    // 0x01 is not NUL, so it reads as utf8 content; JSON escapes each to 
    // (6 bytes) — a raw 64 KiB slice would serialize to ~393 KiB and blow the cap.
    writeFileSync(join(ws, 'ctrl.txt'), Buffer.alloc(64 * 1024, 0x01))
    const r = await reader.read(readReq('ctrl.txt'))
    expect(r.encoding).toBe('utf8')
    expect(r.truncated).toBe(true) // shrunk below the raw 64 KiB request
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(MAX_FRAME_BYTES)
  })
})

describe('workspace write', () => {
  it('creates missing directories without overwriting a concurrent creator', async () => {
    const outcomes = await Promise.allSettled([
      reader.write(createReq('notes/plans/todo.md', 'first')),
      reader.write(createReq('notes/plans/todo.md', 'second'))
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected).toMatchObject({ reason: expect.any(WorkspaceConflictError) })
    expect(['first', 'second']).toContain(readFileSync(join(ws, 'notes', 'plans', 'todo.md'), 'utf8'))
  })

  it('atomically replaces one existing scratch text file and returns its new state', async () => {
    const target = join(ws, 'notes.md')
    writeFileSync(target, '# Before\n')
    const before = statSync(target)

    const result = await reader.write(writeReq('notes.md', '# After\n', before.mtime.toISOString()))

    expect(readFileSync(target, 'utf8')).toBe('# After\n')
    expect(result).toMatchObject({ agentId: AGENT, path: 'notes.md', size: 8 })
    expect(result.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rejects stale edits and any write outside a scratch workspace', async () => {
    const target = join(ws, 'notes.md')
    writeFileSync(target, 'current')

    await expect(reader.write(writeReq('notes.md', 'stale', '2026-01-01T00:00:00.000Z'))).rejects.toBeInstanceOf(
      WorkspaceConflictError
    )

    const repoReader = createWorkspaceReader(
      workspaces,
      async (id) => (id === AGENT ? { root: ws, scratch: false } : undefined),
      directWrite
    )
    await expect(
      repoReader.write(writeReq('notes.md', 'changed', statSync(target).mtime.toISOString()))
    ).rejects.toBeInstanceOf(WorkspaceViolationError)
    expect(readFileSync(target, 'utf8')).toBe('current')
  })
})

describe('workspace delete', () => {
  it('deletes an unchanged scratch file and rejects a stale retry', async () => {
    const target = join(ws, 'notes.md')
    writeFileSync(target, 'current')
    const before = statSync(target).mtime.toISOString()

    await expect(reader.delete(deleteReq('notes.md', before))).resolves.toEqual({
      agentId: AGENT,
      path: 'notes.md'
    })
    expect(existsSync(target)).toBe(false)
    await expect(reader.delete(deleteReq('notes.md', before))).rejects.toBeInstanceOf(WorkspaceConflictError)
  })

  it('keeps GitHub workspaces read-only', async () => {
    const target = join(ws, 'notes.md')
    writeFileSync(target, 'current')
    const repoReader = createWorkspaceReader(
      workspaces,
      async (id) => (id === AGENT ? { root: ws, scratch: false } : undefined),
      directWrite
    )

    await expect(repoReader.delete(deleteReq('notes.md', statSync(target).mtime.toISOString()))).rejects.toBeInstanceOf(
      WorkspaceViolationError
    )
    expect(readFileSync(target, 'utf8')).toBe('current')
  })
})

describe('frame-size budget on listings', () => {
  // Pads its listing with names built from `"`, which Windows does not allow in a filename.
  it.skipIf(process.platform === 'win32')(
    'keeps every page under the frame cap and still returns all entries',
    async () => {
      // Names full of '"' JSON-escape to 2× — enough entries at limit=500 overflow
      // the 256 KiB frame, forcing an early page break (never a single oversized REP).
      const quote = '"'.repeat(240)
      const names: string[] = []
      for (let i = 0; i < 500; i++) {
        const n = `${quote}${String(i).padStart(3, '0')}`
        names.push(n)
        writeFileSync(join(ws, n), 'x')
      }
      const seen = new Set<string>()
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await reader.list(listReq({ limit: 500, ...(cursor ? { cursor } : {}) }))
        expect(page.entries.length).toBeGreaterThan(0) // always makes progress
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(MAX_FRAME_BYTES)
        for (const e of page.entries) seen.add(e.name)
        cursor = page.nextCursor
        pages += 1
      } while (cursor !== undefined)
      expect(pages).toBeGreaterThan(1) // the byte budget broke the page before the count limit
      expect(seen.size).toBe(500)
      expect(names.every((n) => seen.has(n))).toBe(true)
    }
  )
  it('refuses a DIRECTORY behind an intermediate symlink instead of reporting its mtime', async () => {
    // Making a directory an ordinary answer reopened the oracle the git-diff seam had:
    // `lstat` follows intermediate components, so `vendor/private` behind a symlinked
    // `vendor` would report a host directory's existence and mtime.
    mkdirSync(join(outside, 'private'), { recursive: true })
    symlinkSync(outside, join(ws, 'vendor'), 'dir')

    await expect(reader.read({ agentId: AGENT, path: 'vendor/private', offset: 0, limit: 1024 })).rejects.toMatchObject(
      { reason: 'path-escape' }
    )
  })
})
