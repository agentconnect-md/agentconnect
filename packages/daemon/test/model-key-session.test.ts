import { sessionHostKey } from '../src/acp/host-key.js'
import { sdkLeaseKey } from '../src/daemon/turn-types.js'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { Daemon } from '../src/daemon.js'
import { offClusterPlaintext } from '../src/key-server/session-hosts.js'

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
  ;(daemon as any).store = {
    getSession: () => undefined,
    getModelOverride: () => undefined,
    // The credential names the session by its outward id, minted here on first use.
    ensureOutwardSessionId: async (key: string) => `outward-of-${key}`
  }
  ;(daemon as any).startModelSessionRuntime = starts
  return { clock, daemon: daemon as any, issue, revoke, starts, firstHost, secondHost }
}

const agent = { id: 'agent-a', runtime: 'claude' }

describe('daemon model-key session lifecycle', () => {
  it('refuses a key server outside cloud mode, and never demands a token path', () => {
    // A minted key is only usable with the `*_MODEL_BASE_URL` pair that aims it at this install's
    // gateway, and that pair is cloud-mode configuration — so a non-cloud key server is refused.
    // Its credential is a separate question: with or without a token path, both directions are a
    // warning rather than a refusal to start a daemon whose every other agent is fine.
    expect(() => new Daemon({ keyServerClient: {} as never })).toThrow(/--k8s/)
    expect(() => new Daemon({ k8s: true, keyServerClient: {} as never })).not.toThrow()
    expect(() => new Daemon({ k8s: true, keyServerTokenPath: '/token' })).not.toThrow()
    expect(() => new Daemon({ keyServerTokenPath: '/token' })).not.toThrow()
  })

  it('issues once per logical session, caches the host, and revokes on release', async () => {
    const h = harness([{ keyId: 'key-1', key: 'secret', requestedAtMs: 1_000 }])
    const first = await h.daemon.modelSessions.ensure(agent, 'slack:C:T:agent-a')
    const second = await h.daemon.modelSessions.ensure(agent, 'slack:C:T:agent-a')

    expect(first.host).toBe(h.firstHost)
    expect(second.host).toBe(h.firstHost)
    expect(h.issue).toHaveBeenCalledOnce()
    expect(h.issue).toHaveBeenCalledWith({
      orgId: 'org-a',
      agentId: 'agent-a',
      sessionId: 'outward-of-slack:C:T:agent-a',
      provider: 'anthropic',
      ttlSeconds: 3_600
    })

    await h.daemon.modelSessions.release('slack:C:T:agent-a')
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
    expect(h.revoke).toHaveBeenCalledWith('key-1')
  })

  it('rotates the runtime and revokes the superseded issuance at refresh time', async () => {
    const h = harness([
      { keyId: 'key-1', key: 'old', requestedAtMs: 1_000, refreshAtMs: 2_000, expiresAtMs: 4_000 },
      { keyId: 'key-2', key: 'new', requestedAtMs: 2_000, refreshAtMs: 3_000, expiresAtMs: 5_000 }
    ])
    await h.daemon.modelSessions.ensure(agent, 'session-a')
    h.clock.advance(1_000)
    const rotated = await h.daemon.modelSessions.ensure(agent, 'session-a')

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
    await h.daemon.modelSessions.ensure(agent, 'session-a')
    h.daemon.store.getSession = () => ({ acpSessionId: 'acp-1' })
    h.daemon.sdkLease.set(sdkLeaseKey(sessionHostKey('agent-a', 'session-a'), 'acp-1'), {
      agentId: 'agent-a',
      tasks: new Map([['task-1', {}]]),
      settled: [],
      sdkState: 'idle',
      bgWakes: 0,
      armedWakes: 0,
      deliveringWakes: 0
    })
    h.clock.advance(1_000)

    const deferred = await h.daemon.modelSessions.ensure(agent, 'session-a')
    expect(deferred.host).toBe(h.firstHost)
    expect(h.issue).toHaveBeenCalledOnce()
    expect(h.firstHost.stop).not.toHaveBeenCalled()

    h.daemon.sdkLease.clear()
    const rotated = await h.daemon.modelSessions.ensure(agent, 'session-a')
    expect(rotated.host).toBe(h.secondHost)
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
  })

  it('keeps a working host on its start-time credential past expiry', async () => {
    const h = harness([
      { keyId: 'key-1', key: 'old', requestedAtMs: 1_000, refreshAtMs: 1_500, expiresAtMs: 2_000 },
      { keyId: 'key-2', key: 'new', requestedAtMs: 2_000 }
    ])
    await h.daemon.modelSessions.ensure(agent, 'session-a')
    h.daemon.store.getSession = () => ({ acpSessionId: 'acp-1' })
    h.daemon.sdkLease.set(sdkLeaseKey(sessionHostKey('agent-a', 'session-a'), 'acp-1'), {
      agentId: 'agent-a',
      tasks: new Map([['task-1', {}]]),
      settled: [],
      sdkState: 'idle',
      bgWakes: 0,
      armedWakes: 0,
      deliveringWakes: 0
    })
    h.clock.advance(1_000)

    const pinned = await h.daemon.modelSessions.ensure(agent, 'session-a')
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

    await h.daemon.modelSessions.ensure(opencodeAgent, 'session-a')
    expect(h.issue).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }))

    // Live SDK work: the switch is recorded, but the running host keeps its binding.
    h.daemon.store.getSession = () => ({ agentId: 'agent-a', acpSessionId: 'acp-1' })
    h.daemon.sdkLease.set(sdkLeaseKey(sessionHostKey('agent-a', 'session-a'), 'acp-1'), {
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
    expect(await h.daemon.commands.setModelByKey('session-a', 'openai/gpt-5')).toBe(true)
    expect(setModelOverride).toHaveBeenCalledWith('session-a', 'openai/gpt-5')

    h.daemon.store.getModelOverride = () => 'openai/gpt-5'
    const pinned = await h.daemon.modelSessions.ensure(opencodeAgent, 'session-a')
    expect(pinned.host).toBe(h.firstHost)
    expect(h.issue).toHaveBeenCalledOnce()

    // Once the work settles, the next start honours the recorded provider.
    h.daemon.sdkLease.clear()
    const rebound = await h.daemon.modelSessions.ensure(opencodeAgent, 'session-a')
    expect(rebound.host).toBe(h.secondHost)
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
    expect(h.issue).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'openai' }))
  })

  it('refuses a cross-provider switch on the shared static-credential host', async () => {
    const daemon = new Daemon({ k8s: true, clock: new FakeClock(1_000) }) as any
    daemon.modelSessions.staticModelCredentials = { opencode: { key: 'static-token' } }
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

    expect(await daemon.commands.setModelByKey('session-a', 'anthropic/claude-opus-4')).toBe(false)
    expect(setModelOverride).not.toHaveBeenCalled()
    expect(await daemon.commands.setModelByKey('session-a', 'openai/gpt-5-codex')).toBe(true)
    expect(setModelOverride).toHaveBeenCalledWith('session-a', 'openai/gpt-5-codex')
  })

  it('leaves a runtime the static map never configured switchable', async () => {
    const daemon = new Daemon({ k8s: true, clock: new FakeClock(1_000) }) as any
    daemon.modelSessions.staticModelCredentials = { claude: { key: 'static-token' } }
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

    // The map configures no opencode pair, so this host runs on runtime-owned auth and stays switchable.
    expect(await daemon.commands.setModelByKey('session-a', 'anthropic/claude-opus-4')).toBe(true)
    expect(setModelOverride).toHaveBeenCalledWith('session-a', 'anthropic/claude-opus-4')
  })

  it('reads the deployment base URLs even when a key server is configured', () => {
    const env = process.env.ANTHROPIC_MODEL_BASE_URL
    process.env.ANTHROPIC_MODEL_BASE_URL = 'https://gw.example'
    try {
      const withServer = new Daemon({ k8s: true, keyServer: 'https://keys.test', clock: new FakeClock(1_000) }) as any
      expect(withServer.modelSessions.staticModelCredentials.claude).toEqual({ key: '', baseUrl: 'https://gw.example' })
      // The issuer owns the key; where it is sent is the deployment's, so a grant URL is not read.
      expect(withServer.modelSessions.staticBaseUrl({ provider: 'anthropic', runtime: 'claude' })).toEqual({
        baseUrl: 'https://gw.example'
      })
    } finally {
      if (env === undefined) delete process.env.ANTHROPIC_MODEL_BASE_URL
      else process.env.ANTHROPIC_MODEL_BASE_URL = env
    }
  })

  it('revokes the fresh grant when replacing the superseded host fails', async () => {
    const h = harness([
      { keyId: 'key-1', key: 'old', requestedAtMs: 1_000, refreshAtMs: 2_000 },
      { keyId: 'key-2', key: 'new', requestedAtMs: 2_000 }
    ])
    await h.daemon.modelSessions.ensure(agent, 'session-a')
    h.firstHost.stop.mockRejectedValueOnce(new Error('stop refused'))
    h.clock.advance(1_000)

    await expect(h.daemon.modelSessions.ensure(agent, 'session-a')).rejects.toThrow(/stop refused/)
    await vi.waitFor(() => expect(h.revoke).toHaveBeenCalledWith('key-2'))
    expect(h.revoke).not.toHaveBeenCalledWith('key-1')
    // The old entry keeps owning both key-1 and the host whose stop rejected, so teardown
    // gives the key back AND retries the kill rather than losing the process.
    expect(h.daemon.modelSessions.entries.get('session-a').host).toBe(h.firstHost)
    await h.daemon.modelSessions.release('session-a')
    expect(h.revoke).toHaveBeenCalledWith('key-1')
    expect(h.firstHost.stop).toHaveBeenCalledTimes(2)
    expect(h.daemon.modelSessions.entries.has('session-a')).toBe(false)
  })

  it('retains a host whose stop rejected during release and retries the kill', async () => {
    const h = harness([
      { keyId: 'key-1', key: 'secret', requestedAtMs: 1_000 },
      { keyId: 'key-2', key: 'next', requestedAtMs: 1_000 }
    ])
    await h.daemon.modelSessions.ensure(agent, 'session-a')
    h.firstHost.stop.mockRejectedValueOnce(new Error('stop refused'))

    await expect(h.daemon.modelSessions.release('session-a')).rejects.toThrow(/stop refused/)
    expect(h.revoke).toHaveBeenCalledWith('key-1')
    // Retained rather than lost — but never handed back out, since its key is already revoked.
    expect(h.daemon.modelSessions.entries.get('session-a').host).toBe(h.firstHost)

    const next = await h.daemon.modelSessions.ensure(agent, 'session-a')
    expect(h.firstHost.stop).toHaveBeenCalledTimes(2)
    expect(next.host).toBe(h.secondHost)
    expect(h.issue).toHaveBeenCalledTimes(2)
  })

  it('stops a host started after its entry was released', async () => {
    const h = harness([{ keyId: 'key-1', key: 'secret', requestedAtMs: 1_000 }])
    let settleStart: (host: unknown) => void = () => {}
    h.daemon.startModelSessionRuntime = vi.fn(() => new Promise((resolve) => (settleStart = resolve)))

    const starting = h.daemon.modelSessions.ensure(agent, 'session-a')
    await vi.waitFor(() => expect(h.daemon.startModelSessionRuntime).toHaveBeenCalled())
    const released = h.daemon.modelSessions.release('session-a')
    settleStart(h.firstHost)

    await expect(starting).rejects.toThrow(/released during startup/)
    await released
    expect(h.firstHost.stop).toHaveBeenCalledOnce()
    expect(h.revoke).toHaveBeenCalledWith('key-1')
  })
})

