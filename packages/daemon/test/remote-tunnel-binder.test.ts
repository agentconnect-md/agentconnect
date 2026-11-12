import { describe, expect, it, vi } from 'vitest'
import { TunnelBinder, type TunnelSession } from '../src/remote/tunnel-binder.js'
import { daemonTunnelSocketPath } from '../src/remote/tunnel-sockets.js'
import { TunnelNameSchema, type TunnelName } from '../src/shim/tunnel.js'

const log = { info: () => {}, warn: () => {}, debug: () => {} }

/** A bound channel of a given incarnation, and the proxy teardown it observed. */
function fakeSession(generation: number) {
  const request = vi.fn(async () => ({ socketPath: '/pod/agent.sock' }))
  const offEvent = vi.fn()
  const session = {
    agentId: 'agent-a',
    generation,
    request,
    onEvent: vi.fn(),
    offEvent,
    onAttach: vi.fn(),
    offAttach: vi.fn(),
    onLost: vi.fn()
  }
  return { session: session as unknown as TunnelSession, request, offEvent }
}

function binder() {
  return new TunnelBinder({ tunnelsFor: () => ['agent'], tunnelSocketPath: () => '/daemon/agent.sock', log })
}

describe('tunnel binder', () => {
  it('opens the wanted tunnels on the session that bound', async () => {
    const { session, request } = fakeSession(1)
    await binder().ensure('agent-a', session)

    expect(request).toHaveBeenCalledWith('tunnel', { op: 'listen', tunnel: 'agent', acks: true })
  })

  it('opens a session pod’s tunnels by its agent’s policy, so a watcher armed there can fetch its token', async () => {
    const tunnelsFor = vi.fn(() => ['agent' as const])
    const { session, request } = fakeSession(1)
    await new TunnelBinder({ tunnelsFor, tunnelSocketPath: () => '/daemon/agent.sock', log }).ensure(
      'agent-a/session-0123',
      session
    )

    expect(tunnelsFor).toHaveBeenCalledWith('agent-a', 'agent-a/session-0123')
    expect(request).toHaveBeenCalledWith('tunnel', { op: 'listen', tunnel: 'agent', acks: true })
  })

  it('keeps one proxy per agent across preparations of the same launch', async () => {
    const subject = binder()
    const { session, request } = fakeSession(1)
    await subject.ensure('agent-a', session)
    await subject.ensure('agent-a', session)

    // The listen is idempotent on the pod, but repeating it would cost a round trip per launch.
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('replaces the proxy when a new launch binds, because its streams belong to the old pod', async () => {
    const subject = binder()
    const first = fakeSession(1)
    const second = fakeSession(2)
    await subject.ensure('agent-a', first.session)
    await subject.ensure('agent-a', second.session)

    expect(first.offEvent).toHaveBeenCalled()
    expect(second.request).toHaveBeenCalledWith('tunnel', { op: 'listen', tunnel: 'agent', acks: true })
  })

  it('opens nothing when the daemon serves no socket for the tunnel', async () => {
    const { session, request } = fakeSession(1)
    await new TunnelBinder({ tunnelsFor: () => ['agent'], log }).ensure('agent-a', session)

    expect(request).not.toHaveBeenCalled()
  })

  it('records on the binding whether the pod serves a tunnel', async () => {
    const subject = binder()
    const { session } = fakeSession(1)
    expect(subject.serves('agent-a', 'agent')).toBe(false)
    await subject.ensure('agent-a', session)
    expect(subject.serves('agent-a', 'agent')).toBe(true)
    expect(subject.serves('agent-a', 'mcp')).toBe(false)
    subject.release('agent-a', 'gone')
    expect(subject.serves('agent-a', 'agent')).toBe(false)
  })

  it('stops the agent proxy when the launch is no longer served here', async () => {
    const subject = binder()
    const { session, offEvent } = fakeSession(1)
    await subject.ensure('agent-a', session)
    subject.release('agent-a', 'agent no longer served here')

    expect(offEvent).toHaveBeenCalled()
  })

  it('dials a session’s codehost tunnel at its own agent’s socket, and asks with that agent’s routes', async () => {
    const { session, request } = fakeSession(1)
    request.mockResolvedValue({
      socketPath: '127.0.0.1:4100',
      proxy: { port: 4100, token: 't'.repeat(32), trustBundle: '/rt/codehost-trust.pem' }
    } as never)
    const tunnelSocketPath = vi.fn((tunnel: string, agentId: string) => `/daemon/${tunnel}/${agentId}.sock`)
    const subject = new TunnelBinder({
      tunnelsFor: () => ['codehost'],
      tunnelSocketPath,
      tunnelListenOptions: (agentId, tunnel) =>
        tunnel === 'codehost' ? { routes: [`${agentId}.example.test:443`], ca: 'example certificate' } : undefined,
      log
    })
    await subject.ensure('agent-a/session-0123', session)

    expect(tunnelSocketPath).toHaveBeenCalledWith('codehost', 'agent-a')
    expect(request).toHaveBeenCalledWith('tunnel', {
      op: 'listen',
      tunnel: 'codehost',
      routes: ['agent-a.example.test:443'],
      ca: 'example certificate',
      acks: true
    })
    expect(subject.listeningAt('agent-a/session-0123', 'codehost')?.proxy?.port).toBe(4100)
  })

  it('hands out a codehost listener only once the pod forwards the routes asked for, sending stale routes again first', async () => {
    const { session, request } = fakeSession(1)
    request.mockResolvedValue({
      socketPath: '127.0.0.1:4100',
      proxy: { port: 4100, token: 't'.repeat(32), trustBundle: '/rt/codehost-trust.pem' }
    } as never)
    let routes = ['github.com:443']
    const subject = new TunnelBinder({
      tunnelsFor: () => ['codehost'],
      tunnelSocketPath: () => '/daemon/codehost.sock',
      tunnelListenOptions: (_agentId, tunnel) =>
        tunnel === 'codehost' ? { routes, ca: 'example certificate' } : undefined,
      log
    })
    await subject.ensure('agent-a', session)
    const skill = ['gitlab.example.test:443']
    // Bound before the skill source was enabled, and not asked again: its listener does not forward the instance.
    expect(await subject.routedListener('agent-a', undefined, 'codehost', skill)).toBeUndefined()
    routes = ['github.com:443', 'gitlab.example.test:443']
    expect((await subject.routedListener('agent-a', session, 'codehost', skill))?.port).toBe(4100)
    expect(request).toHaveBeenLastCalledWith('tunnel', expect.objectContaining({ routes }))
    // A re-listen the pod refuses leaves the stale routes, so the source is not handed the listener.
    routes = ['github.com:443', 'gitlab.example.test:443', 'code.example.test:443']
    request.mockRejectedValueOnce(new Error('listen refused'))
    expect(await subject.routedListener('agent-a', session, 'codehost', ['code.example.test:443'])).toBeUndefined()
    expect(await subject.routedListener('agent-a', undefined, 'codehost', [])).toBeUndefined()
  })

  it('stops every proxy when the plane goes down', async () => {
    const subject = binder()
    const first = fakeSession(1)
    await subject.ensure('agent-a', first.session)
    subject.releaseAll('daemon is shutting down')

    expect(first.offEvent).toHaveBeenCalled()
  })
})

describe('the daemon socket each tunnel reaches', () => {
  const sockets = {
    agent: '/daemon/agent.sock',
    mcp: '/daemon/mcp.sock',
    codehost: (agentId: string) => `/daemon/codehost/${agentId}.sock`,
    provider: (agentId: string) => `/daemon/provider/${agentId}.sock`
  }

  it('names every tunnel explicitly, each its own socket', () => {
    const paths = TunnelNameSchema.options.map((tunnel) => daemonTunnelSocketPath(tunnel, 'agent-a', sockets))
    expect(paths).toEqual([
      '/daemon/agent.sock',
      '/daemon/mcp.sock',
      '/daemon/codehost/agent-a.sock',
      '/daemon/provider/agent-a.sock'
    ])
    expect(new Set(paths).size).toBe(TunnelNameSchema.options.length)
  })

  it('dials nothing for a name it does not know, rather than a plausible socket', () => {
    expect(daemonTunnelSocketPath('other' as TunnelName, 'agent-a', sockets)).toBeUndefined()
    expect(daemonTunnelSocketPath('codehost', 'agent-b', { ...sockets, codehost: () => undefined })).toBeUndefined()
    expect(daemonTunnelSocketPath('provider', 'agent-b', { ...sockets, provider: () => undefined })).toBeUndefined()
  })
})
