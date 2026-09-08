// `CpMemoryFs` — the shim client over the CP connection (memory-evolution.md §3.2.1): the same op set, sliced and
// chunked the same way, against a tree-relative root, and one resolution when the home is out of reach.
import { afterAll, describe, expect, it } from 'vitest'
import { promises as fsp, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WireError } from '@agentconnect.md/connection'
import { MemoryStoreReq, type MemoryFsPayload, type MemoryFsReply } from '@agentconnect.md/protocol'
import { CpMemoryFs, joinTreeRoot, type CpMemoryStoreLink } from '../src/cp/memory-fs.js'
import {
  MemoryConflictError,
  MemoryHomeUnavailableError,
  MemoryPathError,
  MemorySandboxUnavailableError,
  type MemoryFs
} from '../src/memory/fs.js'
import { MEMORY_INDEX, ensureMemory, listMemory, readMemoryFile, writeMemoryFile } from '../src/memory/store.js'
import { ShimMemoryFs, applyMemoryFsPayload } from '../src/shim/memory-fs-channel.js'
import { REPLY_BUDGET } from '../src/wire-slice.js'
import { pathExecutor } from './fixtures/memory-fs-pod.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

const trees: string[] = []
afterAll(() => {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true })
})

/** A stand-in for the CP's handler: the agent's tree is one directory and every `root` resolves beneath it. */
function treeAnswerer(): { tree: string; answer: (op: MemoryFsPayload) => Promise<MemoryFsReply> } {
  const tree = mkdtempSync(join(tmpdir(), 'ac-cp-tree-'))
  trees.push(tree)
  const executor = pathExecutor()
  return { tree, answer: (op) => applyMemoryFsPayload({ ...op, root: join(tree, op.root) }, tree, executor) }
}

type FakeLink = CpMemoryStoreLink & { tree: string; requests: MemoryStoreReq[] }

/** The CP connection as the adapter sees it, answering from a tree directory and recording every request. */
function fakeLink(over: Partial<CpMemoryStoreLink> = {}): FakeLink {
  const { tree, answer } = treeAnswerer()
  const requests: MemoryStoreReq[] = []
  return {
    tree,
    requests,
    connected: () => true,
    supportsServerFeature: (feature) => feature === 'agent-memory-store-v1',
    // The wire's own parse, strict: a uuid agent, a non-empty root, and nothing beside `{ agentId, op }`.
    async memoryStore(req) {
      const parsed = MemoryStoreReq.parse(req)
      requests.push(parsed)
      return answer(parsed.op)
    },
    ...over
  }
}

