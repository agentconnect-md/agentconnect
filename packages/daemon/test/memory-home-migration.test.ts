// The one-way memory home migration and the forced return (memory-evolution.md §3.2.1): a pending binding copies the
// `daemon` tree into the CP once and reports it; an interrupted copy runs again from the start and lands the same tree
// and the same rows; `CONFLICT` stops it; the pool copies whatever the bound volume holds; the return archives aside.
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WireError } from '@agentconnect.md/connection'
import {
  AGENT_MEMORY_STORE_V1_FEATURE,
  MemoryHistoryAppendReq,
  MemoryHomeMigratedReq,
  MemoryStoreReq,
  type AgentMemoryBinding,
  type AgentSpec,
  type MemoryFsPayload,
  type MemoryHistoryAppendOk,
  type MemoryHomeMigratedOk
} from '@agentconnect.md/protocol'
import { CpMemoryHistorySink } from '../src/cp/memory-history.js'
import { Daemon } from '../src/daemon.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import type { MemoryHomeAgent } from '../src/memory/home.js'
import {
  MemoryHomeMigrator,
  archiveMemoryTreeAside,
  memoryHomeReturnedToDaemon,
  type CpMemoryMigrationLink,
  type MemoryHomeMigratorDeps
} from '../src/memory/home-migration.js'
import {
  MEMORY_HISTORY_FILENAME,
  SidecarMemoryHistorySink,
  channelMemoryRoot,
  ensureMemory,
  writeChannelMemoryMeta,
  writeMemoryFile,
  type MemoryHistoryRecord
} from '../src/memory/store.js'
import { applyMemoryFsPayload } from '../src/shim/memory-fs-channel.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { pathExecutor, pod } from './fixtures/memory-fs-pod.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CHANNEL = 'general-abc'
const STAMP = '2026-01-02T03:04:05.000Z'
/** Where the CP files each store's change log: the directory holding the store's files, which its `memory/history` read filters on. */
const AGENT_LOG_ROOT = 'memory'
const CHANNEL_LOG_ROOT = `channels/${CHANNEL}/memory`

const dirs: string[] = []
afterAll(() => {
  // Best-effort: on Windows a daemon root can still be held for a moment after `stop()`, and a leftover temp dir is no failure.
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* left for the OS to reclaim */
    }
  }
})

