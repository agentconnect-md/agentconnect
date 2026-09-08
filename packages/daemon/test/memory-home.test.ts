// The memory home selection (memory-evolution.md §3.2.1): a `daemon` home is unchanged on every placement, a
// `control-plane` home puts the store and its change log on the CP connection behind three activation gates, every
// writer and reader goes through the ports, and the console reads a CP-homed tree without asking for the pod.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, promises as fsp, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_MEMORY_STORE_V1_FEATURE,
  MemoryHistoryAppendReq,
  MemoryStoreReq,
  type AgentMemoryBinding,
  type MemoryFsPayload,
  type MemoryHistoryAppendOk
} from '@agentconnect.md/protocol'
import { CpMemoryFs } from '../src/cp/memory-fs.js'
import { CpMemoryHistorySink } from '../src/cp/memory-history.js'
import { createMemoryReader } from '../src/cp/memory-reader.js'
import {
  LocalMemoryFs,
  MemoryHomeUnavailableError,
  MemorySandboxUnavailableError,
  type MemoryFs
} from '../src/memory/fs.js'
import {
  memoryHomeUnavailable,
  resolveMemoryHomePorts,
  type CpMemoryHomeLink,
  type MemoryHomeAgent
} from '../src/memory/home.js'
import { managedDistillCapture, withManagedDistill } from '../src/memory/managed-distill-outbox.js'
import { ManagedMemoryProvider } from '../src/memory/provider.js'
import {
  MEMORY_HISTORY_FILENAME,
  MEMORY_INDEX,
  MemoryHistoryNotLocalError,
  SidecarMemoryHistorySink,
  channelMemoryRoot,
  listMemoryHistory
} from '../src/memory/store.js'
import type { MemoryPluginMetrics } from '../src/memory-plugin/metrics.js'
import { MemoryCaptureOutbox, type MemoryCapturePumpRegistry } from '../src/memory-plugin/outbox.js'
import { applyMemoryFsPayload } from '../src/shim/memory-fs-channel.js'
import { LocalStore } from '../src/store/local-store.js'
import { pathExecutor, pod } from './fixtures/memory-fs-pod.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const log = { warn: vi.fn() }

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newDir(prefix = 'ac-home-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const managed = (home: 'daemon' | 'control-plane'): AgentMemoryBinding => ({ provider: 'managed', home })
/** Step ④ stamps the migration marker on the binding; until the protocol carries it, the daemon reads it as an extra field. */
const migrating = (): AgentMemoryBinding =>
  ({ ...managed('control-plane'), homeMigration: 'pending' }) as unknown as AgentMemoryBinding

const agentWith = (memory: AgentMemoryBinding | undefined, dir = newDir()): MemoryHomeAgent => ({
  id: AGENT,
  dir,
  ...(memory ? { memory } : {})
})

type FakeCp = CpMemoryHomeLink & {
  tree: string
  ops: MemoryFsPayload[]
  appends: MemoryHistoryAppendReq[]
  up: boolean
  feature: boolean
}

/** The CP connection as the home sees it: a tree directory behind the store pair, a recorder behind the change-log pair. */
function fakeCp(): FakeCp {
  const tree = newDir('ac-home-tree-')
  const executor = pathExecutor()
  const link: FakeCp = {
    tree,
    ops: [],
    appends: [],
    up: true,
    feature: true,
    connected: () => link.up,
    supportsServerFeature: (feature) => link.feature && feature === AGENT_MEMORY_STORE_V1_FEATURE,
    async memoryStore(req) {
      const parsed = MemoryStoreReq.parse(req)
      link.ops.push(parsed.op)
      return applyMemoryFsPayload({ ...parsed.op, root: join(tree, parsed.op.root) }, tree, executor)
    },
    async memoryHistoryAppend(req): Promise<MemoryHistoryAppendOk> {
      link.appends.push(MemoryHistoryAppendReq.parse(req))
      return { accepted: true }
    }
  }
  return link
}

const reasonOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (err) {
    return err instanceof MemoryHomeUnavailableError ? err.reason : `not a home refusal: ${String(err)}`
  }
}

