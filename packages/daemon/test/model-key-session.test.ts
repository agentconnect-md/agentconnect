import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { Daemon } from '../src/daemon.js'

function harness(grants: Array<Record<string, unknown>>) {
  const clock = new FakeClock(1_000)
  const issue = vi.fn(async () => grants.shift())
  const revoke = vi.fn(async () => {})
  const daemon = new Daemon({ k8s: true, clock, keyServerClient: { issue, revoke } as never })
  const firstHost = { start: vi.fn(), stop: vi.fn(async () => {}) }
  const secondHost = { start: vi.fn(), stop: vi.fn(async () => {}) }
  const starts = vi.fn().mockResolvedValueOnce(firstHost).mockResolvedValueOnce(secondHost)
  ;(daemon as any).runtimes = { claude: { command: 'claude-agent-acp', args: [], env: [] } }
  ;(daemon as any).cpAgents = { orgForAgent: () => 'org-a' }
  ;(daemon as any).store = { getSession: () => undefined, getModelOverride: () => undefined }
  ;(daemon as any).startModelSessionRuntime = starts
  return { clock, daemon: daemon as any, issue, revoke, starts, firstHost, secondHost }
}

const agent = { id: 'agent-a', runtime: 'claude' }

describe('daemon model-key session lifecycle', () => {
  it('accepts key-server configuration only in cloud mode', () => {
    expect(() => new Daemon({ keyServerClient: {} as never })).toThrow(/only by cloud daemons/)
    expect(() => new Daemon({ k8s: true, keyServerTokenPath: '/token' })).toThrow(/requires key-server/)
  })

  it('issues once per logical session, caches the host, and revokes on release', async () => {
    const h = harness([{ keyId: 'key-1', key: 'secret', requestedAtMs: 1_000 }])
    const first = await h.daemon.ensureModelSessionHost(agent, 'slack:C:T:agent-a')
    const second = await h.daemon.ensureModelSessionHost(agent, 'slack:C:T:agent-a')

    expect(first.host).toBe(h.firstHost)
    expect(second.host).toBe(h.firstHost)
    expect(h.issue).toHaveBeenCalledOnce()
    expect(h.issue).toHaveBeenCalledWith({
      orgId: 'org-a',
      agentId: 'agent-a',
      sessionId: createHash('sha256').update('slack:C:T:agent-a').digest('hex'),
      provider: 'anthropic',
      ttlSeconds: 3_600
    })

    await h.daemon.releaseModelSessionHost('slack:C:T:agent-a')
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
    expect(h.revoke).toHaveBeenCalledWith('key-1')
  })

  it('rotates the runtime and revokes the superseded issuance at refresh time', async () => {
    const h = harness([
      { keyId: 'key-1', key: 'old', requestedAtMs: 1_000, refreshAtMs: 2_000, expiresAtMs: 4_000 },
      { keyId: 'key-2', key: 'new', requestedAtMs: 2_000, refreshAtMs: 3_000, expiresAtMs: 5_000 }
    ])
    await h.daemon.ensureModelSessionHost(agent, 'session-a')
    h.clock.advance(1_000)
    const rotated = await h.daemon.ensureModelSessionHost(agent, 'session-a')

    expect(rotated.host).toBe(h.secondHost)
    expect(h.issue).toHaveBeenCalledTimes(2)
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
    expect(h.revoke).toHaveBeenCalledWith('key-1')
  })

  it('defers a non-expired refresh until live SDK work becomes quiescent', async () => {
    const h = harness([
      { keyId: 'key-1', key: 'old', requestedAtMs: 1_000, refreshAtMs: 2_000, expiresAtMs: 4_000 },
      { keyId: 'key-2', key: 'new', requestedAtMs: 2_000, refreshAtMs: 3_000, expiresAtMs: 5_000 }
    ])
    await h.daemon.ensureModelSessionHost(agent, 'session-a')
    h.daemon.store.getSession = () => ({ acpSessionId: 'acp-1' })
    h.daemon.sdkLease.set(JSON.stringify(['agent-a', 'acp-1']), {
      agentId: 'agent-a',
      tasks: new Map([['task-1', {}]]),
      settled: [],
      sdkState: 'idle',
      bgWakes: 0,
      armedWakes: 0,
      deliveringWakes: 0
    })
    h.clock.advance(1_000)

    const deferred = await h.daemon.ensureModelSessionHost(agent, 'session-a')
    expect(deferred.host).toBe(h.firstHost)
    expect(h.issue).toHaveBeenCalledOnce()
    expect(h.firstHost.stop).not.toHaveBeenCalled()

    h.daemon.sdkLease.clear()
    const rotated = await h.daemon.ensureModelSessionHost(agent, 'session-a')
    expect(rotated.host).toBe(h.secondHost)
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
  })

  it('keeps a working host on its start-time credential past expiry', async () => {
    const h = harness([
      { keyId: 'key-1', key: 'old', requestedAtMs: 1_000, refreshAtMs: 1_500, expiresAtMs: 2_000 },
      { keyId: 'key-2', key: 'new', requestedAtMs: 2_000 }
    ])
    await h.daemon.ensureModelSessionHost(agent, 'session-a')
    h.daemon.store.getSession = () => ({ acpSessionId: 'acp-1' })
    h.daemon.sdkLease.set(JSON.stringify(['agent-a', 'acp-1']), {
      agentId: 'agent-a',
      tasks: new Map([['task-1', {}]]),
      settled: [],
      sdkState: 'idle',
      bgWakes: 0,
      armedWakes: 0,
      deliveringWakes: 0
    })
    h.clock.advance(1_000)

    const pinned = await h.daemon.ensureModelSessionHost(agent, 'session-a')
    expect(pinned.host).toBe(h.firstHost)
    expect(h.issue).toHaveBeenCalledOnce()
    expect(h.firstHost.stop).not.toHaveBeenCalled()
  })

  it('pins a working host to its provider and applies the switch at the next start', async () => {
    const h = harness([
      { keyId: 'key-1', key: 'secret', requestedAtMs: 1_000 },
      { keyId: 'key-2', key: 'next', requestedAtMs: 1_000 }
    ])
    const opencodeAgent = {
      id: 'agent-a',
      runtime: 'opencode',
      allowRuntimeChangesInChat: true,
      runtimeOverrides: { model: 'openai/gpt-5', env: [], secrets: [] }
    }
    h.daemon.runtimes = { opencode: { command: 'opencode', args: ['acp'], env: [] } }
    h.daemon.store.getModelOverride = () => 'anthropic/claude-opus-4'
    h.daemon.agents.set('agent-a', opencodeAgent)

    await h.daemon.ensureModelSessionHost(opencodeAgent, 'session-a')
    expect(h.issue).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }))

    // Live SDK work: the switch is recorded, but the running host keeps its binding.
    h.daemon.store.getSession = () => ({ agentId: 'agent-a', acpSessionId: 'acp-1' })
    h.daemon.sdkLease.set(JSON.stringify(['agent-a', 'acp-1']), {
      agentId: 'agent-a',
      tasks: new Map([['task-1', {}]]),
      settled: [],
      sdkState: 'idle',
      bgWakes: 0,
      armedWakes: 0,
      deliveringWakes: 0
    })
    const setModelOverride = vi.fn()
    h.daemon.store.setModelOverride = setModelOverride
    expect(h.daemon.setModelByKey('session-a', 'openai/gpt-5')).toBe(true)
    expect(setModelOverride).toHaveBeenCalledWith('session-a', 'openai/gpt-5')

    h.daemon.store.getModelOverride = () => 'openai/gpt-5'
    const pinned = await h.daemon.ensureModelSessionHost(opencodeAgent, 'session-a')
    expect(pinned.host).toBe(h.firstHost)
    expect(h.issue).toHaveBeenCalledOnce()

    // Once the work settles, the next start honours the recorded provider.
    h.daemon.sdkLease.clear()
    const rebound = await h.daemon.ensureModelSessionHost(opencodeAgent, 'session-a')
    expect(rebound.host).toBe(h.secondHost)
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
    expect(h.issue).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'openai' }))
  })

  it('refuses a cross-provider switch on the shared static-credential host', () => {
    const daemon = new Daemon({ k8s: true, clock: new FakeClock(1_000) }) as any
    daemon.staticModelCredential = { key: 'static-token' }
    const opencodeAgent = {
      id: 'agent-a',
      runtime: 'opencode',
      allowRuntimeChangesInChat: true,
      runtimeOverrides: { model: 'openai/gpt-5', env: [], secrets: [] }
    }
    daemon.runtimes = { opencode: { command: 'opencode', args: ['acp'], env: [] } }
    daemon.agents.set('agent-a', opencodeAgent)
    const setModelOverride = vi.fn()
    daemon.store = { getSession: () => ({ agentId: 'agent-a', acpSessionId: null }), setModelOverride }

    expect(daemon.setModelByKey('session-a', 'anthropic/claude-opus-4')).toBe(false)
    expect(setModelOverride).not.toHaveBeenCalled()
    expect(daemon.setModelByKey('session-a', 'openai/gpt-5-codex')).toBe(true)
    expect(setModelOverride).toHaveBeenCalledWith('session-a', 'openai/gpt-5-codex')
  })

  it('stops a host started after its entry was released', async () => {
    const h = harness([{ keyId: 'key-1', key: 'secret', requestedAtMs: 1_000 }])
    let settleStart: (host: unknown) => void = () => {}
    h.daemon.startModelSessionRuntime = vi.fn(() => new Promise((resolve) => (settleStart = resolve)))

    const starting = h.daemon.ensureModelSessionHost(agent, 'session-a')
    await vi.waitFor(() => expect(h.daemon.startModelSessionRuntime).toHaveBeenCalled())
    const released = h.daemon.releaseModelSessionHost('session-a')
    settleStart(h.firstHost)

    await expect(starting).rejects.toThrow(/released during startup/)
    await released
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
    expect(h.revoke).toHaveBeenCalledWith('key-1')
  })
})