function newDir(prefix = 'ac-migrate-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

const pending = (): AgentMemoryBinding => ({ provider: 'managed', home: 'control-plane', homeMigration: 'pending' })

type Agent = MemoryHomeAgent & { memory: AgentMemoryBinding }
const agentWith = (memory: AgentMemoryBinding, dir: string): Agent => ({ id: AGENT, dir, memory })

type FakeCp = CpMemoryMigrationLink & {
  tree: string
  ops: MemoryFsPayload[]
  appends: MemoryHistoryAppendReq[]
  migrated: MemoryHomeMigratedReq[]
  /** The CP table: each id taken once (`skipDuplicates`), so a resent batch is the same rows. */
  rows: Map<string, { root: string; record: MemoryHistoryRecord }>
  up: boolean
  feature: boolean
  /** Every store op past this many fails as a dropped request. */
  failOpsAfter: number | undefined
  /** The 1-based append calls that fail as dropped requests. */
  failAppends: Set<number>
  answerMigrated: () => MemoryHomeMigratedOk
}

/** The CP connection as the migration sees it: a tree directory behind the store pair, a dedup table behind the log pair, a recorder behind the report. */
function fakeCp(): FakeCp {
  const tree = newDir('ac-migrate-tree-')
  const executor = pathExecutor()
  const dropped = () => new WireError('INTERNAL', 'no ack after 1 try', true)
  const link: FakeCp = {
    tree,
    ops: [],
    appends: [],
    migrated: [],
    rows: new Map(),
    up: true,
    feature: true,
    failOpsAfter: undefined,
    failAppends: new Set(),
    answerMigrated: () => ({ accepted: true }),
    connected: () => link.up,
    supportsServerFeature: (feature) => link.feature && feature === AGENT_MEMORY_STORE_V1_FEATURE,
    async memoryStore(req) {
      const parsed = MemoryStoreReq.parse(req)
      link.ops.push(parsed.op)
      if (link.failOpsAfter !== undefined && link.ops.length > link.failOpsAfter) throw dropped()
      return applyMemoryFsPayload({ ...parsed.op, root: join(tree, parsed.op.root) }, tree, executor)
    },
    async memoryHistoryAppend(req): Promise<MemoryHistoryAppendOk> {
      const parsed = MemoryHistoryAppendReq.parse(req)
      link.appends.push(parsed)
      if (link.failAppends.has(link.appends.length)) throw dropped()
      for (const record of parsed.records) {
        if (!link.rows.has(record.id!)) link.rows.set(record.id!, { root: parsed.root, record })
      }
      return { accepted: true }
    },
    async memoryHomeMigrated(req) {
      link.migrated.push(MemoryHomeMigratedReq.parse(req))
      return link.answerMigrated()
    }
  }
  return link
}

/** A `daemon` tree with everything the copy must carry and everything it must leave behind. */
async function seedSource(dir: string): Promise<void> {
  const fs = new LocalMemoryFs(dir)
  const sink = new SidecarMemoryHistorySink(fs)
  await ensureMemory(fs, 'bot-a')
  const body = '---\ndescription: how we ship\n---\n- region sea\n'
  await writeMemoryFile(fs, 'deploys.md', body, undefined, 'tool', sink)
  await writeMemoryFile(fs, 'deploys.md', `${body}- region ams\n`, undefined, 'console', sink)
  await fs.utimes('memory/deploys.md', STAMP)
  const channel = channelMemoryRoot(fs, CHANNEL)
  await writeChannelMemoryMeta(fs, CHANNEL, { channel: 'C1' })
  await writeMemoryFile(channel, 'notes.md', '- pinned\n', undefined, 'tool', new SidecarMemoryHistorySink(channel))
  // Stays behind: a staged dream, the pre-adoption backup, and the temp file of a crashed write.
  mkdirSync(join(dir, 'memory-dreams', 'drm-1', 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory-dreams', 'drm-1', 'memory', 'MEMORY.md'), '# draft\n')
  mkdirSync(join(dir, 'memory-backups', 'b1', 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory-backups', 'b1', 'memory', 'MEMORY.md'), '# before adoption\n')
  writeFileSync(join(dir, 'memory', '.agentconnect-memory-dead.tmp'), 'half a write')
}

/** Every file under `dir` by relative path, with its text. */
function snapshot(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(join(dir, rel))) return out
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(out, snapshot(dir, path))
    else out[path] = readFileSync(join(dir, path), 'utf8')
  }
  return out
}

/** What the copy carries out of a source snapshot: `memory/` and `channels/` only, minus the sidecars and temp files. */
function carried(source: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([path]) =>
        (path.startsWith('memory/') || path.startsWith('channels/')) &&
        !path.endsWith(`/${MEMORY_HISTORY_FILENAME}`) &&
        !path.endsWith('.tmp')
    )
  )
}

function sidecarIds(dir: string, ...store: string[]): string[] {
  return readFileSync(join(dir, ...store, 'memory', MEMORY_HISTORY_FILENAME), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as MemoryHistoryRecord).id!)
}

function rowsByRoot(cp: FakeCp): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [id, { root }] of cp.rows) (out[root] ??= []).push(id)
  return out
}

function migratorFor(agent: Agent, cp: FakeCp, over: Partial<MemoryHomeMigratorDeps> = {}) {
  const log = { info: vi.fn(), warn: vi.fn() }
  const migrated: string[] = []
  const delays: number[] = []
  const migrator = new MemoryHomeMigrator({
    agents: () => [agent],
    homes: () => ({ cp, log }),
    withMemoryHome: (_agentId, work) => work(),
    // The daemon's part: the marker is dropped from the local binding once the CP has accepted the report.
    onMigrated: async (agentId) => {
      migrated.push(agentId)
      agent.memory = { provider: 'managed', home: 'control-plane' }
    },
    log,
    retryBaseMs: 5,
    retryMaxMs: 20,
    // Timers are recorded, never fired: a test drives every re-run itself.
    setTimer: (_fn, ms) => {
      delays.push(ms)
      return setTimeout(() => {}, 0)
    },
    ...over
  })
  return { migrator, migrated, delays, log }
}