describe('CpMemoryFs (the port over the CP connection)', () => {
  it('runs the managed memory tree on a tree-relative root, naming the agent on every request', async () => {
    const link = fakeLink()
    const fs = new CpMemoryFs(link, AGENT)
    expect(fs.root).toBe('.')
    expect(fs.key).toBe(`control-plane:${AGENT}:.`)
    await ensureMemory(fs, 'bot-a')
    expect(await fsp.readFile(join(link.tree, 'memory', MEMORY_INDEX), 'utf8')).toContain('# bot-a memory')
    await writeMemoryFile(fs, 'deploys.md', '- region sea\n', undefined, 'tool')
    expect(await readMemoryFile(fs, 'deploys.md')).toBe('- region sea\n')
    expect((await listMemory(fs)).map((f) => f.name)).toEqual([MEMORY_INDEX, 'deploys.md'])
    expect(link.requests.every((r) => r.agentId === AGENT && r.op.root === '.')).toBe(true)
    expect(link.requests.map((r) => r.op.op)).toContain('memory-commit')
  })

  it('writes an ordinary file as one append and one commit, and slices a large one across multi-byte boundaries', async () => {
    const link = fakeLink()
    const fs = new CpMemoryFs(link, AGENT)
    await fs.writeFile('memory/a.md', 'alpha')
    expect(link.requests.map((r) => r.op.op)).toEqual(['memory-append', 'memory-commit'])

    link.requests.length = 0
    const big = 'é'.repeat(300_000) // 600 KB, multi-byte, more than two reply budgets
    await fs.writeFile('memory/big.md', big)
    expect(link.requests.filter((r) => r.op.op === 'memory-append').length).toBeGreaterThan(2)
    link.requests.length = 0
    const read = await fs.readFile('memory/big.md')
    expect(read?.content).toBe(big)
    expect(read?.size).toBe(Buffer.byteLength(big))
    const reads = link.requests.map((r) => r.op).filter((op) => op.op === 'memory-read')
    expect(reads.length).toBeGreaterThan(2)
    expect(reads.every((op) => op.limit <= REPLY_BUDGET)).toBe(true)
  })

  it('carries the two typed refusals back as themselves and cleans a failed staging', async () => {
    const link = fakeLink()
    const fs = new CpMemoryFs(link, AGENT)
    const st = await fs.writeFile('memory/a.md', 'v1')
    await expect(
      fs.writeFile('memory/a.md', 'v2', { ifMatchMtime: '2000-01-01T00:00:00.000Z' })
    ).rejects.toBeInstanceOf(MemoryConflictError)
    expect(link.requests.at(-1)?.op.op).toBe('memory-rm')
    expect(await fsp.readdir(join(link.tree, 'memory'))).toEqual(['a.md'])
    await fs.writeFile('memory/a.md', 'v2', { ifMatchMtime: st.mtime })
    expect((await fs.readFile('memory/a.md'))?.content).toBe('v2')
    await expect(fs.readFile('../outside')).rejects.toBeInstanceOf(MemoryPathError)
    // A refusal the CP composes itself arrives as the same class.
    const refusing = fakeLink({
      memoryStore: async () => ({ ok: false, refusal: { kind: 'path' as const, message: 'not under the tree' } })
    })
    await expect(new CpMemoryFs(refusing, AGENT).readdir('memory')).rejects.toBeInstanceOf(MemoryPathError)
  })

  it('renames, removes, lists, and sets mtimes through the tree', async () => {
    const link = fakeLink()
    const fs = new CpMemoryFs(link, AGENT)
    await fs.writeFile('memory/a.md', 'alpha')
    await fs.mkdir('memory/topics')
    expect(await fs.rename('memory/a.md', 'memory/topics/b.md')).toBe(true)
    expect(await fs.rename('memory/absent.md', 'memory/c.md')).toBe(false)
    expect(await fs.readdir('memory')).toEqual([{ name: 'topics', kind: 'dir' }])
    const [entry] = await fs.readdir('memory/topics')
    expect(entry).toMatchObject({ name: 'b.md', kind: 'file', size: 5 })
    await fs.utimes('memory/topics/b.md', '2026-01-01T00:00:00.000Z')
    expect((await fs.readFile('memory/topics/b.md'))?.mtime).toBe('2026-01-01T00:00:00.000Z')
    await fs.rm('memory/topics')
    await fs.rm('memory/never-there')
    expect(await fs.readdir('memory')).toEqual([])
    expect(await fs.readFile('memory/topics/b.md')).toBeNull()
  })

  it('re-roots below the tree without ever forming a pod path', async () => {
    const link = fakeLink()
    const fs = new CpMemoryFs(link, AGENT)
    const channels = fs.subdir('channels')
    expect(channels.root).toBe('channels')
    expect(channels.key).toBe(`control-plane:${AGENT}:channels`)
    expect(channels.subdir('c1').root).toBe('channels/c1')
    expect(fs.subdir('.').root).toBe('.')
    await channels.writeFile('c1/meta.md', 'meta')
    expect(link.requests.map((r) => r.op.root)).toEqual(['channels', 'channels'])
    expect(await fsp.readFile(join(link.tree, 'channels', 'c1', 'meta.md'), 'utf8')).toBe('meta')
    expect(() => fs.subdir('../elsewhere')).toThrow(MemoryPathError)
    expect(() => new CpMemoryFs(link, AGENT, '/srv/agent')).toThrow(MemoryPathError)
    expect(new CpMemoryFs(link, AGENT, 'channels/').key).toBe(channels.key)
    expect(joinTreeRoot('.', '')).toBe('.')
  })

  it("refuses with one resolution per reason, and never falls back to this member's disk", async () => {
    const reason = (link: CpMemoryStoreLink) =>
      new CpMemoryFs(link, AGENT).readFile('memory/a.md').then(
        () => 'resolved',
        (err: unknown) => (err instanceof MemoryHomeUnavailableError ? err.reason : err)
      )
    const closed = fakeLink({ connected: () => false })
    expect(await reason(closed)).toBe('connection')
    const older = fakeLink({ supportsServerFeature: () => false })
    expect(await reason(older)).toBe('feature')
    // Neither reached the wire, and nothing touched a tree.
    expect(closed.requests).toEqual([])
    expect(older.requests).toEqual([])
    expect(await fsp.readdir(closed.tree)).toEqual([])

    const rejecting = (err: Error) =>
      fakeLink({
        memoryStore: async () => {
          throw err
        }
      })
    expect(await reason(rejecting(new WireError('SCOPE_DENIED', 'agent is not served here', false)))).toBe(
      'scope-denied'
    )
    expect(await reason(rejecting(new WireError('INTERNAL', 'no ack after 5 tries', true)))).toBe('connection')
    // The CP's own answers are final: they surface as the wire error they are, not as an unreachable home.
    const internal = await reason(rejecting(new WireError('INTERNAL', 'memory/store failed', false)))
    expect(internal).toBeInstanceOf(WireError)
    expect((internal as WireError).code).toBe('INTERNAL')

    // The sandbox home's refusal is the same family, so one catch covers every home.
    const asleep = new MemorySandboxUnavailableError('agent "bot-a" has no running sandbox')
    expect(asleep).toBeInstanceOf(MemoryHomeUnavailableError)
    expect(asleep.reason).toBe('sandbox-unavailable')
  })

  it('sends the very same op sequence the shim client sends — one code path, two carriers', async () => {
    const shimSide = treeAnswerer()
    const shimOps: MemoryFsPayload[] = []
    const channel = {
      agentId: AGENT,
      async request(capability: string, payload: unknown) {
        expect(capability).toBe('read')
        shimOps.push(payload as MemoryFsPayload)
        return shimSide.answer(payload as MemoryFsPayload)
      }
    }
    const cpSide = treeAnswerer()
    const cpOps: MemoryFsPayload[] = []
    const link: CpMemoryStoreLink = {
      connected: () => true,
      supportsServerFeature: () => true,
      async memoryStore(req) {
        expect(req.agentId).toBe(AGENT)
        cpOps.push(req.op)
        return cpSide.answer(req.op)
      }
    }
    // The same root string on both, so only the carrier differs (a pod root is absolute; this one is tree-relative).
    await script(new ShimMemoryFs(channel, 'tree'))
    await script(new CpMemoryFs(link, AGENT, 'tree'))
    expect(cpOps.length).toBeGreaterThan(12)
    expect(new Set(cpOps.map((op) => op.op))).toEqual(
      new Set([
        'memory-mkdir',
        'memory-append',
        'memory-commit',
        'memory-read',
        'memory-readdir',
        'memory-rename',
        'memory-utimes',
        'memory-rm'
      ])
    )
    expect(withoutTempNames(cpOps)).toEqual(withoutTempNames(shimOps))
  })
})