describe('resolveMemoryHomePorts — the one selection', () => {
  it('leaves a daemon home as it was: the local tree here, the sandbox volume on a pool member, refused while unbound', () => {
    const cp = fakeCp()
    cp.up = false
    for (const memory of [managed('daemon'), { provider: 'none' } as AgentMemoryBinding, undefined]) {
      // A `daemon` home never consults the CP connection, down or not.
      const agent = agentWith(memory)
      const ports = resolveMemoryHomePorts(agent, { cp, log })
      expect(ports.live).toBeInstanceOf(LocalMemoryFs)
      expect(ports.live.root).toBe(agent.dir)
      expect(ports.staging).toBe(ports.live)
      expect(ports.historyFor(ports.live)).toBeInstanceOf(SidecarMemoryHistorySink)
      expect(memoryHomeUnavailable(agent, { cp, log })).toBeUndefined()
    }

    const { fs } = pod()
    const agent = agentWith(managed('daemon'))
    const bound = resolveMemoryHomePorts(agent, { sandbox: { memoryFsFor: () => fs }, cp, log })
    expect(bound.live).toBe(fs)
    expect(bound.staging).toBe(fs)
    expect(bound.historyFor(fs)).toBeInstanceOf(SidecarMemoryHistorySink)
    const asleep = { sandbox: { memoryFsFor: () => undefined }, cp, log }
    expect(() => resolveMemoryHomePorts(agent, asleep)).toThrow(MemorySandboxUnavailableError)
    expect(memoryHomeUnavailable(agent, asleep)?.reason).toBe('sandbox-unavailable')
  })

  it('puts a control-plane home on the CP connection and leaves staging beside the extraction host', () => {
    const cp = fakeCp()
    const agent = agentWith(managed('control-plane'))
    const ports = resolveMemoryHomePorts(agent, { cp, log })
    expect(ports.live).toBeInstanceOf(CpMemoryFs)
    expect(ports.live.key).toBe(`control-plane:${AGENT}:.`)
    // Self-hosted: the dream host runs on this disk, so its staging root is the agent dir.
    expect(ports.staging).toBeInstanceOf(LocalMemoryFs)
    expect(ports.staging.root).toBe(agent.dir)
    const sink = ports.historyFor(ports.live)
    expect(sink).toBeInstanceOf(CpMemoryHistorySink)
    expect((sink as CpMemoryHistorySink).root).toBe('memory')
    expect(sink.list).toBeUndefined()
    // A channel store under `live` files its log under its own memory/ dir; a staged store, never in the CP, keeps its sidecar.
    expect((ports.historyFor(channelMemoryRoot(ports.live, 'c1')) as CpMemoryHistorySink).root).toBe(
      'channels/c1/memory'
    )
    expect(ports.historyFor(ports.staging)).toBeInstanceOf(SidecarMemoryHistorySink)
    expect(memoryHomeUnavailable(agent, { cp, log })).toBeUndefined()

    // A pool member: the store resolves without the pod; staging is the pod's volume, looked up on use.
    const sandbox = { memoryFsFor: vi.fn((): MemoryFs | undefined => undefined) }
    const onPool = resolveMemoryHomePorts(agent, { sandbox, cp, log })
    expect(onPool.live).toBeInstanceOf(CpMemoryFs)
    expect(sandbox.memoryFsFor).not.toHaveBeenCalled()
    expect(() => onPool.staging).toThrow(MemorySandboxUnavailableError)
    expect(sandbox.memoryFsFor).toHaveBeenCalledWith(AGENT)
    const { fs } = pod()
    sandbox.memoryFsFor.mockReturnValue(fs)
    expect(onPool.staging).toBe(fs)
    expect(memoryHomeUnavailable(agent, { sandbox, cp, log })).toBeUndefined()
  })

  it('refuses a control-plane activation with its reason — no connection, no feature, a pending copy — and never this disk', () => {
    const agent = agentWith(managed('control-plane'))
    const gates: [string, () => Parameters<typeof resolveMemoryHomePorts>[1]][] = [
      ['connection', () => ({ log })],
      [
        'connection',
        () => {
          const cp = fakeCp()
          cp.up = false
          return { cp, log }
        }
      ],
      [
        'feature',
        () => {
          const cp = fakeCp()
          cp.feature = false
          return { cp, log }
        }
      ]
    ]
    for (const [reason, deps] of gates) {
      expect(reasonOf(() => resolveMemoryHomePorts(agent, deps()))).toBe(reason)
      expect(memoryHomeUnavailable(agent, deps())?.reason).toBe(reason)
    }
    // The copy step ④ starts and step ⑧ finishes: the binding says so, and the tree is served to nobody meanwhile.
    const pending = agentWith(migrating(), agent.dir)
    const cp = fakeCp()
    expect(reasonOf(() => resolveMemoryHomePorts(pending, { cp, log }))).toBe('migrating')
    expect(memoryHomeUnavailable(pending, { cp, log })?.message).toContain('still receiving the copy')
    cp.up = false
    expect(memoryHomeUnavailable(pending, { cp, log })?.reason).toBe('migrating')
    // One resolution: nothing was created on this member's disk, and no op reached the CP.
    expect(existsSync(join(agent.dir, 'memory'))).toBe(false)
    expect(cp.ops).toEqual([])
  })
})