describe('the one-way copy', () => {
  it('copies the tree once — every file by path, both sidecars as rows — and reports completion exactly once', async () => {
    const dir = newDir()
    await seedSource(dir)
    const before = snapshot(dir)
    const cp = fakeCp()
    const agent = agentWith(pending(), dir)
    const { migrator, migrated, log } = migratorFor(agent, cp)
    migrator.reconcile()
    await vi.waitFor(() => expect(migrated).toEqual([AGENT]))
    expect(cp.migrated).toEqual([{ agentId: AGENT }])
    expect(agent.memory).toEqual({ provider: 'managed', home: 'control-plane' })
    // Verbatim, frontmatter and all; the mtime survives; nothing that stays behind, and no sidecar as a file.
    expect(snapshot(cp.tree)).toEqual(carried(before))
    expect(snapshot(cp.tree)['memory/deploys.md']).toMatch(/^---\ndescription: how we ship\n/)
    expect((await fsp.stat(join(cp.tree, 'memory', 'deploys.md'))).mtime.toISOString()).toBe(STAMP)
    // The change log: filed where the sink files a live write's — the directory holding each store's files, which is the
    // root the CP's page reads — with the ids the daemon minted.
    const quiet = { warn: () => {} }
    expect(AGENT_LOG_ROOT).toBe(new CpMemoryHistorySink(cp, AGENT, '.', quiet).root)
    expect(CHANNEL_LOG_ROOT).toBe(new CpMemoryHistorySink(cp, AGENT, `channels/${CHANNEL}`, quiet).root)
    expect(rowsByRoot(cp)).toEqual({
      [AGENT_LOG_ROOT]: sidecarIds(dir),
      [CHANNEL_LOG_ROOT]: sidecarIds(dir, 'channels', CHANNEL)
    })
    // The source is frozen: byte for byte what it was.
    expect(snapshot(dir)).toEqual(before)
    const records = sidecarIds(dir).length + sidecarIds(dir, 'channels', CHANNEL).length
    expect(log.info.mock.calls.map(([line]) => line)).toEqual([
      expect.stringContaining('copying its memory tree'),
      expect.stringMatching(
        new RegExp(
          `migrated to the Control Plane \\(4 file\\(s\\), \\d+ byte\\(s\\), ${records} change-log record\\(s\\)\\)`
        )
      )
    ])
    expect(log.warn).not.toHaveBeenCalled()
    // Nothing is pending any more, so another pass starts nothing.
    const ops = cp.ops.length
    migrator.reconcile()
    await settle()
    expect(cp.ops).toHaveLength(ops)
    expect(cp.migrated).toHaveLength(1)
    await migrator.stop()
  })

  it('an interrupted copy leaves the marker in place; the re-run yields the identical tree and no duplicate history ids', async () => {
    const dir = newDir()
    await seedSource(dir)
    const cp = fakeCp()
    const agent = agentWith(pending(), dir)
    const { migrator, migrated, delays, log } = migratorFor(agent, cp)
    // The link drops out a few file ops in: one file landed, the rest and the change log did not.
    cp.failOpsAfter = 4
    migrator.reconcile()
    await vi.waitFor(() => expect(delays).toEqual([5]))
    expect(cp.migrated).toEqual([])
    expect(migrated).toEqual([])
    expect(agent.memory).toMatchObject({ homeMigration: 'pending' })
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('retrying in'))
    expect(Object.keys(snapshot(cp.tree))).toHaveLength(1)

    // READY again: the whole copy runs from the start; this time the channel's change-log batch is the one dropped.
    cp.failOpsAfter = undefined
    cp.failAppends.add(cp.appends.length + 2)
    migrator.wake()
    await vi.waitFor(() => expect(delays).toEqual([5, 5]))
    expect(cp.migrated).toEqual([])
    expect(rowsByRoot(cp)).toEqual({ [AGENT_LOG_ROOT]: sidecarIds(dir) })

    // Third time: everything lands. Overwriting by path gave the same tree, and the resent agent batch the same rows.
    migrator.wake()
    await vi.waitFor(() => expect(migrated).toEqual([AGENT]))
    expect(cp.migrated).toHaveLength(1)
    expect(snapshot(cp.tree)).toEqual(carried(snapshot(dir)))
    const expectedIds = [...sidecarIds(dir), ...sidecarIds(dir, 'channels', CHANNEL)]
    expect(rowsByRoot(cp)).toEqual({
      [AGENT_LOG_ROOT]: sidecarIds(dir),
      [CHANNEL_LOG_ROOT]: sidecarIds(dir, 'channels', CHANNEL)
    })
    // Every id the CP ever saw is one the sidecars hold: the ids are the daemon's, so its dedup keeps exactly those rows.
    const sent = cp.appends.flatMap((batch) => batch.records.map((record) => record.id))
    expect(sent.length).toBeGreaterThan(expectedIds.length)
    expect(new Set(sent)).toEqual(new Set(expectedIds))
    await migrator.stop()
  })

  it('CONFLICT stops the migration without touching the source, and the same binding never starts another copy', async () => {
    const dir = newDir()
    await seedSource(dir)
    const before = snapshot(dir)
    const cp = fakeCp()
    cp.answerMigrated = () => {
      throw new WireError('CONFLICT', 'the agent memory home is no longer the Control Plane', false)
    }
    const agent = agentWith(pending(), dir)
    const { migrator, migrated, delays, log } = migratorFor(agent, cp)
    migrator.reconcile()
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no longer expects the copy')))
    expect(cp.migrated).toHaveLength(1)
    expect(migrated).toEqual([])
    expect(delays).toEqual([])
    expect(agent.memory).toMatchObject({ homeMigration: 'pending' })
    expect(snapshot(dir)).toEqual(before)
    // Neither a roster pass nor a READY connection re-runs it; the CP's push of the changed binding is what moves on.
    const ops = cp.ops.length
    migrator.reconcile()
    migrator.wake()
    await settle()
    expect(cp.ops).toHaveLength(ops)
    expect(cp.migrated).toHaveLength(1)
    await migrator.stop()
  })

  it('leaves the marker in place and retries when the CP is unreachable or refuses this member', async () => {
    const dir = newDir()
    await seedSource(dir)
    const cp = fakeCp()
    cp.up = false
    const agent = agentWith(pending(), dir)
    const { migrator, migrated, delays, log } = migratorFor(agent, cp)
    migrator.reconcile()
    await vi.waitFor(() => expect(delays).toEqual([5]))
    expect(cp.ops).toEqual([])
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('connection is not ready'))

    cp.up = true
    cp.answerMigrated = () => {
      throw new WireError('SCOPE_DENIED', 'agent is not served by this daemon', false)
    }
    migrator.wake()
    await vi.waitFor(() => expect(delays).toEqual([5, 5]))
    expect(cp.migrated).toHaveLength(1)
    expect(migrated).toEqual([])
    expect(agent.memory).toMatchObject({ homeMigration: 'pending' })
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('SCOPE_DENIED'))
    // Backoff doubles per attempt from the same failure, and a READY connection resets it.
    cp.failOpsAfter = 0
    migrator.wake()
    await vi.waitFor(() => expect(delays).toEqual([5, 5, 5]))
    await migrator.stop()
  })

  it('on a pool member the source is the bound pod volume: the copy binds it, an empty volume is an empty source, and completion is reported', async () => {
    const cp = fakeCp()
    const { fs } = pod()
    let bound = false
    const sandbox = { memoryFsFor: vi.fn(() => (bound ? fs : undefined)) }
    const agent = agentWith(pending(), newDir())
    const binds: string[] = []
    const { migrator, migrated, log } = migratorFor(agent, cp, {
      homes: () => ({ cp, sandbox, log: { warn: () => {} } }),
      withMemoryHome: async (agentId, work) => {
        binds.push(agentId)
        bound = true
        try {
          return await work()
        } finally {
          bound = false
        }
      }
    })
    migrator.reconcile()
    await vi.waitFor(() => expect(migrated).toEqual([AGENT]))
    expect(binds).toEqual([AGENT])
    expect(sandbox.memoryFsFor).toHaveBeenCalledWith(AGENT)
    expect(cp.migrated).toEqual([{ agentId: AGENT }])
    // Nothing to write and nothing to log: the volume held no tree, which is a legitimate empty source.
    expect(cp.ops).toEqual([])
    expect(cp.appends).toEqual([])
    expect(log.info).toHaveBeenLastCalledWith(expect.stringContaining('(0 file(s), 0 byte(s), 0 change-log record(s))'))
    // Nothing was created on this member's disk either.
    expect(readdirSync(agent.dir)).toEqual([])
    await migrator.stop()
  })
})

