import { afterAll, describe, expect, it, vi } from 'vitest'
import { promises as fsp, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import {
  LocalMemoryFs,
  MemoryConflictError,
  MemoryPathError,
  MemorySandboxUnavailableError,
  resolveMemoryFs,
  type MemoryFs
} from '../src/memory/fs.js'
import {
  MEMORY_HISTORY_FILENAME,
  MEMORY_INDEX,
  ensureMemory,
  listMemory,
  listMemoryHistory,
  readMemoryFile,
  writeMemoryFile
} from '../src/memory/store.js'
import { ManagedMemoryProvider } from '../src/memory/provider.js'
import { createMemoryReader } from '../src/cp/memory-reader.js'
import { MemoryFsPayloadSchema, ShimMemoryFs } from '../src/shim/memory-fs-channel.js'
import { createFdMemoryFsExecutor } from '../src/shim/fd-memory-fs.js'
import { createExecHandler } from '../src/shim/exec-handler.js'
import { REPLY_BUDGET } from '../src/wire-slice.js'
import { pod, shimRequester } from './fixtures/memory-fs-pod.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix = 'ac-memfs-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

describe('LocalMemoryFs (the port over this disk)', () => {
  it('reads null for an absent file, writes atomically, lists with stats, and re-roots for a channel', async () => {
    const fs = new LocalMemoryFs(tempRoot())
    expect(await fs.readFile('memory/MEMORY.md')).toBeNull()
    const st = await fs.writeFile('memory/MEMORY.md', '# idx')
    expect(st.size).toBe(5)
    expect((await fs.readFile('memory/MEMORY.md'))?.content).toBe('# idx')
    expect(await fs.readdir('memory')).toEqual([{ name: 'MEMORY.md', kind: 'file', size: 5, mtime: st.mtime }])
    const channel = fs.subdir('channels/c-1')
    await channel.writeFile('memory/topic.md', 'x')
    expect((await fs.readFile('channels/c-1/memory/topic.md'))?.content).toBe('x')
    expect(await fs.readdir('nope')).toEqual([])
  })

  // O_NOFOLLOW has no Windows equivalent, so a symlink component is followed — tracked separately.
  it.skipIf(process.platform === 'win32')(
    'enforces the mtime precondition and rejects escapes, symlink components and symlink leaves',
    async () => {
      const root = tempRoot()
      const fs = new LocalMemoryFs(root)
      const st = await fs.writeFile('memory/a.md', 'v1')
      await expect(
        fs.writeFile('memory/a.md', 'v2', { ifMatchMtime: '2000-01-01T00:00:00.000Z' })
      ).rejects.toBeInstanceOf(MemoryConflictError)
      await fs.writeFile('memory/a.md', 'v2', { ifMatchMtime: st.mtime })
      await expect(fs.readFile('../etc/passwd')).rejects.toBeInstanceOf(MemoryPathError)
      await expect(fs.readFile('/etc/passwd')).rejects.toBeInstanceOf(MemoryPathError)
      const outside = tempRoot()
      writeFileSync(join(outside, 'secret'), 'no')
      symlinkSync(join(outside, 'secret'), join(root, 'memory', 'leak.md'))
      await expect(fs.readFile('memory/leak.md')).rejects.toBeInstanceOf(MemoryPathError)
      symlinkSync(outside, join(root, 'linked'))
      await expect(fs.readFile('linked/secret')).rejects.toBeInstanceOf(MemoryPathError)
      await expect(fs.writeFile('linked/x', 'y')).rejects.toBeInstanceOf(MemoryPathError)
    }
  )

  // A cancel-wins dream drops its staging while the review screen is listing it, and Windows resolves
  // the already-unlinked directory to a path OUTSIDE the root instead of failing with ENOENT. The
  // realpath stub stands in for that, with and without the rm, since only the still-present one escaped.
  it('reads a component dropped mid-walk as absent, and still refuses one that resolves outside the root', async () => {
    const root = tempRoot()
    const fs = new LocalMemoryFs(root)
    await fs.writeFile('staged/memory/MEMORY.md', '# idx')
    const staged = join(await fsp.realpath(root), 'staged')
    let dropOnResolve = false
    const realpath = fsp.realpath
    const spy = vi.spyOn(fsp, 'realpath').mockImplementation((async (path: string) => {
      if (path !== staged) return realpath(path)
      if (dropOnResolve) rmSync(staged, { recursive: true, force: true })
      return parse(staged).root
    }) as unknown as typeof fsp.realpath)
    try {
      await expect(fs.readdir('staged/memory')).rejects.toBeInstanceOf(MemoryPathError)
      dropOnResolve = true
      expect(await fs.readdir('staged/memory')).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('renames (false when absent), removes recursively, sets mtimes, and round-trips bytes as base64', async () => {
    const fs = new LocalMemoryFs(tempRoot())
    expect(await fs.rename('memory', 'backup')).toBe(false)
    await fs.writeFile('memory/a.md', 'v1')
    expect(await fs.rename('memory', 'backups/one')).toBe(true)
    expect((await fs.readFile('backups/one/a.md'))?.content).toBe('v1')
    await fs.utimes('backups/one/a.md', '2020-01-01T00:00:00.000Z')
    expect((await fs.readFile('backups/one/a.md'))?.mtime).toBe('2020-01-01T00:00:00.000Z')
    await fs.rm('backups')
    expect(await fs.readdir('backups')).toEqual([])
    const bytes = Buffer.from([0, 255, 1, 2, 3])
    await fs.writeFile('bin/blob', bytes)
    expect(Buffer.from((await fs.readFile('bin/blob', 'base64'))!.content, 'base64')).toEqual(bytes)
  })
})

describe('ShimMemoryFs over the read capability (the port over a sandbox volume)', () => {
  it('runs the managed memory tree unchanged on the pod root, one frame per primitive', async () => {
    const { root, fs, requester } = pod()
    await ensureMemory(fs, 'bot-a')
    expect(await fsp.readFile(join(root, 'memory', MEMORY_INDEX), 'utf8')).toContain('# bot-a memory')
    await writeMemoryFile(fs, 'deploys.md', '- region sea\n', undefined, 'tool')
    expect(await readMemoryFile(fs, 'deploys.md')).toBe('- region sea\n')
    expect((await listMemory(fs)).map((f) => f.name)).toEqual([MEMORY_INDEX, 'deploys.md'])
    const history = await listMemoryHistory(fs, 'deploys.md', undefined, 10)
    expect(history.events.map((e) => e.event)).toEqual(['add'])
    expect(await fsp.readFile(join(root, 'memory', MEMORY_HISTORY_FILENAME), 'utf8')).toContain('"source":"tool"')
    // Every touch crossed the channel as a memory-fs frame; nothing landed on this side's disk.
    expect(requester.frames.every((op) => op.startsWith('memory-'))).toBe(true)
    expect(requester.frames).toContain('memory-commit')
  })

  it('reads BYTES in frame-safe base64 chunks, decoded per chunk, and refuses over-cap from the first reply', async () => {
    const { root, fs, requester } = pod()
    // Binary, non-UTF-8, larger than one base64-safe chunk (~189 KB) — forces reassembly and
    // would corrupt under either of the two traps: a REPLY_BUDGET-sized request (4/3 expansion
    // over-frames the reply) or joining independently-padded base64 strings before decoding.
    const bytes = Buffer.alloc(400_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    mkdirSync(join(root, 'ws'), { recursive: true })
    writeFileSync(join(root, 'ws', 'chart.png'), bytes)

    const read = await fs.readFileBytes('ws/chart.png', 1_000_000)
    if (read === null || 'tooLarge' in read!) throw new Error('expected bytes')
    expect(read.bytes.equals(bytes)).toBe(true)
    expect(requester.frames.filter((op) => op === 'memory-read').length).toBeGreaterThan(1)

    // The cap refuses from the FIRST reply's size — one frame, no transfer.
    const before = requester.frames.length
    expect(await fs.readFileBytes('ws/chart.png', 100_000)).toEqual({ tooLarge: 400_000 })
    expect(requester.frames.length - before).toBe(1)

    expect(await fs.readFileBytes('ws/absent.png', 1_000_000)).toBeNull()
  })

  it('reassembles a file larger than one frame and stages an oversized write as chunks', async () => {
    const { fs, requester } = pod()
    const big = 'é'.repeat(300_000) // 600 KB, multi-byte, more than two reply budgets
    await fs.writeFile('memory/big.md', big)
    const appends = requester.frames.filter((op) => op === 'memory-append').length
    expect(appends).toBeGreaterThan(2)
    requester.frames.length = 0
    const read = await fs.readFile('memory/big.md')
    expect(read?.content).toBe(big)
    expect(read?.size).toBe(Buffer.byteLength(big))
    expect(requester.frames.filter((op) => op === 'memory-read').length).toBeGreaterThan(2)
    expect(REPLY_BUDGET).toBeLessThan(Buffer.byteLength(big))
  })

  it('carries the two typed refusals back as themselves and cleans a failed staging', async () => {
    const { root, fs } = pod()
    const st = await fs.writeFile('memory/a.md', 'v1')
    await expect(
      fs.writeFile('memory/a.md', 'v2', { ifMatchMtime: '2000-01-01T00:00:00.000Z' })
    ).rejects.toBeInstanceOf(MemoryConflictError)
    await fs.writeFile('memory/a.md', 'v2', { ifMatchMtime: st.mtime })
    expect(await fsp.readdir(join(root, 'memory'))).toEqual(['a.md'])
    await expect(fs.readFile('../outside')).rejects.toBeInstanceOf(MemoryPathError)
    expect(() =>
      MemoryFsPayloadSchema.parse({ op: 'memory-read', root: '/agent', rel: 'x', offset: 0, limit: 1e9 })
    ).toThrow()
  })

  it('serves the memory provider and the CP reader like a local root, and refuses as asleep when unbound', async () => {
    const { fs } = pod()
    let bound: MemoryFs | undefined = fs
    const rootFor = () => {
      if (!bound) throw new MemorySandboxUnavailableError('agent "bot-a" has no running sandbox')
      return bound
    }
    const provider = new ManagedMemoryProvider(rootFor)
    await provider.ensure({ agentId: 'bot-a' }, 'bot-a')
    await provider.write({ agentId: 'bot-a' }, 'notes.md', 'hello', undefined, 'console')
    expect((await provider.list({ agentId: 'bot-a' })).map((f) => f.name)).toEqual([MEMORY_INDEX, 'notes.md'])
    const reader = createMemoryReader(rootFor, { adminSurfaceForAgent: () => provider.adminSurface() })
    expect((await reader.read({ agentId: 'bot-a', path: 'notes.md', offset: 0, limit: 100 })).content).toBe('hello')

    bound = undefined
    await expect(provider.list({ agentId: 'bot-a' })).rejects.toBeInstanceOf(MemorySandboxUnavailableError)
    await expect(provider.standingContextAtSessionStart({ agentId: 'bot-a' })).rejects.toBeInstanceOf(
      MemorySandboxUnavailableError
    )
    await expect(reader.list({ agentId: 'bot-a' })).rejects.toBeInstanceOf(MemorySandboxUnavailableError)
    // The shape query is config, not files: a known agent whose sandbox sleeps still answers it.
    expect((await reader.surface({ agentId: 'bot-a' })).shape).toBe('files')
  })
})

describe('resolveMemoryFs (the one placement decision)', () => {
  it('gives a local agent the local port, a bound cluster agent the shim port, and refuses an unbound one', () => {
    const agent = { id: 'bot-a', dir: tempRoot() }
    const local = resolveMemoryFs(agent, undefined)
    expect(local).toBeInstanceOf(LocalMemoryFs)
    expect(local.root).toBe(agent.dir)
    const { fs } = pod()
    expect(resolveMemoryFs(agent, { memoryFsFor: () => fs })).toBe(fs)
    expect(() => resolveMemoryFs(agent, { memoryFsFor: () => undefined })).toThrow(MemorySandboxUnavailableError)
  })
})

describe.skipIf(process.platform !== 'linux')('the descriptor-bound executor (pod side)', () => {
  it('serves the primitives from the anchor and refuses a root outside the mount', async () => {
    const mount = tempRoot('ac-pod-fd-')
    const root = join(mount, '.agentconnect', 'memory')
    const requester = shimRequester(mount, createFdMemoryFsExecutor(mount))
    const fs = new ShimMemoryFs(requester, root)
    await ensureMemory(fs, 'bot-a')
    const st = await writeMemoryFile(fs, 'deploys.md', 'é'.repeat(120_000), undefined, 'tool')
    expect(await readMemoryFile(fs, 'deploys.md')).toBe('é'.repeat(120_000))
    await fs.writeFile('memory/big.md', 'é'.repeat(300_000))
    expect((await fs.readFile('memory/big.md'))?.content).toBe('é'.repeat(300_000))
    await expect(
      fs.writeFile('memory/deploys.md', 'x', { ifMatchMtime: '2000-01-01T00:00:00.000Z' })
    ).rejects.toBeInstanceOf(MemoryConflictError)
    await fs.writeFile('memory/deploys.md', 'x', { ifMatchMtime: st.mtime })
    expect(await fs.rename('memory', 'memory-backups/one')).toBe(true)
    expect((await fs.readdir('memory-backups/one')).map((e) => e.name).sort()).toEqual([
      '.history',
      'MEMORY.md',
      'big.md',
      'deploys.md'
    ])
    await fs.rm('memory-backups')
    expect(await fs.readdir('memory-backups')).toEqual([])
    // A symlinked component is refused, not followed.
    const outside = tempRoot()
    mkdirSync(join(root, 'memory'), { recursive: true })
    symlinkSync(outside, join(root, 'memory', 'link'))
    await expect(fs.readFile('memory/link/x')).rejects.toBeInstanceOf(MemoryPathError)
    const elsewhere = new ShimMemoryFs(requester, '/etc')
    await expect(elsewhere.readdir('')).rejects.toBeInstanceOf(MemoryPathError)
    // The exec handler routes memory-fs frames on the `read` capability beside the workspace ones.
    const handled = await createExecHandler({ workspaceRoot: mount })('read', {
      op: 'memory-readdir',
      root,
      rel: 'memory'
    })
    expect(handled).toEqual({ ok: true, value: [{ name: 'link', kind: 'other' }] })
  })
})
