import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DelegatedWebchatHostManager,
  type DelegatedWebchatHostFactoryInput
} from '../src/acp/delegated-webchat-host-manager.js'
import type { AcpHost } from '../src/acp/acp-host.js'
import type {
  RegisterSessionMcpCell,
  ReleaseSessionMcpCell,
  SessionMcpBridgeDisconnected,
  SessionMcpCellMount
} from '../src/mcp/session-mcp-broker.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = realpathSync(resolve(here, '../../..'))
const tempRoots: string[] = []
const expiresAt = new Date(Date.now() + 60_000).toISOString()

afterEach(() => {
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
      targetDirectory: '/run/agentconnect-admin'
    }
    this.mounts.set(input.isolationCellId, mount)
    return {
      name: 'agentconnect-admin',
      command: 'agentconnect',
      args: ['mcp-bridge', '--lazy-tools'],
      env: [
        { name: 'AC_MCP_ENDPOINT', value: '/run/agentconnect-admin/mcp.sock' },
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
    hostFactory: (input) => {
      factoryInputs.push(input)
      return overrides.hostFactory?.(input) ?? fakeHost(input, starts, stops)
    }
  })
  return { manager, broker, starts, stops, factoryInputs }
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
          maskedReadRoots: ['/trusted/broker'],
          delegatedCellMount: {
            maskedRoot: '/trusted/broker',
            sourceDir: a.mount.sourceDirectory,
            targetDir: a.mount.targetDirectory
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
})