describe('the forced return keeps nothing', () => {
  it('is control-plane → daemon on a managed binding, and nothing else', () => {
    const managed = (home: 'daemon' | 'control-plane'): AgentMemoryBinding => ({ provider: 'managed', home })
    const at = (memory?: AgentMemoryBinding) => (memory ? { memory } : {})
    expect(memoryHomeReturnedToDaemon(at(managed('control-plane')), at(managed('daemon')))).toBe(true)
    expect(memoryHomeReturnedToDaemon(at(pending()), at(managed('daemon')))).toBe(true)
    expect(memoryHomeReturnedToDaemon(at(managed('control-plane')), at(managed('control-plane')))).toBe(false)
    expect(memoryHomeReturnedToDaemon(at(managed('daemon')), at(managed('daemon')))).toBe(false)
    expect(memoryHomeReturnedToDaemon(at(managed('daemon')), at(managed('control-plane')))).toBe(false)
    expect(memoryHomeReturnedToDaemon(at(managed('control-plane')), at({ provider: 'none' }))).toBe(false)
    expect(memoryHomeReturnedToDaemon(at(), at(managed('daemon')))).toBe(false)
  })

  it('moves memory/, channels/ and memory-backups/ under a dated archive beside them, and leaves memory-dreams/ where it is', async () => {
    const dir = newDir()
    await seedSource(dir)
    const before = snapshot(dir)
    const archive = await archiveMemoryTreeAside(dir, new Date('2026-09-09T10:11:12.345Z'))
    expect(archive).toBe(join(dir, 'memory-archive-2026-09-09T10-11-12-345Z'))
    expect(readdirSync(dir).sort()).toEqual(['memory-archive-2026-09-09T10-11-12-345Z', 'memory-dreams'])
    // The archive is the tree as it was, sidecars and temp file included; staging is untouched.
    const staged = Object.entries(before).filter(([path]) => path.startsWith('memory-dreams/'))
    expect(snapshot(archive!)).toEqual(
      Object.fromEntries(Object.entries(before).filter(([path]) => !path.startsWith('memory-dreams/')))
    )
    expect(snapshot(dir, 'memory-dreams')).toEqual(Object.fromEntries(staged))
    // Nothing left to move means no second archive.
    expect(await archiveMemoryTreeAside(dir, new Date('2026-09-09T10:11:13.000Z'))).toBeUndefined()
    expect(readdirSync(dir).sort()).toEqual(['memory-archive-2026-09-09T10-11-12-345Z', 'memory-dreams'])
  })
})