describe('the plaintext key-server warning', () => {
  it('says nothing for TLS, and nothing for the in-cluster shapes a deployment actually writes', () => {
    // The scheme is the deployment's to choose, so this is a warning about ONE case — a bearer
    // crossing something that is not obviously the cluster — not a rule about schemes.
    for (const address of [
      'https://keys.example.com',
      'https://hub.agentconnect-test.svc:8080',
      'http://test-agentconnect-aigw-hub:8080',
      'http://test-agentconnect-aigw-hub.agentconnect-test:8080',
      'http://test-agentconnect-aigw-hub.agentconnect-test.svc:8080',
      'http://test-agentconnect-aigw-hub.agentconnect-test.svc.cluster.local:8080',
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
      'http://10.96.3.4:8080',
      'http://172.20.0.5:8080',
      'http://192.168.1.9:8080',
      'http://100.72.4.1:8080'
    ]) {
      expect(offClusterPlaintext(address), address).toBe(false)
    }
  })

  it('warns for plaintext to a name that is not cluster-shaped', () => {
    for (const address of [
      'http://keys.example.com',
      'http://keys.example.com:8080',
      'http://a.b.c',
      'http://203.0.113.5:8080',
      'http://172.32.0.5:8080'
    ]) {
      expect(offClusterPlaintext(address), address).toBe(true)
    }
  })

  it('says nothing about an address it cannot parse — the client already refuses that', () => {
    expect(offClusterPlaintext('not a url')).toBe(false)
  })
})
