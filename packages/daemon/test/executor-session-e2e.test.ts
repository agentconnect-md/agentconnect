import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExecutorPrepareReq,
  ExecutorPrepareResult,
  ExecutorReleaseReq,
  ExecutorReleaseResult
} from '@agentconnect.md/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionKeyDirName } from '../src/acp/host-key.js'
import { startExecutorFacet, type ExecutorFacet } from '../src/execution/executor-facet.js'
import { ExecutorPlane } from '../src/execution/executor-plane.js'
import type { PlacementChoice } from '../src/execution/executor-placement.js'
import { effectiveStrategies } from '../src/execution/strategies.js'
import { sessionSandboxSubject } from '../src/remote/sandbox-subject.js'
import { ShimClient } from '../src/shim/client.js'
import type { GitExecPayload } from '../src/shim/git-exec.js'
import { ShimServer } from '../src/shim/server.js'
import type { ShimTransport } from '../src/shim/client.js'

/**
 * One holder and two other machines of its group, in one process (session-executors.md §7).
 *
 * Real on both data-plane ends: the executor facet admits a TLS-PSK dial and pipes it to a shim
 * that speaks the unmodified protocol, and the holder's plane prepares, dials and binds it. What
 * is a stub is the Control Plane's relay — it applies the one rule this side depends on, that only
 * the holder of the agent's duty is relayed — because the CP's own authorization and its ordering
 * argument are pinned by its own tests.
 *
 * Not covered here: two `Daemon` processes with their platform ingress, a real control WebSocket,
 * and the `host` strategy's own launcher, which needs Linux and has its own end-to-end case.
 */

const AGENT = '11111111-1111-4111-8111-111111111111'
const HOLDER = '22222222-2222-4222-8222-222222222222'
const SUCCESSOR = '33333333-3333-4333-8333-333333333333'
const EXECUTOR_A = '44444444-4444-4444-8444-444444444444'
const EXECUTOR_B = '55555555-5555-4555-8555-555555555555'
const KEY = `slack:C1:1700000000.000100:${AGENT}`
const LEAF = sessionKeyDirName(KEY)
const SUBJECT = sessionSandboxSubject(AGENT, LEAF)
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const HEAD = 'a2f5f0d9f0a34a3d9b6f3b1d5a4e8c7b6d5e4f31'

interface Machine {
  daemonId: string
  root: string
  facet: ExecutorFacet
  /** Every git the holder drove through this machine's shim. */
  exec: GitExecPayload[]
  stop: () => Promise<void>
}