describe('the daemon runs it', () => {
  function daemonRoot(): string {
    const root = newDir('ac-migrate-daemon-')
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: [] } }
      })
    )
    const agentDir = join(root, 'agents', AGENT)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: AGENT,
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'ws') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    return root
  }

  const inertHost = (agent: { id: string }) =>
    ({
      id: agent.id,
      start: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    }) as never

  // On Windows this also proves the agent-config watcher holds no handle beneath the memory tree, or the move would half-fail.
  it('starts the copy when a pending binding arrives, serves the CP tree once accepted, and archives the tree on the forced return', async () => {
    const root = daemonRoot()
    const agentDir = join(root, 'agents', AGENT)
    await seedSource(agentDir)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: inertHost })
    await daemon.start()
    const cp = fakeCp()
    const seam = daemon as unknown as {
      cpClient: unknown
      cpConfigApply(): { applyAgentUpsert(upsert: { agentId: string; spec: AgentSpec }): Promise<unknown> }
      agents: Map<string, { memory?: AgentMemoryBinding }>
      memory: {
        write(
          scope: { agentId: string },
          path: string,
          content: string,
          ifMatch?: string,
          source?: 'tool'
        ): Promise<unknown>
      }
    }
    // The connection as the homes see it, plus the lifecycle calls the daemon makes on it at shutdown.
    seam.cpClient = Object.assign(cp, { stop: async () => {}, emitMemoryConnectionFacts: () => {} })

    // The CP's push: the binding flipped, and it carries the marker. The trigger is applying it.
    const upsert = (memory: AgentMemoryBinding) =>
      seam.cpConfigApply().applyAgentUpsert({ agentId: AGENT, spec: { name: 'bot-a', memory } as AgentSpec })
    await upsert(pending())
    await vi.waitFor(() => expect(cp.migrated).toEqual([{ agentId: AGENT }]))
    expect(snapshot(cp.tree)).toEqual(carried(snapshot(agentDir)))
    // Accepted: the marker is dropped locally, ahead of the CP's next push, so the CP tree is what gets served.
    await vi.waitFor(() =>
      expect(seam.agents.get(AGENT)?.memory).toEqual({ provider: 'managed', home: 'control-plane' })
    )
    await seam.memory.write({ agentId: AGENT }, 'after.md', '- lives in the Control Plane\n', undefined, 'tool')
    expect(readFileSync(join(cp.tree, 'memory', 'after.md'), 'utf8')).toContain('lives in the Control Plane')
    expect(existsSync(join(agentDir, 'memory', 'after.md'))).toBe(false)

    // The forced return: the CP dropped its rows; the pre-switch tree on this disk moves aside, nothing is resurrected.
    await upsert({ provider: 'managed', home: 'daemon' })
    expect(existsSync(join(agentDir, 'memory'))).toBe(false)
    expect(existsSync(join(agentDir, 'channels'))).toBe(false)
    expect(existsSync(join(agentDir, 'memory-backups'))).toBe(false)
    const archives = readdirSync(agentDir).filter((name) => name.startsWith('memory-archive-'))
    expect(archives).toHaveLength(1)
    expect(existsSync(join(agentDir, archives[0]!, 'memory', 'deploys.md'))).toBe(true)
    expect(existsSync(join(agentDir, 'memory-dreams', 'drm-1', 'memory', 'MEMORY.md'))).toBe(true)
    await daemon.stop()
  })
})

