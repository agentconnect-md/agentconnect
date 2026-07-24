import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { createWorkspaceReader, WorkspaceViolationError, type WorkspaceReader } from '../src/cp/workspace-reader.js'

const AGENT = 'bot-a'

let base: string // scratch dir; ws = the workspace root, outside/ = sibling secrets
let ws: string
let outside: string
let reader: WorkspaceReader

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

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ws-reader-'))
  ws = join(base, 'workspace')
  outside = join(base, 'outside')
  mkdirSync(ws)
  mkdirSync(outside)
  reader = createWorkspaceReader((id) => (id === AGENT ? ws : undefined))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('workspace list', () => {
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
  it("rejects '..' escapes on list and read", async () => {
    writeFileSync(join(outside, 'secret.env'), 'TOKEN=x')
    await expect(reader.list(listReq({ path: '../outside' }))).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(reader.read(readReq('../outside/secret.env'))).rejects.toBeInstanceOf(WorkspaceViolationError)
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

  it('directory read → violation', async () => {
    mkdirSync(join(ws, 'src'))
    await expect(reader.read(readReq('src'))).rejects.toBeInstanceOf(WorkspaceViolationError)
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

describe('frame-size budget on listings', () => {
  it('keeps every page under the frame cap and still returns all entries', async () => {
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
  })
})