describe('a session on another machine of the group', () => {
  const dirs: string[] = []
  const machines: Machine[] = []
  const planes: ExecutorPlane[] = []
  const servers: ShimServer[] = []
  const clients: ShimClient[] = []

  afterEach(async () => {
    for (const plane of planes.splice(0)) await plane.stop()
    for (const machine of machines.splice(0)) await machine.stop()
    for (const client of clients.splice(0)) client.stop()
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  /**
   * A machine that lends compute: the real facet, with a shim that is a real `ShimServer` on a unix
   * socket instead of the `host` launcher's child process — which needs Linux and is exercised
   * on its own by the facet's end-to-end case.
   */
  async function machine(daemonId: string, root?: string): Promise<Machine> {
    const daemonRoot = root ?? (await mkdtemp(join(tmpdir(), 'ac-xs-')))
    if (!root) dirs.push(daemonRoot)
    const exec: GitExecPayload[] = []
    const facet = await startExecutorFacet({
      daemonRoot,
      share: true,
      strategies: () => ({
        ...effectiveStrategies({ microsandbox: { configured: false } }),
        host: { available: true }
      }),
      capacity: () => 4,
      ownSessions: () => 0,
      draining: () => false,
      endpointHost: () => '127.0.0.1',
      seedHome: () => {},
      agentsExist: async (agentIds) => new Set(agentIds),
      retentionMs: () => null,
      log: quiet,
      startShim: async ({ sessionLeaf }) => {
        const server = new ShimServer()
        servers.push(server)
        const socketPath = join(await mkdtemp(join(tmpdir(), 'ac-xsk-')), 's.sock')
        dirs.push(socketPath)
        await server.startOnSocket(socketPath)
        const client = new ShimClient({
          endpoint: 'accepted-daemon-channel',
          dial: () => server.nextTransport() as Promise<ShimTransport>,
          // Presented and ignored: for an executor the proof is the pipe the dial crossed, not this token (§6).
          readToken: () => 'presented-and-unreviewed',
          workspaceRoot: join(daemonRoot, 'sessions', sessionLeaf),
          handle: (capability, payload) => {
            if (capability !== 'exec') throw new Error(`unexpected ${capability}`)
            exec.push(payload as GitExecPayload)
            return Promise.resolve({ code: 0, stdout: `${HEAD}\n`, stderr: '' })
          },
          log: { info: () => {}, warn: () => {} }
        })
        clients.push(client)
        void client.start().catch(() => undefined)
        let resolveExit!: () => void
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          resolveExit = () => resolve({ code: 0, signal: null })
        })
        return {
          socketPath,
          runtimeRoot: join(daemonRoot, 'hs', sessionLeaf),
          helperRoot: '/opt/agentconnect',
          missingHelpers: [],
          exited,
          stop: async () => {
            client.stop()
            await server.stop()
            resolveExit()
          }
        }
      },
      listen: { host: '127.0.0.1' }
    })
    const entry: Machine = {
      daemonId,
      root: daemonRoot,
      facet,
      exec,
      stop: async () => {
        await facet.stop()
      }
    }
    machines.push(entry)
    return entry
  }

  /** The Control Plane's part: the ledger check, and the relay to the executor's own connection. */
  class Relay {
    holder = HOLDER
    lastSeenAt: string | null = new Date().toISOString()
    readonly offline = new Set<string>()
    readonly released: ExecutorReleaseReq[] = []

    constructor(private readonly by: Map<string, Machine>) {}

    async prepare(from: string, req: ExecutorPrepareReq): Promise<ExecutorPrepareResult> {
      if (from !== this.holder) return { status: 'refused', reason: 'not_holder' }
      const machine = this.by.get(req.executorDaemonId)
      if (!machine || this.offline.has(req.executorDaemonId)) {
        return { status: 'offline', lastSeenAt: this.lastSeenAt }
      }
      return await machine.facet.prepare(req)
    }

    async release(from: string, req: ExecutorReleaseReq): Promise<ExecutorReleaseResult> {
      if (from !== this.holder) return { status: 'refused', reason: 'not_holder' }
      this.released.push(req)
      const machine = this.by.get(req.executorDaemonId)
      if (!machine) return { status: 'offline', lastSeenAt: this.lastSeenAt }
      return await machine.facet.release(req)
    }
  }

  function holderPlane(
    daemonId: string,
    relay: Relay,
    replace: (lastSeenAt: string | null) => Promise<PlacementChoice | undefined> = async () => undefined
  ): ExecutorPlane {
    const plane = new ExecutorPlane({
      prepare: (launch) =>
        relay.prepare(daemonId, {
          agentId: launch.agentId,
          sessionKey: launch.sessionKey,
          executorDaemonId: launch.executorDaemonId,
          launchId: launch.launchId,
          strategy: launch.strategy
        }),
      release: (placed, launchId) =>
        relay.release(daemonId, {
          agentId: placed.agentId,
          sessionKey: placed.sessionKey,
          executorDaemonId: placed.executorDaemonId,
          launchId
        }),
      replace: (_placed, lastSeenAt) => replace(lastSeenAt),
      log: { info: () => {}, warn: () => {} }
    })
    planes.push(plane)
    return plane
  }

  const choice = (daemonId: string): PlacementChoice => ({ daemonId, strategy: 'host' })

  it('is born on the executor, drives its git over the pipe, and is released with its launch', async () => {
    const executor = await machine(EXECUTOR_A)
    const relay = new Relay(new Map([[EXECUTOR_A, executor]]))
    const holder = holderPlane(HOLDER, relay)

    const landed = await holder.prepareAt(AGENT, KEY, [choice(EXECUTOR_A)])
    expect('placed' in landed && landed.placed.executorDaemonId).toBe(EXECUTOR_A)
    await holder.ensureChannel(SUBJECT)
    // Its workspace is composed on the executor's own root, in that machine's coordinates.
    expect(holder.mountFor(SUBJECT)).toBe(executor.root)
    expect(holder.rootsFor(KEY)?.runtimeRoot).toBe(join(executor.root, 'hs', LEAF))

    const cwd = join(executor.root, 'sessions', LEAF, 'workspace')
    const runner = holder.gitRunnerFor(AGENT, cwd)
    expect(runner).toBeDefined()
    expect((await runner!.raw(['rev-parse', 'HEAD'])).trim()).toBe(HEAD)
    // The holder drove it; the executor knows neither the remote nor the credentials (§7).
    expect(executor.exec.at(-1)).toMatchObject({ tool: 'git', cwd, args: ['rev-parse', 'HEAD'] })

    const launchId = holder.placementOf(KEY)!.launchId
    await holder.retire(AGENT, KEY)
    expect(relay.released).toEqual([
      { agentId: AGENT, sessionKey: KEY, executorDaemonId: EXECUTOR_A, launchId: expect.any(String) }
    ])
    expect(relay.released[0]!.launchId).toBe(launchId)
    expect(holder.placementOf(KEY)).toBeUndefined()
  })

  it('lets a successor holder attach to the environment its predecessor left', async () => {
    const executor = await machine(EXECUTOR_A)
    const relay = new Relay(new Map([[EXECUTOR_A, executor]]))
    const predecessor = holderPlane(HOLDER, relay)
    await predecessor.prepareAt(AGENT, KEY, [choice(EXECUTOR_A)])
    await predecessor.ensureChannel(SUBJECT)
    const first = predecessor.shimGenerationFor(SUBJECT)!

    // The duty moves; the predecessor's own launches go, and the environment stays.
    relay.holder = SUCCESSOR
    predecessor.releaseAgent(AGENT)
    const successor = holderPlane(SUCCESSOR, relay)
    // The hint is what `executor/candidates` carries: the successor prepares on the machine the session last ran on.
    const landed = await successor.prepareAt(AGENT, KEY, [choice(EXECUTOR_A)])
    expect('placed' in landed).toBe(true)
    await successor.ensureChannel(SUBJECT)
    // The same environment at the next generation, which is what closes the deposed holder out.
    expect(successor.shimGenerationFor(SUBJECT)).toBe(first + 1)
    expect(successor.mountFor(SUBJECT)).toBe(executor.root)
    const runner = successor.gitRunnerFor(AGENT, join(executor.root, 'sessions', LEAF, 'workspace'))
    expect((await runner!.raw(['rev-parse', 'HEAD'])).trim()).toBe(HEAD)

    // A deposed holder is refused by the relay's ledger check and never reaches the executor.
    await expect(predecessor.prepareAt(AGENT, KEY, [choice(EXECUTOR_A)])).resolves.toEqual({ refused: 'none' })
  })

  it('moves the session to another machine once its executor has been out of touch past the grace', async () => {
    const first = await machine(EXECUTOR_A)
    const second = await machine(EXECUTOR_B)
    const relay = new Relay(
      new Map([
        [EXECUTOR_A, first],
        [EXECUTOR_B, second]
      ])
    )
    const lost: Array<string | null> = []
    const holder = holderPlane(HOLDER, relay, async (lastSeenAt) => {
      lost.push(lastSeenAt)
      return choice(EXECUTOR_B)
    })
    await holder.prepareAt(AGENT, KEY, [choice(EXECUTOR_A)])
    await holder.ensureChannel(SUBJECT)

    // The machine goes: the CP cannot relay, and its own record of it is older than the grace.
    relay.offline.add(EXECUTOR_A)
    relay.lastSeenAt = new Date(Date.now() - 30 * 60_000).toISOString()
    await holder.suspendIdle(SUBJECT)
    const landed = await holder.prepareAt(AGENT, KEY, [choice(EXECUTOR_A)])
    expect('placed' in landed && landed.placed.executorDaemonId).toBe(EXECUTOR_B)
    expect(lost).toHaveLength(1)
    await holder.ensureChannel(SUBJECT)
    expect(holder.mountFor(SUBJECT)).toBe(second.root)
  })

  it('refuses a replayed launch after an executor restart, and prepares the next one above everything it handed out', async () => {
    const first = await machine(EXECUTOR_A)
    const relay = new Relay(new Map([[EXECUTOR_A, first]]))
    const holder = holderPlane(HOLDER, relay)
    await holder.prepareAt(AGENT, KEY, [choice(EXECUTOR_A)])
    await holder.ensureChannel(SUBJECT)
    const applied = holder.shimGenerationFor(SUBJECT)!
    const replayed = holder.placementOf(KEY)!.launchId!

    // The machine restarts over the same directories: the environment survives as a directory, its processes do not.
    await first.facet.stop()
    const restarted = await machine(EXECUTOR_A, first.root)
    const relayAfter = new Relay(new Map([[EXECUTOR_A, restarted]]))
    const after = holderPlane(HOLDER, relayAfter)

    // A `prepare` replayed for the launch the restart interrupted is refused rather than given a second key.
    await expect(
      relayAfter.prepare(HOLDER, {
        agentId: AGENT,
        sessionKey: KEY,
        executorDaemonId: EXECUTOR_A,
        launchId: replayed,
        strategy: 'host'
      })
    ).resolves.toEqual({ status: 'refused', reason: 'launch_retired' })

    const landed = await after.prepareAt(AGENT, KEY, [choice(EXECUTOR_A)])
    expect('placed' in landed).toBe(true)
    expect(after.shimGenerationFor(SUBJECT)).toBeGreaterThan(applied)
    await after.ensureChannel(SUBJECT)
    expect(after.mountFor(SUBJECT)).toBe(first.root)
  })
})