describe('the daemon remembers the last home it applied', () => {
  type Seam = {
    cpConfigApply(): {
      applyAgentUpsert(upsert: { agentId: string; spec: AgentSpec }): Promise<unknown>
      applyAgentRemove(agentId: string): Promise<void>
    }
    store: { getMemoryHomeApplied(agentId: string): Promise<string | undefined> }
  }

  const bootRoot = (): string => {
    const root = newDir('ac-migrate-durable-')
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: [] } }
      })
    )
    const agentDir = join(root, 'agents', AGENT)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: AGENT,
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'ws') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    return root
  }

  const idleHost = (agent: { id: string }) =>
    ({
      id: agent.id,
      start: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    }) as never

  // A daemon over `root`, started, with the CP's push reduced to applying a binding for the one agent.
  async function boot(
    root: string
  ): Promise<{ daemon: Daemon; seam: Seam; upsert(memory: AgentMemoryBinding): Promise<unknown> }> {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: idleHost })
    await daemon.start()
    const seam = daemon as unknown as Seam
    const upsert = (memory: AgentMemoryBinding) =>
      seam.cpConfigApply().applyAgentUpsert({ agentId: AGENT, spec: { name: 'bot-a', memory } as AgentSpec })
    return { daemon, seam, upsert }
  }

  const cpHome = (): AgentMemoryBinding => ({ provider: 'managed', home: 'control-plane' })
  const daemonHome = (): AgentMemoryBinding => ({ provider: 'managed', home: 'daemon' })

  function archives(agentDir: string): string[] {
    return readdirSync(agentDir).filter((name) => name.startsWith('memory-archive-'))
  }

  /** The three trees the forced return would move, by relative path. */
  function trees(agentDir: string): Record<string, string> {
    return Object.fromEntries(
      Object.entries(snapshot(agentDir)).filter(([path]) => /^(memory|channels|memory-backups)\//.test(path))
    )
  }

  function expectArchived(agentDir: string): void {
    expect(existsSync(join(agentDir, 'memory'))).toBe(false)
    expect(existsSync(join(agentDir, 'channels'))).toBe(false)
    expect(existsSync(join(agentDir, 'memory-backups'))).toBe(false)
    const [archive, ...rest] = archives(agentDir)
    expect(rest).toEqual([])
    expect(existsSync(join(agentDir, archive!, 'memory', 'deploys.md'))).toBe(true)
    expect(existsSync(join(agentDir, archive!, 'channels', CHANNEL, 'memory', 'notes.md'))).toBe(true)
    expect(existsSync(join(agentDir, archive!, 'memory-backups', 'b1', 'memory', 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(agentDir, 'memory-dreams', 'drm-1', 'memory', 'MEMORY.md'))).toBe(true)
  }

  // The watcher leaves the memory tree alone now (#1893), so the archive runs on Windows as well.
  const onPosix = it

  onPosix('online, the return is still detected against the binding this process holds', async () => {
    const root = bootRoot()
    const agentDir = join(root, 'agents', AGENT)
    await seedSource(agentDir)
    const { daemon, seam, upsert } = await boot(root)
    await upsert(cpHome())
    expect(await seam.store.getMemoryHomeApplied(AGENT)).toBe('control-plane')
    await upsert(daemonHome())
    expectArchived(agentDir)
    expect(await seam.store.getMemoryHomeApplied(AGENT)).toBe('daemon')
    await daemon.stop()
  })

  onPosix(
    'offline, the return arrives on the first roster after a restart and the pre-switch tree is archived',
    async () => {
      const root = bootRoot()
      const agentDir = join(root, 'agents', AGENT)
      await seedSource(agentDir)
      const first = await boot(root)
      await first.upsert(cpHome())
      await first.daemon.stop()

      // The forced return happened while this daemon was down: the restarted process has never seen `control-plane`.
      const second = await boot(root)
      await second.upsert(daemonHome())
      expectArchived(agentDir)
      expect(await second.seam.store.getMemoryHomeApplied(AGENT)).toBe('daemon')
      await second.daemon.stop()
    }
  )

  it('daemon after daemon across a restart archives nothing', async () => {
    const root = bootRoot()
    const agentDir = join(root, 'agents', AGENT)
    await seedSource(agentDir)
    const before = trees(agentDir)
    const first = await boot(root)
    await first.upsert(daemonHome())
    await first.daemon.stop()

    const second = await boot(root)
    await second.upsert(daemonHome())
    expect(archives(agentDir)).toEqual([])
    expect(trees(agentDir)).toEqual(before)
    await second.daemon.stop()
  })

  it('drops the record when the agent is removed from this daemon', async () => {
    const root = bootRoot()
    const { daemon, seam, upsert } = await boot(root)
    await upsert(cpHome())
    expect(await seam.store.getMemoryHomeApplied(AGENT)).toBe('control-plane')
    await seam.cpConfigApply().applyAgentRemove(AGENT)
    expect(await seam.store.getMemoryHomeApplied(AGENT)).toBeUndefined()
    await daemon.stop()
  })
})
