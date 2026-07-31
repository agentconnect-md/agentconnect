import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DelegatedWebchatHostManager,
  type DelegatedWebchatHostFactoryInput
} from '../src/acp/delegated-webchat-host-manager.js'
import type { AcpHost } from '../src/acp/acp-host.js'
import { delegatedMcpInCellSocketDirectory } from '../src/acp/sandbox.js'
import type {
  RegisterSessionMcpCell,
  ReleaseSessionMcpCell,
  SessionMcpBridgeDisconnected,
  SessionMcpCellMount
} from '../src/mcp/session-mcp-broker.js'
import { SessionMcpBroker } from '../src/mcp/session-mcp-broker.js'
import { decodeFrames, encodeFrame, type IpcResponse } from '../src/mcp/ipc.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = realpathSync(resolve(here, '../../..'))
const tempRoots: string[] = []
const realBrokers: SessionMcpBroker[] = []
const expiresAt = new Date(Date.now() + 60_000).toISOString()

afterEach(async () => {
  await Promise.all(realBrokers.splice(0).map((broker) => broker.stop()))
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function cellInput(conversationId: string, overrides: Partial<RegisterSessionMcpCell> = {}) {
  return {
    agentId: 'agent-1',
    conversationId,
    delegationId: `delegation-${conversationId}`,
    generation: 1,
    expiresAt,
    ...overrides
  }
}

class FakeBroker {
  readonly registrations: RegisterSessionMcpCell[] = []
  readonly drains: ReleaseSessionMcpCell[] = []
  readonly releases: ReleaseSessionMcpCell[] = []
  readonly mounts = new Map<string, SessionMcpCellMount>()
  readonly stop = vi.fn(async () => {})
  private listeners = new Set<(event: SessionMcpBridgeDisconnected) => void>()

  subscribeBridgeDisconnect(listener: (event: SessionMcpBridgeDisconnected) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async registerCell(input: RegisterSessionMcpCell) {
    this.registrations.push(input)
    const mount = {
      sourceDirectory: join('/trusted/broker', input.isolationCellId),
      sourceSocketPath: join('/trusted/broker', input.isolationCellId, 'mcp.sock'),
      targetDirectory: delegatedMcpInCellSocketDirectory()
    }
    this.mounts.set(input.isolationCellId, mount)
    return {
      name: 'agentconnect-admin',
      command: 'agentconnect',
      args: ['mcp-bridge', '--lazy-tools'],
      env: [
        { name: 'AC_MCP_ENDPOINT', value: join(delegatedMcpInCellSocketDirectory(), 'mcp.sock') },
        { name: 'AC_MCP_TOKEN', value: `token-${input.isolationCellId}` }
      ]
    }
  }

  getCellMount(isolationCellId: string) {
    return this.mounts.get(isolationCellId) ?? null
  }

  async releaseCell(input: ReleaseSessionMcpCell) {
    this.releases.push(input)
    this.mounts.delete(input.isolationCellId)
    return true
  }

  async beginDrainCell(input: ReleaseSessionMcpCell) {
    this.drains.push(input)
    return this.mounts.has(input.isolationCellId)
  }

  disconnect(event: SessionMcpBridgeDisconnected) {
    for (const listener of this.listeners) listener(event)
  }
}

function fakeHost(input: DelegatedWebchatHostFactoryInput, starts: string[], stops: string[]): AcpHost {
  return {
    start: async () => {
      starts.push(input.conversationId)
    },
    stop: async () => {
      stops.push(input.conversationId)
    }
  } as unknown as AcpHost
}

function harness(
  overrides: {
    broker?: FakeBroker
    healthy?: boolean
    randomCellId?: () => string
    hostFactory?: (input: DelegatedWebchatHostFactoryInput) => AcpHost
    removeRuntimeHome?: (path: string) => Promise<void>
  } = {}
) {
  const runtimeHomeRoot = mkdtempSync(join(tmpdir(), 'ac-delegated-host-test-'))
  const resolvedRoot = realpathSync(runtimeHomeRoot)
  expect(resolvedRoot).not.toBe(repoRoot)
  expect(resolvedRoot.startsWith(repoRoot + sep)).toBe(false)
  tempRoots.push(runtimeHomeRoot)
  const broker = overrides.broker ?? new FakeBroker()
  const starts: string[] = []
  const stops: string[] = []
  const factoryInputs: DelegatedWebchatHostFactoryInput[] = []
  const manager = new DelegatedWebchatHostManager({
    broker,
    brokerSourceRoot: '/trusted/broker',
    runtimeHomeRoot,
    isolationHealthy: () => overrides.healthy ?? true,
    randomCellId: overrides.randomCellId,
    removeRuntimeHome: overrides.removeRuntimeHome,
    hostFactory: (input) => {
      factoryInputs.push(input)
      return overrides.hostFactory?.(input) ?? fakeHost(input, starts, stops)
    }
  })
  return { manager, broker, runtimeHomeRoot, starts, stops, factoryInputs }
}

describe('DelegatedWebchatHostManager', () => {
  it('refuses construction when the delegated bwrap isolation probe is unhealthy', () => {
    expect(() => harness({ healthy: false })).toThrow(/isolation.*unavailable/i)
  })

  it('registers exact bindings before start and isolates two conversations on one agent', async () => {
    let next = 0
    const order: string[] = []
    const broker = new FakeBroker()
    const register = broker.registerCell.bind(broker)
    broker.registerCell = async (input) => {
      order.push(`register:${input.conversationId}`)
      return register(input)
    }
    const h = harness({
      broker,
      randomCellId: () => `random-cell-${++next}`,
      hostFactory: (input) =>
        ({
          start: async () => {
            order.push(`start:${input.conversationId}`)
          },
          stop: async () => {}
        }) as unknown as AcpHost
    })

    const [a, b] = await Promise.all([
      h.manager.startHost(cellInput('conversation-a')),
      h.manager.startHost(cellInput('conversation-b'))
    ])

    expect(order.indexOf('register:conversation-a')).toBeLessThan(order.indexOf('start:conversation-a'))
    expect(order.indexOf('register:conversation-b')).toBeLessThan(order.indexOf('start:conversation-b'))
    expect(a.host).not.toBe(b.host)
    expect(a.isolationCellId).not.toBe(b.isolationCellId)
    expect(a.runtimeHome).not.toBe(b.runtimeHome)
    expect(a.mount.sourceDirectory).not.toBe(b.mount.sourceDirectory)
    expect(a.adminMcpServer.env).not.toEqual(b.adminMcpServer.env)
    const factoryA = h.factoryInputs.find((input) => input.conversationId === 'conversation-a')
    const factoryB = h.factoryInputs.find((input) => input.conversationId === 'conversation-b')
    expect(factoryA).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conversation-a',
        runtimeHome: a.runtimeHome,
        adminMcpServer: a.adminMcpServer,
        sandbox: {
          mechanism: 'bwrap',
          writable: [a.runtimeHome],
          maskedReadRoots: ['/trusted/broker', h.runtimeHomeRoot],
          delegatedCellMount: {
            maskedRoot: '/trusted/broker',
            sourceDir: a.mount.sourceDirectory,
            targetDir: a.mount.targetDirectory
          },
          delegatedRuntimeHomeMount: {
            maskedRoot: h.runtimeHomeRoot,
            sourceDir: a.runtimeHome,
            targetDir: a.runtimeHome
          }
        }
      })
    )
    expect(factoryB).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conversation-b',
        runtimeHome: b.runtimeHome
      })
    )
    expect(existsSync(a.runtimeHome)).toBe(true)
    expect(existsSync(b.runtimeHome)).toBe(true)
  })

  it('serializes concurrent starts for the same logical conversation', async () => {
    let resolveStart!: () => void
    const h = harness({
      hostFactory: () =>
        ({
          start: () => new Promise<void>((resolve) => (resolveStart = resolve)),
          stop: async () => {}
        }) as unknown as AcpHost
    })
    const first = h.manager.startHost(cellInput('same'))
    const second = h.manager.startHost(cellInput('same'))
    await vi.waitFor(() => expect(h.broker.registrations).toHaveLength(1))
    resolveStart()
    expect(await second).toBe(await first)
    expect(h.factoryInputs).toHaveLength(1)
  })

  it('drains a lower generation completely before registering its replacement', async () => {
    const order: string[] = []
    const broker = new FakeBroker()
    const register = broker.registerCell.bind(broker)
    const drain = broker.beginDrainCell.bind(broker)
    const release = broker.releaseCell.bind(broker)
    broker.registerCell = async (input) => {
      order.push(`register:${input.generation}`)
      return register(input)
    }
    broker.beginDrainCell = async (input) => {
      order.push(`drain:${input.generation}`)
      return drain(input)
    }
    broker.releaseCell = async (input) => {
      order.push(`release:${input.generation}`)
      return release(input)
    }
    const h = harness({
      broker,
      hostFactory: (input) =>
        ({
          start: async () => order.push(`start:${input.adminMcpServer.env.at(-1)?.value}`),
          stop: async () => order.push('stop:old')
        }) as unknown as AcpHost
    })

    const first = await h.manager.startHost(cellInput('replace'))
    const replacement = await h.manager.startHost({
      ...cellInput('replace'),
      delegationId: 'delegation-2',
      generation: 2
    })

    expect(replacement.isolationCellId).not.toBe(first.isolationCellId)
    expect(order.indexOf('drain:1')).toBeLessThan(order.indexOf('stop:old'))
    expect(order.indexOf('stop:old')).toBeLessThan(order.indexOf('release:1'))
    expect(order.indexOf('release:1')).toBeLessThan(order.indexOf('register:2'))
    await expect(
      h.manager.startHost({
        ...cellInput('replace'),
        delegationId: 'stale',
        generation: 1
      })
    ).rejects.toThrow(/stale delegation generation/)
  })

  it('cleans the home and broker cell when registration or host start fails', async () => {
    const registrationBroker = new FakeBroker()
    registrationBroker.registerCell = async (input) => {
      registrationBroker.registrations.push(input)
      throw new Error('listen failed')
    }
    const registration = harness({ broker: registrationBroker })
    await expect(registration.manager.startHost(cellInput('register-fail'))).rejects.toThrow('listen failed')
    expect(registration.factoryInputs).toHaveLength(0)
    expect(registrationBroker.releases).toHaveLength(0)
    expect(registration.manager.debugStats().activeHosts).toBe(0)
    expect(readdirSync(registration.runtimeHomeRoot)).toEqual([])

    const initialization = harness({
      hostFactory: () => {
        throw new Error('host construction failed')
      }
    })
    await expect(initialization.manager.startHost(cellInput('host-construction-fail'))).rejects.toThrow(
      'host construction failed'
    )
    expect(initialization.broker.releases).toHaveLength(1)
    expect(readdirSync(initialization.runtimeHomeRoot)).toEqual([])

    const hostFailure = harness({
      hostFactory: () =>
        ({
          start: async () => {
            throw new Error('initialize failed')
          },
          stop: vi.fn(async () => {})
        }) as unknown as AcpHost
    })
    await expect(hostFailure.manager.startHost(cellInput('host-fail'))).rejects.toThrow('initialize failed')
    expect(hostFailure.broker.releases).toHaveLength(1)
    expect(hostFailure.manager.debugStats().activeHosts).toBe(0)
    expect(readdirSync(hostFailure.runtimeHomeRoot)).toEqual([])
  })

  it('drains an in-progress allocation on manager stop without starting a late host', async () => {
    const broker = new FakeBroker()
    const register = broker.registerCell.bind(broker)
    let releaseRegistration!: () => void
    const registrationGate = new Promise<void>((resolve) => (releaseRegistration = resolve))
    let registrationEntered!: () => void
    const entered = new Promise<void>((resolve) => (registrationEntered = resolve))
    broker.registerCell = async (input) => {
      registrationEntered()
      await registrationGate
      return register(input)
    }
    const h = harness({ broker })
    const starting = h.manager.startHost(cellInput('stopping'))
    await entered
    const stopping = h.manager.stop()
    releaseRegistration()
    await expect(starting).rejects.toThrow(/stopped|unavailable|cancel/i)
    await stopping
    expect(h.factoryInputs).toHaveLength(0)
    await vi.waitFor(() => expect(h.broker.releases).toHaveLength(1))
    expect(h.manager.debugStats()).toEqual({
      activeHosts: 0,
      pendingStarts: 0,
      drainingHosts: 0,
      inactiveAuthorities: 0,
      stopped: true
    })
  })

  it('cancels a never-resolving host start and completes stop with every allocated resource removed', async () => {
    let startEntered!: () => void
    const entered = new Promise<void>((resolveEntered) => (startEntered = resolveEntered))
    const h = harness({
      hostFactory: () =>
        ({
          start: () => {
            startEntered()
            return new Promise<void>(() => {})
          },
          stop: vi.fn(async () => {})
        }) as unknown as AcpHost
    })
    const starting = h.manager.startHost(cellInput('hung-start'))
    await entered

    await expect(
      Promise.race([
        h.manager.stop(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('manager stop hung')), 500))
      ])
    ).resolves.toBeUndefined()
    await expect(starting).rejects.toThrow(/stopped|cancel/i)
    expect(h.broker.drains).toHaveLength(1)
    expect(h.broker.releases).toHaveLength(1)
    expect(readdirSync(h.runtimeHomeRoot)).toEqual([])
    expect(h.manager.debugStats()).toEqual({
      activeHosts: 0,
      pendingStarts: 0,
      drainingHosts: 0,
      inactiveAuthorities: 0,
      stopped: true
    })
  })

  it('fails closed when the isolation probe becomes unhealthy during allocation', async () => {
    let healthy = true
    const broker = new FakeBroker()
    const register = broker.registerCell.bind(broker)
    broker.registerCell = async (input) => {
      const descriptor = await register(input)
      healthy = false
      return descriptor
    }
    const runtimeHomeRoot = mkdtempSync(join(tmpdir(), 'ac-delegated-host-test-'))
    tempRoots.push(runtimeHomeRoot)
    const hostFactory = vi.fn()
    const manager = new DelegatedWebchatHostManager({
      broker,
      brokerSourceRoot: '/trusted/broker',
      runtimeHomeRoot,
      isolationHealthy: () => healthy,
      hostFactory
    })
    await expect(manager.startHost(cellInput('probe-loss'))).rejects.toThrow(/isolation.*unavailable/i)
    expect(hostFactory).not.toHaveBeenCalled()
    expect(broker.releases).toHaveLength(1)
  })

  it('tears down on a fenced authenticated bridge disconnect and ignores stale events/stops', async () => {
    const h = harness({ randomCellId: () => 'live-cell' })
    const live = await h.manager.startHost(cellInput('conversation'))

    h.broker.disconnect({
      isolationCellId: 'stale-cell',
      agentId: 'agent-1',
      conversationId: 'conversation',
      delegationId: 'delegation-conversation',
      generation: 1
    })
    await h.manager.stopHost({
      isolationCellId: 'stale-cell',
      agentId: 'agent-1',
      conversationId: 'conversation'
    })
    expect(h.stops).toEqual([])

    h.broker.disconnect({
      isolationCellId: live.isolationCellId,
      agentId: 'agent-1',
      conversationId: 'conversation',
      delegationId: 'wrong-delegation',
      generation: 1
    })
    expect(h.stops).toEqual([])

    h.broker.disconnect({
      isolationCellId: live.isolationCellId,
      agentId: 'agent-1',
      conversationId: 'conversation',
      delegationId: 'delegation-conversation',
      generation: 1
    })
    await vi.waitFor(() => {
      expect(h.stops).toEqual(['conversation'])
      expect(existsSync(live.runtimeHome)).toBe(false)
    })
    expect(h.broker.releases).toEqual([
      {
        isolationCellId: live.isolationCellId,
        agentId: 'agent-1',
        conversationId: 'conversation',
        delegationId: 'delegation-conversation',
        generation: 1
      }
    ])
  })

  it('retains the exact authority fence after a single local host stop', async () => {
    const h = harness({ randomCellId: () => 'single-stop-cell' })
    const live = await h.manager.startHost(
      cellInput('single-stop', {
        delegationId: 'delegation-single-stop',
        generation: 7
      })
    )

    await expect(
      h.manager.stopHost({
        isolationCellId: live.isolationCellId,
        agentId: 'agent-1',
        conversationId: 'single-stop'
      })
    ).resolves.toBe(true)
    expect(h.manager.debugStats().inactiveAuthorities).toBe(1)
    await expect(
      h.manager.closeConversation({
        agentId: 'agent-1',
        conversationId: 'single-stop'
      })
    ).resolves.toEqual({
      agentId: 'agent-1',
      conversationId: 'single-stop',
      delegationId: 'delegation-single-stop',
      generation: 7,
      expiresAt
    })
    expect(h.manager.debugStats().inactiveAuthorities).toBe(0)
  })

  it('waits for a delayed raw registration before local drain reports cleanup complete', async () => {
    const broker = new FakeBroker()
    const register = broker.registerCell.bind(broker)
    let registrationEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      registrationEntered = resolve
    })
    let releaseRegistration!: () => void
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve
    })
    broker.registerCell = async (input) => {
      registrationEntered()
      await registrationGate
      return register(input)
    }
    const h = harness({ broker, randomCellId: () => 'late-registration-cell' })

    const starting = h.manager.startHost(cellInput('late-registration'))
    await entered
    let cleanupSettled = false
    const cleanup = h.manager.stopAgentHosts('agent-1').then(() => {
      cleanupSettled = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    expect(cleanupSettled).toBe(false)
    expect(broker.drains).toEqual([])
    expect(broker.releases).toEqual([])

    releaseRegistration()
    await expect(starting).rejects.toThrow(/cancel/i)
    await cleanup
    expect(broker.drains).toEqual([
      expect.objectContaining({
        isolationCellId: 'late-registration-cell',
        conversationId: 'late-registration',
        delegationId: 'delegation-late-registration',
        generation: 1
      })
    ])
    expect(broker.releases).toEqual(broker.drains)
    expect(h.manager.debugStats()).toMatchObject({
      activeHosts: 0,
      pendingStarts: 0,
      drainingHosts: 0,
      inactiveAuthorities: 1
    })
  })

  it('locally stops one conversation without consuming its later revocation fence', async () => {
    const h = harness({ randomCellId: () => 'local-conversation-cell' })
    const live = await h.manager.startHost(
      cellInput('local-conversation', {
        delegationId: 'delegation-local-conversation',
        generation: 9
      })
    )

    await h.manager.stopConversationHosts({
      agentId: 'agent-1',
      conversationId: 'local-conversation'
    })
    expect(existsSync(live.runtimeHome)).toBe(false)
    await expect(
      h.manager.closeConversation({
        agentId: 'agent-1',
        conversationId: 'local-conversation'
      })
    ).resolves.toEqual({
      agentId: 'agent-1',
      conversationId: 'local-conversation',
      delegationId: 'delegation-local-conversation',
      generation: 9,
      expiresAt
    })
  })

  it('stops agent-scoped or daemon-scoped cells locally while keeping the manager reusable', async () => {
    let cell = 0
    const h = harness({ randomCellId: () => `scoped-cell-${++cell}` })
    const first = await h.manager.startHost(cellInput('first'))
    const second = await h.manager.startHost(cellInput('second'))
    const other = await h.manager.startHost(
      cellInput('other', {
        agentId: 'agent-2',
        delegationId: 'delegation-other-agent'
      })
    )

    await h.manager.stopAgentHosts('agent-1')
    expect(h.stops).toEqual(expect.arrayContaining(['first', 'second']))
    expect(h.stops).not.toContain('other')
    expect(existsSync(first.runtimeHome)).toBe(false)
    expect(existsSync(second.runtimeHome)).toBe(false)
    expect(existsSync(other.runtimeHome)).toBe(true)
    expect(h.manager.debugStats()).toMatchObject({ activeHosts: 1, inactiveAuthorities: 2, stopped: false })
    await expect(h.manager.closeAgent('agent-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: 'first', delegationId: 'delegation-first', generation: 1 }),
        expect.objectContaining({ conversationId: 'second', delegationId: 'delegation-second', generation: 1 })
      ])
    )
    expect(h.manager.debugStats().inactiveAuthorities).toBe(0)

    const restarted = await h.manager.startHost(cellInput('restarted'))
    expect(existsSync(restarted.runtimeHome)).toBe(true)
    await h.manager.stopAllHosts()
    expect(h.stops).toEqual(expect.arrayContaining(['other', 'restarted']))
    expect(existsSync(other.runtimeHome)).toBe(false)
    expect(existsSync(restarted.runtimeHome)).toBe(false)
    expect(h.manager.debugStats()).toEqual({
      activeHosts: 0,
      pendingStarts: 0,
      drainingHosts: 0,
      inactiveAuthorities: 2,
      stopped: false
    })
    await h.manager.stop()
    expect(h.manager.debugStats()).toMatchObject({ inactiveAuthorities: 0, stopped: true })
  })

  it('deduplicates concurrent local cleanup without losing detach authority fences', async () => {
    let stopEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      stopEntered = resolve
    })
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const h = harness({
      randomCellId: () => 'concurrent-cell',
      hostFactory: () =>
        ({
          start: async () => {},
          stop: async () => {
            stopEntered()
            await stopGate
          }
        }) as unknown as AcpHost
    })
    const live = await h.manager.startHost(cellInput('concurrent'))

    const localCleanup = h.manager.stopAllHosts()
    await entered
    const detachCleanup = h.manager.closeAgent('agent-1')
    releaseStop()

    await expect(localCleanup).resolves.toBeUndefined()
    await expect(detachCleanup).resolves.toEqual([
      {
        agentId: 'agent-1',
        conversationId: 'concurrent',
        delegationId: 'delegation-concurrent',
        generation: 1,
        expiresAt
      }
    ])
    expect(h.broker.releases).toHaveLength(1)
    expect(existsSync(live.runtimeHome)).toBe(false)
  })

  it('fully removes the host, home, mount, cell, and token when a real attached bridge disconnects before tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-mgr-'))
    tempRoots.push(root)
    expect(realpathSync(root).startsWith(repoRoot + sep)).toBe(false)
    const brokerSourceRoot = join(root, 'b')
    const runtimeHomeRoot = join(root, 'h')
    const mintMcpInvocation = vi.fn(async () => {
      throw new Error('attach must not mint')
    })
    const broker = new SessionMcpBroker({
      socketRoot: brokerSourceRoot,
      inCellSocketDirectory: delegatedMcpInCellSocketDirectory(),
      cliEntry: '/opt/agentconnect/current/index.js',
      mcpEndpoint: 'https://cp.invalid/api/v1/mcp',
      cpClient: {
        mintMcpInvocation,
        revokeWebchatMcpDelegation: vi.fn()
      },
      randomToken: () => 'real-private-token'
    })
    realBrokers.push(broker)
    const hostStop = vi.fn(async () => {})
    const manager = new DelegatedWebchatHostManager({
      broker,
      brokerSourceRoot,
      runtimeHomeRoot,
      isolationHealthy: () => true,
      randomCellId: () => 'real-cell',
      hostFactory: () =>
        ({
          start: async () => {},
          stop: hostStop
        }) as unknown as AcpHost
    })
    const live = await manager.startHost(cellInput('real-conversation'))
    const token = Object.fromEntries(live.adminMcpServer.env.map(({ name, value }) => [name, value])).AC_MCP_TOKEN!

    const socket = net.connect(live.mount.sourceSocketPath)
    socket.setEncoding('utf8')
    const attached = new Promise<void>((resolveAttached, reject) => {
      let buffer = ''
      socket.once('error', reject)
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const decoded = decodeFrames<IpcResponse>(buffer)
        buffer = decoded.rest
        if (decoded.messages.some((response) => response.ok)) resolveAttached()
      })
    })
    await new Promise<void>((resolveConnected) => socket.once('connect', resolveConnected))
    socket.write(encodeFrame({ id: 1, token, op: 'attach' }))
    await attached
    expect(mintMcpInvocation).not.toHaveBeenCalled()
    socket.destroy()

    await vi.waitFor(() => {
      expect(hostStop).toHaveBeenCalledOnce()
      expect(manager.debugStats().activeHosts).toBe(0)
      expect(existsSync(live.runtimeHome)).toBe(false)
      expect(broker.getCellMount(live.isolationCellId)).toBeNull()
      expect(readdirSync(brokerSourceRoot)).toEqual([])
    })
    expect(broker.debugStats()).toMatchObject({ activeCells: 0, connections: 0 })
  })

  it('revokes the real broker before a slow host stop so another bridge cannot mint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-mgr-slow-'))
    tempRoots.push(root)
    expect(realpathSync(root).startsWith(repoRoot + sep)).toBe(false)
    const brokerSourceRoot = join(root, 'b')
    const runtimeHomeRoot = join(root, 'h')
    const mintMcpInvocation = vi.fn(async () => {
      throw new Error('draining cell must not mint')
    })
    const broker = new SessionMcpBroker({
      socketRoot: brokerSourceRoot,
      inCellSocketDirectory: delegatedMcpInCellSocketDirectory(),
      cliEntry: '/opt/agentconnect/current/index.js',
      mcpEndpoint: 'https://cp.invalid/api/v1/mcp',
      cpClient: { mintMcpInvocation, revokeWebchatMcpDelegation: vi.fn() },
      randomToken: () => 'slow-private-token'
    })
    realBrokers.push(broker)
    let releaseHostStop!: () => void
    const hostStopGate = new Promise<void>((resolveStop) => (releaseHostStop = resolveStop))
    const manager = new DelegatedWebchatHostManager({
      broker,
      brokerSourceRoot,
      runtimeHomeRoot,
      isolationHealthy: () => true,
      randomCellId: () => 'slow-cell',
      hostFactory: () =>
        ({
          start: async () => {},
          stop: () => hostStopGate
        }) as unknown as AcpHost
    })
    const live = await manager.startHost(cellInput('slow-stop'))
    const token = Object.fromEntries(live.adminMcpServer.env.map(({ name, value }) => [name, value])).AC_MCP_TOKEN!
    const attached = net.connect(live.mount.sourceSocketPath)
    attached.setEncoding('utf8')
    await new Promise<void>((resolveConnected) => attached.once('connect', resolveConnected))
    attached.write(encodeFrame({ id: 1, token, op: 'attach' }))
    await new Promise<void>((resolveAttached) => attached.once('data', () => resolveAttached()))
    const attachedClosed = new Promise<void>((resolveClosed) => attached.once('close', resolveClosed))

    let stopped = false
    const stopping = manager
      .stopHost({
        isolationCellId: live.isolationCellId,
        agentId: 'agent-1',
        conversationId: 'slow-stop'
      })
      .then(() => {
        stopped = true
      })
    await attachedClosed
    const rejected = net.connect(live.mount.sourceSocketPath)
    rejected.once('error', () => {})
    await new Promise<void>((resolveClosed) => rejected.once('close', resolveClosed))
    expect(stopped).toBe(false)
    expect(mintMcpInvocation).not.toHaveBeenCalled()

    releaseHostStop()
    await stopping
    expect(broker.getCellMount(live.isolationCellId)).toBeNull()
    expect(existsSync(live.runtimeHome)).toBe(false)
  })

  it('fences host terminal cleanup and never uses daemon-level broker stop per host', async () => {
    let terminal!: () => void
    const stops: string[] = []
    const h = harness({
      hostFactory: (input) => {
        terminal = input.onTerminal
        return fakeHost(input, [], stops)
      }
    })
    const live = await h.manager.startHost(cellInput('terminal'))
    terminal()
    terminal()
    await vi.waitFor(() => expect(h.broker.releases).toHaveLength(1))
    expect(existsSync(live.runtimeHome)).toBe(false)
    expect(h.broker.stop).not.toHaveBeenCalled()
  })

  it('observes exact-cell terminal cleanup even when teardown starts just after waiting', async () => {
    let terminal!: () => void
    let cleanupEntered!: () => void
    const cleanupStarted = new Promise<void>((resolve) => {
      cleanupEntered = resolve
    })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const h = harness({
      hostFactory: (input) => {
        terminal = input.onTerminal
        return fakeHost(input, [], [])
      },
      removeRuntimeHome: async () => {
        cleanupEntered()
        await cleanupGate
      }
    })
    const live = await h.manager.startHost(cellInput('terminal-observer'))

    let observationSettled = false
    const observed = live.waitForCleanup().then(() => {
      observationSettled = true
    })
    queueMicrotask(terminal)
    await cleanupStarted
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(observationSettled).toBe(false)
    releaseCleanup()
    await observed
    expect(h.broker.releases).toHaveLength(1)
  })

  it('ignores a stale terminal callback instead of replacing a newer draining record', async () => {
    const terminals: Array<() => void> = []
    let hostIndex = 0
    let secondStopEntered!: () => void
    const secondStopStarted = new Promise<void>((resolve) => {
      secondStopEntered = resolve
    })
    let releaseSecondStop!: () => void
    const secondStopGate = new Promise<void>((resolve) => {
      releaseSecondStop = resolve
    })
    let cellIndex = 0
    const h = harness({
      randomCellId: () => `cell-${++cellIndex}`,
      hostFactory: (input) => {
        terminals.push(input.onTerminal)
        const currentHost = ++hostIndex
        return {
          start: async () => {},
          stop: async () => {
            if (currentHost !== 2) return
            secondStopEntered()
            await secondStopGate
          }
        } as unknown as AcpHost
      }
    })

    const first = await h.manager.startHost(cellInput('record-cas'))
    await expect(
      h.manager.stopHost({
        isolationCellId: first.isolationCellId,
        agentId: 'agent-1',
        conversationId: 'record-cas'
      })
    ).resolves.toBe(true)
    const second = await h.manager.startHost(
      cellInput('record-cas', {
        delegationId: 'delegation-record-cas-next',
        generation: 2
      })
    )
    const stopping = h.manager.stopHost({
      isolationCellId: second.isolationCellId,
      agentId: 'agent-1',
      conversationId: 'record-cas'
    })
    await secondStopStarted

    terminals[0]!()
    let retrySettled = false
    const retry = h.manager
      .stopHost({
        isolationCellId: second.isolationCellId,
        agentId: 'agent-1',
        conversationId: 'record-cas'
      })
      .then((result) => {
        retrySettled = true
        return result
      })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(retrySettled).toBe(false)

    releaseSecondStop()
    await expect(stopping).resolves.toBe(true)
    await expect(retry).resolves.toBe(true)
    expect(h.manager.debugStats().drainingHosts).toBe(0)
  })

  it('retains failed teardown steps and retries only those steps on the next stop', async () => {
    const broker = new FakeBroker()
    const release = broker.releaseCell.bind(broker)
    let releaseAttempts = 0
    broker.releaseCell = async (input) => {
      releaseAttempts += 1
      if (releaseAttempts === 1) throw new Error('transient release')
      return release(input)
    }
    let hostStopAttempts = 0
    let removeAttempts = 0
    const cleanupEvents: unknown[] = []
    const runtimeHomeRoot = mkdtempSync(join(tmpdir(), 'ac-delegated-retry-'))
    tempRoots.push(runtimeHomeRoot)
    const manager = new DelegatedWebchatHostManager({
      broker,
      brokerSourceRoot: '/trusted/broker',
      runtimeHomeRoot,
      isolationHealthy: () => true,
      removeRuntimeHome: async (path) => {
        removeAttempts += 1
        if (removeAttempts === 1) throw new Error('transient rm')
        rmSync(path, { recursive: true, force: true })
      },
      onCleanupError: (event) => cleanupEvents.push(event),
      hostFactory: () =>
        ({
          start: async () => {},
          stop: async () => {
            hostStopAttempts += 1
            if (hostStopAttempts === 1) throw new Error('transient stop')
          }
        }) as unknown as AcpHost
    })
    const live = await manager.startHost(cellInput('retry'))

    await expect(
      manager.stopHost({
        isolationCellId: live.isolationCellId,
        agentId: 'agent-1',
        conversationId: 'retry'
      })
    ).rejects.toBeInstanceOf(AggregateError)
    expect(manager.debugStats().drainingHosts).toBe(1)
    expect(cleanupEvents).toEqual([
      { source: 'explicit_stop', step: 'host_stop', retryable: true },
      { source: 'explicit_stop', step: 'broker_release', retryable: true },
      { source: 'explicit_stop', step: 'home_remove', retryable: true }
    ])
    expect(JSON.stringify(cleanupEvents)).not.toMatch(/delegation-retry|trusted|transient/i)

    await expect(manager.stop()).resolves.toBeUndefined()
    expect(hostStopAttempts).toBe(2)
    expect(releaseAttempts).toBe(2)
    expect(removeAttempts).toBe(2)
    expect(existsSync(live.runtimeHome)).toBe(false)
    expect(manager.debugStats().drainingHosts).toBe(0)
  })

  it('contains disconnect cleanup rejection without an unhandled promise', async () => {
    const cleanupEvents: unknown[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const h = harness({
        hostFactory: () =>
          ({
            start: async () => {},
            stop: async () => {
              throw new Error('secret cleanup failure')
            }
          }) as unknown as AcpHost
      })
      ;(h.manager as any).deps.onCleanupError = (event: unknown) => cleanupEvents.push(event)
      const live = await h.manager.startHost(cellInput('disconnect-failure'))
      h.broker.disconnect({
        isolationCellId: live.isolationCellId,
        agentId: 'agent-1',
        conversationId: 'disconnect-failure',
        delegationId: 'delegation-disconnect-failure',
        generation: 1
      })
      await vi.waitFor(() => expect(cleanupEvents).toHaveLength(1))
      await new Promise((resolveTick) => setTimeout(resolveTick, 0))
      expect(unhandled).toEqual([])
      expect(cleanupEvents).toEqual([{ source: 'bridge_disconnect', step: 'host_stop', retryable: true }])
      expect(JSON.stringify(cleanupEvents)).not.toMatch(/disconnect-failure|secret cleanup|agent-1/i)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
