import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import { FakeClock } from '@agentconnect.md/connection'
import type { ExecutorPrepareReq, ExecutorPrepareResult } from '@agentconnect.md/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionKeyDirName } from '../src/acp/host-key.js'
import {
  IDLE_LINGER_MS,
  ORPHAN_GRACE_MS,
  seedSessionHome,
  startExecutorFacet,
  type ExecutorFacet,
  type ExecutorFacetDeps
} from '../src/execution/executor-facet.js'
import { PIPE_TLS } from '../src/execution/executor-pipe.js'
import type { SessionSeed, StrategyLauncher } from '../src/execution/strategies.js'
import { DEFAULT_SHIM_RUNTIME_ROOT } from '../src/shim/sandbox-paths.js'
import { WAIT } from './wait-support.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222'
const SELF = '33333333-3333-4333-8333-333333333333'
const KEY = `slack:C1:1700000000.000100:${AGENT}`
const LEAF = sessionKeyDirName(KEY)
/** A holder's launch id. Distinct ids are distinct launches; the number itself means nothing to the executor. */
const LAUNCH = (n: number): string => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`

type Ready = Extract<ExecutorPrepareResult, { status: 'ready' }>

/** In place of a host shim: a unix-socket echo server that knows whether it was stopped. */
interface StubShim {
  socketPath: string
  connections: Socket[]
  received: () => string
  stopped: boolean
  crash: () => void
}

describe('executor facet', () => {
  let root: string | undefined
  let facets: ExecutorFacet[] = []
  const servers: Server[] = []
  const clients: TLSSocket[] = []
  const lines: string[] = []
  const minted = new Set<string>()
  const keep = (line: string): void => void lines.push(line)
  const log = { trace: keep, debug: keep, info: keep, warn: keep, error: keep }

  // What the stub launchers did, and the two ways a test bends them.
  const starts: string[] = []
  const vmStarts: string[] = []
  const vmDiscards: string[] = []
  const shims = new Map<string, StubShim>()
  let inFlight = 0
  let mostInFlight = 0
  let hold: Promise<void> | undefined
  let fail: Error | undefined
  let seeded: string[] = []
  const seeds: Array<SessionSeed | undefined> = []

  const leftovers: ChildProcess[] = []

  afterEach(async () => {
    for (const child of leftovers.splice(0)) child.kill('SIGKILL')
    for (const client of clients.splice(0)) client.destroy()
    for (const facet of facets) await facet.stop()
    facets = []
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (root) await rm(root, { recursive: true, force: true })
    // The property every case shares: a key never reaches a log line, in any encoding.
    for (const psk of minted) {
      const key = Buffer.from(psk, 'base64url')
      for (const form of [psk, key.toString('hex'), key.toString('base64')]) {
        expect(lines.filter((line) => line.includes(form))).toEqual([])
      }
    }
    root = undefined
    starts.length = 0
    vmStarts.length = 0
    vmDiscards.length = 0
    shims.clear()
    inFlight = mostInFlight = 0
    hold = fail = undefined
    seeded = []
    seeds.length = 0
    lines.length = 0
    minted.clear()
  })

  const startShim: StrategyLauncher['start'] = async ({ daemonRoot, sessionLeaf, seed }) => {
    starts.push(sessionLeaf)
    seeds.push(seed)
    mostInFlight = Math.max(mostInFlight, ++inFlight)
    try {
      await hold
      if (fail) throw fail
      // Short on purpose: a unix socket path has a budget of about a hundred bytes.
      const runtimeRoot = join(daemonRoot, 'hs', String(starts.length))
      mkdirSync(runtimeRoot, { recursive: true })
      const socketPath = join(runtimeRoot, 's')
      const connections: Socket[] = []
      let received = ''
      const server = createServer((socket) => {
        connections.push(socket)
        socket.on('data', (chunk) => {
          received += chunk.toString()
          socket.write(chunk)
        })
        socket.on('error', () => {})
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(socketPath, resolve))
      let exit!: () => void
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => (exit = () => resolve({ code: 0, signal: null }))
      )
      const stub: StubShim = {
        socketPath,
        connections,
        received: () => received,
        stopped: false,
        crash: () => {
          for (const socket of connections) socket.destroy()
          exit()
        }
      }
      shims.set(sessionLeaf, stub)
      return {
        connect: () => netConnect(socketPath),
        runtimeRoot,
        helperRoot: '/opt/example/dist',
        missingHelpers: ['gitCredentialHelper'],
        exited,
        stop: async () => {
          stub.stopped = true
          stub.crash()
        }
      }
    } finally {
      inFlight -= 1
    }
  }

  /** A VM launcher with the manager and its guest stubbed out: the same echo socket, the image's own roots. */
  const vmLauncher: StrategyLauncher = {
    start: async (input) => {
      const environment = await startShim(input)
      vmStarts.push(input.sessionLeaf)
      return {
        connect: environment.connect,
        // What a VM reports (§5): the image's fixed layout, and no helper root at all.
        runtimeRoot: DEFAULT_SHIM_RUNTIME_ROOT,
        missingHelpers: [],
        exited: environment.exited,
        stop: environment.stop
      }
    },
    discard: async (sessionLeaf) => void vmDiscards.push(sessionLeaf)
  }

  async function start(over: Partial<ExecutorFacetDeps> = {}): Promise<{ facet: ExecutorFacet; clock: FakeClock }> {
    root ??= await mkdtemp(join(tmpdir(), 'ac-xf-'))
    const clock = (over.clock as FakeClock | undefined) ?? new FakeClock(1_000_000)
    const facet = await startExecutorFacet({
      daemonRoot: root,
      share: true,
      strategies: () => ({ host: { available: true }, microsandbox: { available: true } }),
      capacity: () => 4,
      ownSessions: () => 0,
      draining: () => false,
      endpointHost: () => '192.0.2.10',
      seedHome: (home) => {
        seeded.push(home)
        mkdirSync(home, { recursive: true })
      },
      agentsExist: async (agentIds) => new Set(agentIds),
      retentionMs: () => null,
      log,
      clock,
      launchers: { host: { start: startShim }, microsandbox: vmLauncher },
      listen: { host: '127.0.0.1' },
      ...over
    })
    facets.push(facet)
    return { facet, clock }
  }

  const req = (launch: number, over: Partial<ExecutorPrepareReq> = {}): ExecutorPrepareReq => ({
    agentId: AGENT,
    sessionKey: KEY,
    executorDaemonId: SELF,
    launchId: LAUNCH(launch),
    strategy: 'host',
    ...over
  })

  function ready(result: ExecutorPrepareResult): Ready {
    if (result.status !== 'ready') {
      throw new Error(`expected ready, got ${result.status}${result.status === 'refused' ? `: ${result.reason}` : ''}`)
    }
    minted.add(result.psk)
    return result
  }

  /** A holder's dial with the reply's key; rejects when the handshake is refused. */
  function dial(reply: Ready, leaf = LEAF): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: '127.0.0.1',
        port: reply.endpoint.port,
        ...PIPE_TLS,
        pskCallback: () => ({ psk: Buffer.from(reply.psk, 'base64url'), identity: leaf })
      })
      clients.push(socket)
      socket.once('secureConnect', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  /** A dial the facet has admitted: the client's handshake ends a moment before the listener pipes it. */
  async function admitted(reply: Ready): Promise<TLSSocket> {
    const before = shims.get(LEAF)!.connections.length
    const socket = await dial(reply)
    await vi.waitFor(() => expect(shims.get(LEAF)!.connections).toHaveLength(before + 1), WAIT)
    return socket
  }

  const closed = (socket: TLSSocket): Promise<void> =>
    new Promise((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())))
  const record = (
    leaf = LEAF
  ): { agentId: string; generation: number; launchId: string; lastUsedAt: number; strategy: string } =>
    JSON.parse(readFileSync(join(root!, 'sessions', `${leaf}.json`), 'utf8'))

  describe('the switch', () => {
    it('is dark unless the machine owner shares: no facts, no hosted count, and every prepare refused', async () => {
      const { facet } = await start({ share: false })
      expect(facet.facts()).toBeUndefined()
      expect(facet.hostedSessions()).toBeUndefined()
      expect(await facet.prepare(req(1))).toEqual({ status: 'refused', reason: 'facet_off' })
      expect(starts).toEqual([])
      expect(existsSync(join(root!, 'sessions'))).toBe(false)
    })

    it('stays dark and says why when sharing is on but no strategy can run here', async () => {
      const { facet } = await start({
        strategies: () => ({
          host: { available: false, reason: 'the host strategy needs Linux' },
          microsandbox: { available: false, reason: 'microsandbox is not the configured sandbox backend' }
        })
      })
      expect(facet.facts()).toBeUndefined()
      expect(await facet.prepare(req(1))).toEqual({ status: 'refused', reason: 'facet_off' })
      // Every strategy's own reason, so an operator reads what to fix rather than "no strategy".
      expect(lines.join('\n')).toMatch(
        /sandbox\.share is on but the facet stays off.*needs Linux.*not the configured sandbox backend/
      )
    })

    it('reports its facts once on: every strategy it prepares, the endpoint, and the capacity as it reads now', async () => {
      let capacity = 4
      const { facet } = await start({ capacity: () => capacity, ownSessions: () => 2 })
      const facts = facet.facts()!
      expect(facts).toEqual({
        enabled: true,
        strategies: { host: { available: true }, microsandbox: { available: true } },
        endpoint: { host: '192.0.2.10', port: expect.any(Number) },
        capacity: 4
      })
      capacity = 9
      expect(facet.facts()!.capacity).toBe(9)
      // Its own isolated sessions count too, so the number means the same for every candidate.
      expect(facet.hostedSessions()).toBe(2)
      ready(await facet.prepare(req(1)))
      expect(facet.hostedSessions()).toBe(3)
    })
  })

  describe('prepare', () => {
    it('creates the environment, seeds its HOME, allocates the first generation and admits the key it returns', async () => {
      const { facet } = await start()
      const reply = ready(await facet.prepare(req(3)))
      expect(reply).toEqual({
        status: 'ready',
        // The executor allocated it: the holder named a launch and no number at all.
        generation: 1,
        endpoint: { host: '192.0.2.10', port: facet.facts()!.endpoint!.port },
        psk: expect.any(String),
        runtimeRoot: join(root!, 'hs', '1'),
        helperRoot: '/opt/example/dist',
        missingHelpers: ['gitCredentialHelper'],
        liveCount: 1
      })
      expect(Buffer.from(reply.psk, 'base64url')).toHaveLength(32)
      expect(starts).toEqual([LEAF])
      expect(seeded).toEqual([join(root!, 'sessions', LEAF, 'home')])
      expect(record()).toMatchObject({ agentId: AGENT, generation: 1, launchId: LAUNCH(3) })
      // The inventory names the agent, the leaf and the launch, never the session key's coordinates or a key.
      expect(readFileSync(join(root!, 'sessions', `${LEAF}.json`), 'utf8')).not.toMatch(/slack|psk|C1/)

      const socket = await dial(reply)
      socket.write('hello shim')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('hello shim'), WAIT)
    })

    // §8: only this machine can say where the sign-in its HOME seed points at lives, so its shim says it for the runtime.
    it('hands whichever launcher the strategy names what the HOME seed points a runtime at', async () => {
      const seed = { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/op/.claude' }, paths: ['/home/op/.claude'] }
      const { facet } = await start({
        seedHome: (home) => {
          mkdirSync(home, { recursive: true })
          return seed
        }
      })
      ready(await facet.prepare(req(3)))
      ready(
        await facet.prepare(req(4, { sessionKey: `slack:C2:1700000000.000200:${AGENT}`, strategy: 'microsandbox' }))
      )
      expect(seeds).toEqual([seed, seed])
      expect(vmStarts).toHaveLength(1)
    })

    it('answers the same launch again with the same key and generation, rotating nothing and closing no pipe', async () => {
      const { facet } = await start()
      const first = ready(await facet.prepare(req(3)))
      const socket = await admitted(first)
      const again = ready(await facet.prepare(req(3)))
      expect(again.psk).toBe(first.psk)
      expect(again.generation).toBe(first.generation)
      expect(starts).toHaveLength(1)
      socket.write('still here')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('still here'), WAIT)
      expect(shims.get(LEAF)!.connections).toHaveLength(1)
    })

    it('joins a preparation still in flight instead of running it twice', async () => {
      let release!: () => void
      hold = new Promise<void>((resolve) => (release = resolve))
      const { facet } = await start()
      const first = facet.prepare(req(3))
      const resent = facet.prepare(req(3))
      release()
      expect(ready(await resent).psk).toBe(ready(await first).psk)
      expect(starts).toHaveLength(1)
    })

    it('rotates on a new launch: the next generation, a fresh key, the old pipe closed, the old key refused, the shim kept', async () => {
      const { facet } = await start()
      const old = ready(await facet.prepare(req(3)))
      const deposed = await admitted(old)
      const next = ready(await facet.prepare(req(4)))
      expect(next.psk).not.toBe(old.psk)
      expect(next.generation).toBe(old.generation + 1)
      await closed(deposed)
      await expect(dial(old)).rejects.toThrow(/decrypt error/i)
      const successor = await dial(next)
      successor.write('successor')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('successor'), WAIT)
      expect(starts).toHaveLength(1)
      expect(record()).toMatchObject({ generation: 2, launchId: LAUNCH(4) })
    })

    it('remembers the generation and the launch across a restart, and gives the interrupted launch no second key', async () => {
      const first = await start()
      expect(ready(await first.facet.prepare(req(5))).generation).toBe(1)
      await first.facet.stop()
      facets = []
      const { facet } = await start()
      // The reply died with the process, and minting a second key at the same generation would arm whoever replayed it.
      expect(await facet.prepare(req(5))).toEqual({ status: 'refused', reason: 'launch_retired' })
      expect(starts).toHaveLength(1)
      // The holder answers a retired launch with a new one, which starts the environment again past the generation on disk.
      expect(ready(await facet.prepare(req(6))).generation).toBe(2)
      expect(starts).toHaveLength(2)
      expect(record()).toMatchObject({ generation: 2, launchId: LAUNCH(6) })
    })

    it.skipIf(process.platform !== 'linux')(
      'ends what a killed daemon left — its marked processes and its runtime roots — before it starts any shim',
      async () => {
        root = await mkdtemp(join(tmpdir(), 'ac-xf-'))
        const mark = 'cd'.repeat(16)
        const stale = join(root, 'hs', 'stale')
        mkdirSync(stale, { recursive: true })
        writeFileSync(join(stale, 'mark'), mark)
        const idle = ['-e', 'setTimeout(() => {}, 120000)']
        // An earlier life's shim or runtime, in a group of its own as they are.
        const orphan = spawn(process.execPath, idle, {
          detached: true,
          stdio: 'ignore',
          env: { AC_SHIM_RUNTIME_MARK: mark }
        })
        const bystander = spawn(process.execPath, idle, { stdio: 'ignore' })
        leftovers.push(orphan, bystander)
        const gone = new Promise<NodeJS.Signals | null>((resolve) =>
          orphan.once('exit', (_c, signal) => resolve(signal))
        )
        let staleAtStart: boolean | undefined
        const { facet } = await start({
          launchers: {
            host: {
              start: (input) => {
                staleAtStart = existsSync(stale)
                return startShim(input)
              }
            }
          }
        })
        ready(await facet.prepare(req(1)))
        expect(staleAtStart).toBe(false)
        expect(await gone).toBe('SIGKILL')
        expect(bystander.exitCode ?? bystander.signalCode).toBeNull()
      }
    )

    it("never attaches one agent's environment for a holder the Control Plane vouched for another agent", async () => {
      const { facet } = await start()
      const socket = await admitted(ready(await facet.prepare(req(3))))
      expect(await facet.prepare(req(9, { agentId: OTHER_AGENT }))).toEqual({ status: 'refused', reason: 'not_holder' })
      expect(record()).toMatchObject({ agentId: AGENT, generation: 1, launchId: LAUNCH(3) })
      // The rightful holder's pipe is untouched by the attempt.
      socket.write('still mine')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('still mine'), WAIT)
    })

    it('prepares only what the effective table offers, and nothing while the daemon drains', async () => {
      let draining = false
      const { facet } = await start({
        draining: () => draining,
        strategies: () => ({ host: { available: true }, microsandbox: { available: false, reason: 'no KVM here' } })
      })
      expect(await facet.prepare(req(1, { strategy: 'microsandbox' }))).toEqual({
        status: 'refused',
        reason: 'strategy_unavailable'
      })
      // The table's own reason travels to a holder, rather than this facet inventing one.
      expect(facet.facts()?.strategies?.microsandbox).toEqual({ available: false, reason: 'no KVM here' })
      draining = true
      expect(await facet.prepare(req(1))).toEqual({ status: 'refused', reason: 'draining' })
      expect(starts).toEqual([])
      expect(vmStarts).toEqual([])
    })

    it('refuses a strategy the table offers but no launcher here prepares, and says which', async () => {
      const { facet } = await start({ launchers: { host: { start: startShim } } })
      expect(await facet.prepare(req(1, { strategy: 'microsandbox' }))).toEqual({
        status: 'refused',
        reason: 'strategy_unavailable'
      })
      expect(facet.facts()?.strategies).toEqual({
        host: { available: true },
        microsandbox: { available: false, reason: 'the executor facet prepares no microsandbox environments' }
      })
    })

    it('picks the launcher the asked-for strategy names, and a VM names the image roots rather than a session root', async () => {
      const { facet } = await start()
      const reply = ready(await facet.prepare(req(1, { strategy: 'microsandbox' })))
      expect(vmStarts).toEqual([LEAF])
      expect(starts).toEqual([LEAF])
      // Inside a VM the shim owns its filesystem namespace, so the reply names no per-session root and no helper root (§5).
      expect(reply.runtimeRoot).toBe(DEFAULT_SHIM_RUNTIME_ROOT)
      expect(reply.helperRoot).toBeUndefined()
      expect(reply.missingHelpers).toBeUndefined()
      // Its pipe reaches the environment through the connector its launcher supplied, not through a path.
      const socket = await admitted(reply)
      socket.write('through the guest')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('through the guest'), WAIT)
      expect(record()).toMatchObject({ strategy: 'microsandbox' })

      // Release takes what the strategy owns beyond the directory: the VM and its disks.
      expect(
        await facet.release({ agentId: AGENT, sessionKey: KEY, executorDaemonId: SELF, launchId: LAUNCH(1) })
      ).toEqual({
        status: 'released'
      })
      expect(vmDiscards).toEqual([LEAF])
      expect(existsSync(join(root!, 'sessions', LEAF))).toBe(false)
    })

    it('leaves a host environment to the host launcher, whose release discards no VM', async () => {
      const { facet } = await start()
      ready(await facet.prepare(req(1)))
      expect(vmStarts).toEqual([])
      expect(record()).toMatchObject({ strategy: 'host' })
      await facet.release({ agentId: AGENT, sessionKey: KEY, executorDaemonId: SELF, launchId: LAUNCH(1) })
      expect(vmDiscards).toEqual([])
    })

    it('reserves a slot atomically, counting preparations in flight and its own sessions, and answers full with the live count', async () => {
      let release!: () => void
      hold = new Promise<void>((resolve) => (release = resolve))
      let own = 0
      const { facet } = await start({ capacity: () => 1, ownSessions: () => own })
      const other = `slack:C2:1700000000.000200:${AGENT}`
      const first = facet.prepare(req(1))
      expect(await facet.prepare(req(1, { sessionKey: other }))).toEqual({ status: 'full', liveCount: 1 })
      release()
      ready(await first)
      // The environment that holds the slot needs no second one to take a new launch.
      ready(await facet.prepare(req(2)))
      own = 1
      expect(await facet.prepare(req(2, { sessionKey: other }))).toEqual({ status: 'full', liveCount: 2 })
    })

    it('releases the slot of a preparation that failed, and retires that launch', async () => {
      fail = new Error('host shim startup timed out')
      const { facet } = await start({ capacity: () => 1 })
      await expect(facet.prepare(req(1))).rejects.toThrow('startup timed out')
      expect(facet.hostedSessions()).toBe(0)
      fail = undefined
      expect(await facet.prepare(req(1))).toEqual({ status: 'refused', reason: 'launch_retired' })
      ready(await facet.prepare(req(1, { sessionKey: `slack:C2:1700000000.000200:${AGENT}` })))
    })

    it('starts environments one at a time, as the VM manager starts VMs', async () => {
      const { facet } = await start()
      const keys = [1, 2, 3].map((n) => `slack:C${n}:1700000000.000${n}00:${AGENT}`)
      for (const reply of await Promise.all(keys.map((sessionKey) => facet.prepare(req(1, { sessionKey })))))
        ready(reply)
      expect(starts).toHaveLength(3)
      expect(mostInFlight).toBe(1)
    })

    it('hands the key to a launch that is still the newest when it finishes, never to one a newer launch overtook', async () => {
      let release!: () => void
      hold = new Promise<void>((resolve) => (release = resolve))
      const { facet } = await start()
      const overtaken = facet.prepare(req(1))
      const newest = facet.prepare(req(2))
      release()
      expect(await overtaken).toEqual({ status: 'refused', reason: 'launch_retired' })
      const reply = ready(await newest)
      expect(starts).toHaveLength(1)
      await dial(reply)
    })

    it('treats bytes on an admitted pipe as bytes: a prepare can only come from the control connection', async () => {
      const { facet } = await start()
      const reply = ready(await facet.prepare(req(1)))
      const socket = await dial(reply)
      const forged = JSON.stringify({ type: 'executor/prepare', id: 'x', payload: req(99) })
      socket.write(forged)
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe(forged), WAIT)
      // Launch 99 was never applied: the record is untouched, and the next real launch still advances the generation.
      expect(record()).toMatchObject({ generation: 1, launchId: LAUNCH(1) })
      expect(ready(await facet.prepare(req(2))).generation).toBe(2)
    })
  })

  describe('idle stop', () => {
    it('stops an environment nobody dialed within the linger: the slot is freed, the key and the cached reply die, the directory stays', async () => {
      const { facet, clock } = await start()
      const reply = ready(await facet.prepare(req(1)))
      clock.advance(IDLE_LINGER_MS - 1)
      expect(shims.get(LEAF)!.stopped).toBe(false)
      clock.advance(1)
      await vi.waitFor(() => expect(facet.hostedSessions()).toBe(0), WAIT)
      expect(shims.get(LEAF)!.stopped).toBe(true)
      expect(await facet.prepare(req(1))).toEqual({ status: 'refused', reason: 'launch_retired' })
      await expect(dial(reply)).rejects.toThrow(/decrypt error/i)
      expect(existsSync(join(root!, 'sessions', LEAF, 'home'))).toBe(true)
      expect(record()).toMatchObject({ generation: 1, launchId: LAUNCH(1) })
    })

    it('never stops an environment with an admitted pipe, and starts the linger over when the pipe closes', async () => {
      const { facet, clock } = await start()
      const socket = await admitted(ready(await facet.prepare(req(1))))
      clock.advance(10 * IDLE_LINGER_MS)
      expect(shims.get(LEAF)!.stopped).toBe(false)
      socket.destroy()
      await vi.waitFor(() => expect(clock.pending).toBeGreaterThan(1), WAIT)
      clock.advance(IDLE_LINGER_MS - 1)
      expect(shims.get(LEAF)!.stopped).toBe(false)
      clock.advance(1)
      await vi.waitFor(() => expect(shims.get(LEAF)!.stopped).toBe(true), WAIT)
    })

    it('retires the launch of a shim that exits on its own', async () => {
      const { facet } = await start()
      const reply = ready(await facet.prepare(req(1)))
      const socket = await dial(reply)
      shims.get(LEAF)!.crash()
      await closed(socket)
      await vi.waitFor(() => expect(facet.hostedSessions()).toBe(0), WAIT)
      expect(await facet.prepare(req(1))).toEqual({ status: 'refused', reason: 'launch_retired' })
      await expect(dial(reply)).rejects.toThrow(/decrypt error/i)
    })
  })

  describe('the backstop reconcile', () => {
    /** One environment, stopped and older than the grace — the only kind a sweep may judge — on a facet whose own schedule has not fired yet. */
    async function stale(over: Partial<ExecutorFacetDeps> = {}): Promise<{ facet: ExecutorFacet; dir: string }> {
      const earlier = await start()
      ready(await earlier.facet.prepare(req(1)))
      await earlier.facet.stop()
      facets = []
      const { facet } = await start({ clock: new FakeClock(1_000_000 + ORPHAN_GRACE_MS), ...over })
      return { facet, dir: join(root!, 'sessions', LEAF) }
    }
    const gone = (dir: string): boolean => !existsSync(dir) && !existsSync(`${dir}.json`)

    it.each([
      ['the Control Plane no longer knows its agent', { agentsExist: async () => new Set<string>() }],
      ['nothing has dialed or prepared it within this machine’s retention', { retentionMs: () => ORPHAN_GRACE_MS }]
    ] as Array<[string, Partial<ExecutorFacetDeps>]>)('discards an environment when %s', async (_why, over) => {
      const { facet, dir } = await stale(over)
      await facet.reconcile()
      await vi.waitFor(() => expect(gone(dir)).toBe(true), WAIT)
      // The generation went with it: a session recreated under the same key starts over.
      expect(ready(await facet.prepare(req(1))).generation).toBe(1)
    })

    it.each([
      ['its agent is still known and retention is off', {}],
      ['its agent is still known and retention has not run out', { retentionMs: () => 10 * ORPHAN_GRACE_MS }],
      [
        'the Control Plane cannot answer, whatever retention says',
        {
          agentsExist: async () => Promise.reject(new Error('control plane unreachable')),
          retentionMs: () => ORPHAN_GRACE_MS
        }
      ]
    ] as Array<[string, Partial<ExecutorFacetDeps>]>)('retains an environment when %s', async (_why, over) => {
      const { facet, dir } = await stale(over)
      await facet.reconcile()
      expect(existsSync(join(dir, 'home'))).toBe(true)
      expect(record()).toMatchObject({ generation: 1, launchId: LAUNCH(1) })
    })

    it('never judges an environment inside the grace, one with a live shim, or one a holder is using', async () => {
      const asked = vi.fn(async () => new Set<string>())
      // Retention long past, so only "in use" can be what saves it.
      const { facet, clock } = await start({ agentsExist: asked, retentionMs: () => 1 })
      const socket = await admitted(ready(await facet.prepare(req(1))))
      clock.advance(ORPHAN_GRACE_MS)
      await facet.reconcile()
      socket.destroy()
      await vi.waitFor(() => expect(clock.pending).toBeGreaterThan(1), WAIT)
      await facet.reconcile()
      expect(asked).not.toHaveBeenCalled()
      expect(existsSync(join(root!, 'sessions', LEAF, 'home'))).toBe(true)

      // Stopped a moment ago and re-prepared since: young again, whatever the authority says.
      clock.advance(IDLE_LINGER_MS)
      await vi.waitFor(() => expect(facet.hostedSessions()).toBe(0), WAIT)
      ready(await facet.prepare(req(2)))
      clock.advance(IDLE_LINGER_MS)
      await vi.waitFor(() => expect(facet.hostedSessions()).toBe(0), WAIT)
      await facet.reconcile()
      expect(asked).not.toHaveBeenCalled()
    })

    it('measures retention from the last dial, which a restart does not reset', async () => {
      const retentionMs = (): number => ORPHAN_GRACE_MS
      const earlier = await start({ retentionMs })
      const reply = ready(await earlier.facet.prepare(req(1)))
      // A whole window of holder traffic after the preparation: the re-dial is use, and it is what the clock runs from.
      const socket = await admitted(reply)
      earlier.clock.advance(ORPHAN_GRACE_MS)
      socket.destroy()
      await closed(socket)
      await admitted(reply)
      await vi.waitFor(() => expect(record().lastUsedAt).toBe(1_000_000 + ORPHAN_GRACE_MS), WAIT)
      await earlier.facet.stop()
      facets = []

      // A moment short of a window since that dial, and two windows since the preparation: measured from the wrong one it would go.
      const clock = new FakeClock(1_000_000 + 2 * ORPHAN_GRACE_MS - 1)
      const { facet } = await start({ clock, retentionMs })
      await facet.reconcile()
      expect(existsSync(join(root!, 'sessions', LEAF, 'home'))).toBe(true)
      clock.advance(1)
      await facet.reconcile()
      await vi.waitFor(() => expect(gone(join(root!, 'sessions', LEAF))).toBe(true), WAIT)
    })

    it('never deletes an environment a prepare re-attached after the lookup was made', async () => {
      const under: { facet?: ExecutorFacet } = {}
      const { facet, dir } = await stale({
        // The Control Plane answers "gone" from a snapshot, and a new launch lands before the sweep acts on it.
        agentsExist: async () => {
          ready(await under.facet!.prepare(req(2)))
          return new Set<string>()
        }
      })
      under.facet = facet
      await facet.reconcile()
      expect(existsSync(join(dir, 'home'))).toBe(true)
      expect(record()).toMatchObject({ generation: 2, launchId: LAUNCH(2) })
      expect(facet.hostedSessions()).toBe(1)
    })

    it('reconciles on its own schedule what a restart no longer has in memory, labelled by agent and leaf on disk', async () => {
      const first = await start()
      ready(await first.facet.prepare(req(1)))
      await first.facet.stop()
      facets = []
      const clock = new FakeClock(1_000_000 + 2 * ORPHAN_GRACE_MS)
      await start({ clock, agentsExist: async () => new Set<string>() })
      clock.advance(ORPHAN_GRACE_MS)
      await vi.waitFor(() => expect(gone(join(root!, 'sessions', LEAF))).toBe(true), WAIT)
      expect(lines.join('\n')).toContain(`discarded ${LEAF} of agent ${AGENT}`)
    })

    it('still collects what an earlier run left once sharing is switched off, and opens nothing for it', async () => {
      const first = await start()
      ready(await first.facet.prepare(req(1)))
      await first.facet.stop()
      facets = []
      const clock = new FakeClock(1_000_000 + 2 * ORPHAN_GRACE_MS)
      const { facet } = await start({ share: false, clock, agentsExist: async () => new Set<string>() })
      // Withdrawn consent: nothing is advertised and nothing is created or attached.
      expect(facet.facts()).toBeUndefined()
      expect(await facet.prepare(req(2))).toEqual({ status: 'refused', reason: 'facet_off' })
      clock.advance(ORPHAN_GRACE_MS)
      await vi.waitFor(() => expect(gone(join(root!, 'sessions', LEAF))).toBe(true), WAIT)
    })
  })

  describe('release', () => {
    const release = (launch: number, over: Partial<{ agentId: string; sessionKey: string }> = {}) => ({
      agentId: AGENT,
      sessionKey: KEY,
      executorDaemonId: SELF,
      launchId: LAUNCH(launch),
      ...over
    })

    it('stops the shim, removes the environment and its record, and closes the holder’s pipe', async () => {
      const { facet } = await start()
      const socket = await admitted(ready(await facet.prepare(req(1))))
      expect(await facet.release(release(1))).toEqual({ status: 'released' })
      expect(shims.get(LEAF)!.stopped).toBe(true)
      await closed(socket)
      expect(existsSync(join(root!, 'sessions', LEAF))).toBe(false)
      expect(existsSync(join(root!, 'sessions', `${LEAF}.json`))).toBe(false)
      expect(facet.hostedSessions()).toBe(0)
    })

    it('is idempotent, and a session it never hosted is unknown rather than an error', async () => {
      const { facet } = await start()
      ready(await facet.prepare(req(1)))
      expect(await facet.release(release(1))).toEqual({ status: 'released' })
      expect(await facet.release(release(1))).toEqual({ status: 'unknown' })
      expect(await facet.release(release(1, { sessionKey: `slack:C9:1700000000.000900:${AGENT}` }))).toEqual({
        status: 'unknown'
      })
    })

    it('never crosses a launch boundary: a late release finds the environment on a newer launch and removes nothing', async () => {
      const { facet } = await start()
      ready(await facet.prepare(req(1)))
      const socket = await admitted(ready(await facet.prepare(req(2))))
      // A session key outlives its launches; this one was retransmitted or reordered past the prepare that replaced it.
      expect(await facet.release(release(1))).toEqual({ status: 'unknown' })
      expect(existsSync(join(root!, 'sessions', LEAF, 'home'))).toBe(true)
      expect(shims.get(LEAF)!.stopped).toBe(false)
      socket.write('untouched')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('untouched'), WAIT)
      // The launch the environment IS on releases it.
      expect(await facet.release(release(2))).toEqual({ status: 'released' })
    })

    it('refuses to release another agent’s environment, whoever the Control Plane vouched for', async () => {
      const { facet } = await start()
      ready(await facet.prepare(req(1)))
      expect(await facet.release(release(1, { agentId: OTHER_AGENT }))).toEqual({
        status: 'refused',
        reason: 'not_holder'
      })
      expect(existsSync(join(root!, 'sessions', LEAF, 'home'))).toBe(true)
    })

    it('still collects for a holder whose machine owner has withdrawn consent', async () => {
      const earlier = await start()
      ready(await earlier.facet.prepare(req(1)))
      await earlier.facet.stop()
      facets = []
      const { facet } = await start({ share: false })
      expect(facet.facts()).toBeUndefined()
      expect(await facet.release(release(1))).toEqual({ status: 'released' })
      expect(existsSync(join(root!, 'sessions', LEAF))).toBe(false)
    })

    it('retires the launch of an environment a release is removing, rather than making it wait', async () => {
      const { facet } = await start()
      ready(await facet.prepare(req(1)))
      const removing = facet.release(release(1))
      // A prepare that waited here would let a later holder's overtake it, which is the one ordering the CP cannot fix.
      expect(await facet.prepare(req(2))).toEqual({ status: 'refused', reason: 'launch_retired' })
      expect(await removing).toEqual({ status: 'released' })
      // Once it is gone the environment is created again, from the first generation.
      expect(ready(await facet.prepare(req(2))).generation).toBe(1)
    })

    it('lets a launch that was still starting finish, so its shim is stopped and not left detached', async () => {
      let launched!: () => void
      hold = new Promise<void>((resolve) => (launched = resolve))
      const { facet } = await start()
      const starting = facet.prepare(req(1))
      // The holder retired the session while its own preparation was still inside the launcher.
      const removing = facet.release(release(1))
      launched()
      ready(await starting)
      expect(await removing).toEqual({ status: 'released' })
      // The shim the launch started belongs to nobody once the record is gone, so the removal has to be the one that stops it.
      expect(shims.get(LEAF)!.stopped).toBe(true)
      expect(existsSync(join(root!, 'sessions', LEAF))).toBe(false)
      expect(facet.hostedSessions()).toBe(0)
    })
  })

  describe('shutdown drain', () => {
    it('spends nothing when no holder is connected: the shims stop at once and later prepares are refused as draining', async () => {
      const { facet, clock } = await start()
      ready(await facet.prepare(req(1)))
      await facet.drain(25_000)
      expect(clock.now()).toBe(1_000_000)
      expect(shims.get(LEAF)!.stopped).toBe(true)
      expect(await facet.prepare(req(2))).toEqual({ status: 'refused', reason: 'draining' })
      expect(existsSync(join(root!, 'sessions', LEAF, 'home'))).toBe(true)
    })

    it('gives a connected holder the whole budget, then stops its environment and closes its pipe', async () => {
      const { facet, clock } = await start()
      const socket = await admitted(ready(await facet.prepare(req(1))))
      let drained = false
      const draining = facet.drain(25_000).then(() => (drained = true))
      clock.advance(24_999)
      await new Promise((resolve) => setImmediate(resolve))
      expect(drained).toBe(false)
      expect(shims.get(LEAF)!.stopped).toBe(false)
      clock.advance(1)
      await draining
      expect(shims.get(LEAF)!.stopped).toBe(true)
      await closed(socket)
    })

    it('ends early once the last holder has gone', async () => {
      const { facet } = await start()
      const socket = await admitted(ready(await facet.prepare(req(1))))
      const draining = facet.drain(25_000)
      socket.destroy()
      await draining
      expect(shims.get(LEAF)!.stopped).toBe(true)
    })
  })
})

describe('seedSessionHome', () => {
  it("seeds a session HOME from this machine's runtime sign-in, without taking the machine's HOME from the process", async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-xf-seed-'))
    try {
      const machineHome = join(root, 'machine')
      const sessionHome = join(root, 'sessions', LEAF, 'home')
      mkdirSync(join(machineHome, '.codex'), { recursive: true })
      writeFileSync(join(machineHome, '.codex', 'config.toml'), 'model = "example"\n')
      writeFileSync(join(machineHome, '.codex', 'auth.json'), '{"last_refresh":"2026-01-01T00:00:00Z"}\n')
      const warnings: string[] = []
      const seed = seedSessionHome(
        sessionHome,
        {
          'codex-acp': { command: 'codex-acp', args: [], env: [] },
          'arbitrary-acp': { command: 'node', args: [], env: [] }
        },
        { warn: (line) => void warnings.push(line) },
        { HOME: machineHome }
      )
      expect(warnings).toEqual([])
      expect(readFileSync(join(sessionHome, '.codex', 'config.toml'), 'utf8')).toBe('model = "example"\n')
      expect(readFileSync(join(sessionHome, '.codex', 'auth.json'), 'utf8')).toContain('last_refresh')
      // Where the shared sign-in applies it is a link to the machine's own file, never a second copy that a token refresh would split.
      if (process.platform === 'linux') {
        expect(lstatSync(join(sessionHome, '.codex', 'auth.json')).isSymbolicLink()).toBe(true)
        // That link names a file on this machine, so the seed reports it for a strategy whose runtime does not share this filesystem.
        expect(seed.paths).toEqual([realpathSync(join(machineHome, '.codex', 'auth.json'))])
      } else {
        expect(seed).toEqual({ env: {}, paths: [] })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers where the Claude sign-in it leaves out of the HOME lives on this machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-xf-seed-'))
    try {
      const machineHome = join(root, 'machine')
      mkdirSync(join(machineHome, '.claude'), { recursive: true })
      writeFileSync(join(machineHome, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}\n')
      const seed = seedSessionHome(
        join(root, 'sessions', LEAF, 'home'),
        { 'claude-acp': { command: 'claude-agent-acp', args: [], env: [] } },
        { warn: () => {} },
        { HOME: machineHome }
      )
      // Shared sign-in is Linux-only; elsewhere the seed copies what it has and points at nothing.
      const dir = realpathSync(join(machineHome, '.claude'))
      expect(seed).toEqual(
        process.platform === 'linux'
          ? { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: dir }, paths: [dir] }
          : { env: {}, paths: [] }
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
