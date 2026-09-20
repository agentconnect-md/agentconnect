import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
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
import { WAIT } from './wait-support.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222'
const SELF = '33333333-3333-4333-8333-333333333333'
const ELSEWHERE = '44444444-4444-4444-8444-444444444444'
const KEY = `slack:C1:1700000000.000100:${AGENT}`
const LEAF = sessionKeyDirName(KEY)

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

  // What the stub launcher did, and the two ways a test bends it.
  const starts: string[] = []
  const shims = new Map<string, StubShim>()
  let inFlight = 0
  let mostInFlight = 0
  let hold: Promise<void> | undefined
  let fail: Error | undefined
  let seeded: string[] = []

  afterEach(async () => {
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
    shims.clear()
    inFlight = mostInFlight = 0
    hold = fail = undefined
    seeded = []
    lines.length = 0
    minted.clear()
  })

  const startShim: NonNullable<ExecutorFacetDeps['startShim']> = async ({ daemonRoot, sessionLeaf }) => {
    starts.push(sessionLeaf)
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
        socketPath,
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
      sessions: { keysForAgent: async () => [KEY], executorOf: async () => ({ executorDaemonId: SELF }) },
      daemonId: () => SELF,
      log,
      clock,
      startShim,
      listen: { host: '127.0.0.1' },
      ...over
    })
    facets.push(facet)
    return { facet, clock }
  }

  const req = (generation: number, over: Partial<ExecutorPrepareReq> = {}): ExecutorPrepareReq => ({
    agentId: AGENT,
    sessionKey: KEY,
    executorDaemonId: SELF,
    generation,
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
  const record = (leaf = LEAF): { agentId: string; generation: number } =>
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
          microsandbox: { available: true }
        })
      })
      expect(facet.facts()).toBeUndefined()
      expect(await facet.prepare(req(1))).toEqual({ status: 'refused', reason: 'facet_off' })
      expect(lines.join('\n')).toMatch(/sandbox\.share is on but the facet stays off.*needs Linux/)
    })

    it('reports its facts once on: the host strategy only, the endpoint, and the capacity as it reads now', async () => {
      let capacity = 4
      const { facet } = await start({ capacity: () => capacity, ownSessions: () => 2 })
      const facts = facet.facts()!
      expect(facts).toEqual({
        enabled: true,
        strategies: { host: { available: true }, microsandbox: { available: false, reason: expect.any(String) } },
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
    it('creates the environment, seeds its HOME, starts the shim, persists the generation and admits the key it returns', async () => {
      const { facet } = await start()
      const reply = ready(await facet.prepare(req(3)))
      expect(reply).toEqual({
        status: 'ready',
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
      expect(record()).toMatchObject({ agentId: AGENT, generation: 3 })
      // The inventory names the agent and the leaf, never the session key's coordinates or a key.
      expect(readFileSync(join(root!, 'sessions', `${LEAF}.json`), 'utf8')).not.toMatch(/slack|psk|C1/)

      const socket = await dial(reply)
      socket.write('hello shim')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('hello shim'), WAIT)
    })

    it('answers an applied generation again with the same key, rotating nothing and closing no pipe', async () => {
      const { facet } = await start()
      const first = ready(await facet.prepare(req(3)))
      const socket = await admitted(first)
      const again = ready(await facet.prepare(req(3)))
      expect(again.psk).toBe(first.psk)
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

    it('rotates on a higher generation: a fresh key, the old pipe closed, the old key refused, the shim kept', async () => {
      const { facet } = await start()
      const old = ready(await facet.prepare(req(3)))
      const deposed = await admitted(old)
      const next = ready(await facet.prepare(req(4)))
      expect(next.psk).not.toBe(old.psk)
      await closed(deposed)
      await expect(dial(old)).rejects.toThrow(/decrypt error/i)
      const successor = await dial(next)
      successor.write('successor')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('successor'), WAIT)
      expect(starts).toHaveLength(1)
      expect(record().generation).toBe(4)
    })

    it('refuses a lower generation as stale and leaves the key, the pipe and the record alone', async () => {
      const { facet } = await start()
      const reply = ready(await facet.prepare(req(5)))
      const socket = await admitted(reply)
      expect(await facet.prepare(req(4))).toEqual({ status: 'refused', reason: 'stale_generation' })
      expect(record().generation).toBe(5)
      socket.write('unmoved')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('unmoved'), WAIT)
      expect(ready(await facet.prepare(req(5))).psk).toBe(reply.psk)
    })

    it('remembers the applied generation across a restart, and gives a replay of it no second key', async () => {
      const first = await start()
      ready(await first.facet.prepare(req(5)))
      await first.facet.stop()
      facets = []
      const { facet } = await start()
      expect(await facet.prepare(req(5))).toEqual({ status: 'refused', reason: 'launch_retired' })
      expect(await facet.prepare(req(4))).toEqual({ status: 'refused', reason: 'stale_generation' })
      expect(starts).toHaveLength(1)
      // The holder answers a retired launch with a new one, which starts the environment again.
      ready(await facet.prepare(req(6)))
      expect(starts).toHaveLength(2)
    })

    it("never attaches one agent's environment for a holder the Control Plane vouched for another agent", async () => {
      const { facet } = await start()
      const socket = await admitted(ready(await facet.prepare(req(3))))
      expect(await facet.prepare(req(9, { agentId: OTHER_AGENT }))).toEqual({ status: 'refused', reason: 'not_holder' })
      expect(record()).toMatchObject({ agentId: AGENT, generation: 3 })
      // The rightful holder's pipe is untouched by the attempt.
      socket.write('still mine')
      await vi.waitFor(() => expect(shims.get(LEAF)!.received()).toBe('still mine'), WAIT)
    })

    it('prepares the host strategy only, and nothing while the daemon drains', async () => {
      let draining = false
      const { facet } = await start({ draining: () => draining })
      expect(await facet.prepare(req(1, { strategy: 'microsandbox' }))).toEqual({
        status: 'refused',
        reason: 'strategy_unavailable'
      })
      draining = true
      expect(await facet.prepare(req(1))).toEqual({ status: 'refused', reason: 'draining' })
      expect(starts).toEqual([])
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
      expect(await overtaken).toEqual({ status: 'refused', reason: 'stale_generation' })
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
      // Generation 99 was never applied: the record is untouched, and 2 is still a newer launch.
      expect(record().generation).toBe(1)
      ready(await facet.prepare(req(2)))
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
      expect(record().generation).toBe(1)
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

  describe('orphan reconcile', () => {
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
      [
        'the shared store no longer lists its session',
        { sessions: { keysForAgent: async () => [], executorOf: async () => undefined } }
      ],
      [
        'its session row names another executor',
        { sessions: { keysForAgent: async () => [KEY], executorOf: async () => ({ executorDaemonId: ELSEWHERE }) } }
      ]
    ] as Array<[string, Partial<ExecutorFacetDeps>]>)('discards an environment when %s', async (_why, over) => {
      const { facet, dir } = await stale(over)
      await facet.reconcile()
      await vi.waitFor(() => expect(gone(dir)).toBe(true), WAIT)
      // The generation went with it: a session recreated under the same key starts over.
      ready(await facet.prepare(req(1)))
    })

    it.each([
      ['its session is listed and its row names this machine', {}],
      [
        'its row names no executor yet',
        { sessions: { keysForAgent: async () => [KEY], executorOf: async () => undefined } }
      ],
      [
        'the Control Plane cannot answer',
        {
          agentsExist: async () => Promise.reject(new Error('control plane unreachable')),
          sessions: { keysForAgent: async () => [], executorOf: async () => undefined }
        }
      ],
      [
        'the store cannot answer',
        {
          agentsExist: async () => new Set<string>(),
          sessions: {
            keysForAgent: async () => Promise.reject(new Error('store unreachable')),
            executorOf: async () => undefined
          }
        }
      ],
      ['no shared store is mounted at all', { agentsExist: async () => new Set<string>(), sessions: undefined }]
    ] as Array<[string, Partial<ExecutorFacetDeps>]>)('retains an environment when %s', async (_why, over) => {
      const { facet, dir } = await stale(over)
      await facet.reconcile()
      expect(existsSync(join(dir, 'home'))).toBe(true)
      expect(record().generation).toBe(1)
    })

    it('never judges an environment inside the grace, one with a live shim, or one a holder is using', async () => {
      const asked = vi.fn(async () => new Set<string>())
      const { facet, clock } = await start({ agentsExist: asked })
      const socket = await admitted(ready(await facet.prepare(req(1))))
      clock.advance(ORPHAN_GRACE_MS)
      await facet.reconcile()
      socket.destroy()
      await vi.waitFor(() => expect(clock.pending).toBeGreaterThan(1), WAIT)
      await facet.reconcile()
      expect(asked).not.toHaveBeenCalled()
      expect(existsSync(join(root!, 'sessions', LEAF, 'home'))).toBe(true)

      // Stopped a moment ago and re-prepared since: young again, whatever the authorities say.
      clock.advance(IDLE_LINGER_MS)
      await vi.waitFor(() => expect(facet.hostedSessions()).toBe(0), WAIT)
      ready(await facet.prepare(req(2)))
      clock.advance(IDLE_LINGER_MS)
      await vi.waitFor(() => expect(facet.hostedSessions()).toBe(0), WAIT)
      await facet.reconcile()
      expect(asked).not.toHaveBeenCalled()
    })

    it('never deletes an environment a prepare re-attached after the lookups were made', async () => {
      const under: { facet?: ExecutorFacet } = {}
      const { facet, dir } = await stale({
        sessions: {
          // The store answers "gone" from a snapshot, and a new launch lands before the sweep acts on it.
          keysForAgent: async () => {
            ready(await under.facet!.prepare(req(2)))
            return []
          },
          executorOf: async () => undefined
        }
      })
      under.facet = facet
      await facet.reconcile()
      expect(existsSync(join(dir, 'home'))).toBe(true)
      expect(record().generation).toBe(2)
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
      seedSessionHome(
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
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
