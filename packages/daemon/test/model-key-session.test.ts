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
  ;(daemon as any).store = { getSession: () => undefined }
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
})