describe('every writer and reader goes through the ports', () => {
  it('routes a topic write under a control-plane home to the CP tree and its change log to the CP sink, with no sidecar anywhere', async () => {
    const cp = fakeCp()
    const agent = agentWith(managed('control-plane'))
    const deps = { cp, log }
    const provider = new ManagedMemoryProvider(() => resolveMemoryHomePorts(agent, deps))
    await provider.ensure({ agentId: AGENT }, 'bot-a')
    await provider.write(
      { agentId: AGENT },
      'deploys.md',
      '---\ndescription: how we ship\n---\n- region sea\n',
      undefined,
      'tool'
    )
    expect(await fsp.readFile(join(cp.tree, 'memory', 'deploys.md'), 'utf8')).toContain('- region sea')
    expect((await provider.read({ agentId: AGENT }, 'deploys.md')).content).toContain('- region sea')
    expect(cp.ops.some((op) => op.op === 'memory-commit')).toBe(true)
    // The topic record, then the regenerated index's — both to the CP, filed under the store's memory/ dir, the root the CP's read filters on.
    expect(cp.appends.flatMap((req) => req.records.map((r) => [req.root, r.path, r.event, r.source]))).toEqual([
      ['memory', 'deploys.md', 'add', 'tool'],
      ['memory', MEMORY_INDEX, 'update', 'tool']
    ])
    expect(await fsp.readdir(join(cp.tree, 'memory'))).not.toContain(MEMORY_HISTORY_FILENAME)
    expect(existsSync(join(agent.dir, 'memory'))).toBe(false)

    // A channel store: the same tree, its own root on every record.
    await provider.write({ agentId: AGENT, channelKey: 'general-abc' }, 'notes.md', '- pinned\n', undefined, 'console')
    expect(await fsp.readFile(join(cp.tree, 'channels', 'general-abc', 'memory', 'notes.md'), 'utf8')).toContain(
      'pinned'
    )
    expect(cp.appends.at(-1)).toMatchObject({ agentId: AGENT, root: 'channels/general-abc/memory' })
    expect(cp.appends.at(-1)!.records.map((r) => [r.path, r.source])).toEqual([['notes.md', 'console']])
    expect(await fsp.readdir(join(cp.tree, 'channels', 'general-abc', 'memory'))).not.toContain(MEMORY_HISTORY_FILENAME)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs a staged store bound explicitly to the sidecar inside it, whatever the home', async () => {
    const cp = fakeCp()
    const agent = agentWith(managed('control-plane'))
    const provider = new ManagedMemoryProvider(() => resolveMemoryHomePorts(agent, { cp, log }))
    const staged = new LocalMemoryFs(join(agent.dir, 'memory-dreams', 'drm-1', 'store'))
    await provider.write({ agentId: AGENT, root: staged }, 'prefs.md', '- tabs\n', undefined, 'dream')
    expect(existsSync(join(staged.root, 'memory', MEMORY_HISTORY_FILENAME))).toBe(true)
    expect(cp.appends).toEqual([])
    expect(cp.ops).toEqual([])
  })

  it('refuses a daemon-side page of a control-plane change log as a routing bug, never an empty page', async () => {
    const cp = fakeCp()
    const agent = agentWith(managed('control-plane'))
    const provider = new ManagedMemoryProvider(() => resolveMemoryHomePorts(agent, { cp, log }))
    await expect(
      listMemoryHistory(new CpMemoryHistorySink(cp, AGENT, '.', log), 'notes.md', undefined, 5)
    ).rejects.toBeInstanceOf(MemoryHistoryNotLocalError)
    await expect(
      provider.adminSurface().history!({ agentId: AGENT }, { path: 'notes.md', limit: 5 })
    ).rejects.toBeInstanceOf(MemoryHistoryNotLocalError)
    // The sidecar still pages, through the same entry point.
    const local = new LocalMemoryFs(newDir())
    await new ManagedMemoryProvider(() => resolveMemoryHomePorts({ id: AGENT, dir: local.root }, { log })).write(
      { agentId: AGENT },
      'notes.md',
      'v1',
      undefined,
      'tool'
    )
    const page = await listMemoryHistory(new SidecarMemoryHistorySink(local), 'notes.md', undefined, 5)
    expect(page.events.map((event) => event.after)).toEqual(['v1'])
  })
})