/** Every op the port sends, once, with nothing in a payload that depends on the disk it lands on. */
async function script(fs: MemoryFs): Promise<void> {
  await fs.mkdir('memory')
  await fs.writeFile('memory/a.md', 'alpha')
  await fs.writeFile('memory/big.md', 'é'.repeat(300_000))
  await fs.readFile('memory/big.md')
  await fs.readFile('memory/absent.md')
  await fs.readdir('memory')
  await fs.rename('memory/a.md', 'memory/b.md')
  await fs.utimes('memory/b.md', '2026-01-01T00:00:00.000Z')
  await fs.subdir('channels').writeFile('c1/meta.md', 'meta')
  await fs.writeFile('memory/b.md', 'beta', { ifMatchMtime: '2000-01-01T00:00:00.000Z' }).catch((err: unknown) => {
    if (!(err instanceof MemoryConflictError)) throw err
  })
  await fs.rm('memory')
}

/** Staged writes are named by a random uuid per call; everything else in a payload is deterministic. */
function withoutTempNames(ops: MemoryFsPayload[]): unknown {
  return JSON.parse(
    JSON.stringify(ops).replace(/\.agentconnect-memory-[0-9a-f-]{36}\.tmp/g, '.agentconnect-memory-TMP.tmp')
  )
}