describe('the console reads a control-plane home without waking the pod', () => {
  it('answers list, read, channels, and write from the CP port while the pod sleeps, and only a staging read asks for it', async () => {
    const cp = fakeCp()
    const agent = agentWith(managed('control-plane'))
    // A pool member whose agent pod is not bound: nothing here may ask for it.
    const sandbox = { memoryFsFor: vi.fn((): MemoryFs | undefined => undefined) }
    const deps = { sandbox, cp, log }
    const provider = new ManagedMemoryProvider(() => resolveMemoryHomePorts(agent, deps))
    const reader = createMemoryReader(() => resolveMemoryHomePorts(agent, deps), {
      adminSurfaceForAgent: () => provider.adminSurface()
    })
    await provider.ensure({ agentId: AGENT, channelKey: 'c1', channel: 'C1' }, 'bot-a')
    await reader.write({ agentId: AGENT, path: 'notes.md', content: '- from the console\n' })
    expect((await reader.list({ agentId: AGENT })).entries.map((entry) => entry.name)).toContain('notes.md')
    expect((await reader.read({ agentId: AGENT, path: 'notes.md', offset: 0, limit: 100 })).content).toContain(
      'from the console'
    )
    expect((await reader.channels({ agentId: AGENT })).channels.map((channel) => channel.channelKey)).toEqual(['c1'])
    expect(sandbox.memoryFsFor).not.toHaveBeenCalled()
    expect(cp.appends.at(-1)!.records[0]).toMatchObject({ path: 'notes.md', source: 'console' })

    // #1077's wake survives where staging lives: a review of a draft on the pool still refuses as asleep.
    expect(() => resolveMemoryHomePorts(agent, deps).staging).toThrow(MemorySandboxUnavailableError)
  })

  it('carries the reason of an unreachable home to the reader, and still knows the agent', async () => {
    const cp = fakeCp()
    const agent = agentWith(managed('control-plane'))
    const provider = new ManagedMemoryProvider(() => resolveMemoryHomePorts(agent, { cp, log }))
    const reader = createMemoryReader(() => resolveMemoryHomePorts(agent, { cp, log }), {
      adminSurfaceForAgent: () => provider.adminSurface()
    })
    cp.up = false
    const refusal = await reader.list({ agentId: AGENT }).then(
      () => undefined,
      (err: unknown) => err
    )
    expect(refusal).toBeInstanceOf(MemoryHomeUnavailableError)
    expect((refusal as MemoryHomeUnavailableError).reason).toBe('connection')
    await expect(provider.standingContextAtSessionStart({ agentId: AGENT })).rejects.toBeInstanceOf(
      MemoryHomeUnavailableError
    )
    // The shape query is config, not files: a known agent whose home is out of reach still answers it.
    expect((await reader.surface({ agentId: AGENT })).shape).toBe('files')
  })
})

describe('degradation: the capture outbox waits for the home', () => {
  const metrics: MemoryPluginMetrics = {
    recall: vi.fn(),
    recallInjected: vi.fn(),
    captureState: vi.fn(),
    outbox: vi.fn()
  }
  const noPlugins: MemoryCapturePumpRegistry = {
    connectionIds: () => [],
    clientFor: () => undefined,
    specFor: () => undefined,
    markDegraded: vi.fn(),
    markRecovered: vi.fn()
  }

  it('defers a distillation while the CP connection is down and drains it once the home is reachable', async () => {
    const cp = fakeCp()
    cp.up = false
    const agent = agentWith(managed('control-plane'))
    const distill = vi.fn(async () => {})
    const db = await LocalStore.open(join(newDir('ac-home-outbox-'), 'local.sqlite'))
    const outbox = new MemoryCaptureOutbox(
      db,
      withManagedDistill(noPlugins, {
        agentIds: () => [AGENT],
        // "The home is reachable", the same predicate the daemon wires — not "the pod is bound".
        reachable: () => memoryHomeUnavailable(agent, { cp, log }) === undefined,
        distill
      }),
      { metrics, unavailableRetryMs: 5 }
    )
    outbox.start()
    const queued = await outbox.enqueue(
      managedDistillCapture({ agentId: AGENT, turnId: 'turn-1', sessionId: 'sess-1', input: 'hi', output: 'hello' })
    )
    expect(queued.status).toBe('inserted')
    await vi.waitFor(async () =>
      expect((await db.getMemoryCapture(queued.operationId))?.reasonCode).toBe('connection_unavailable')
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(distill).not.toHaveBeenCalled()
    expect(await db.getMemoryCapture(queued.operationId)).toMatchObject({ state: 'pending', attempts: 0 })

    // READY again: the daemon wakes the pump from `onReady`, and the deferred turn is distilled exactly once.
    cp.up = true
    outbox.wake()
    await vi.waitFor(async () => expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('completed'))
    expect(distill).toHaveBeenCalledTimes(1)
    await outbox.stop()
    await db.close()
  })
})
