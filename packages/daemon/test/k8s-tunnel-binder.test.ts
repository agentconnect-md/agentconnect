import { describe, expect, it, vi } from 'vitest'
import { TunnelBinder, type TunnelSession } from '../src/shim/tunnel-binder.js'

const log = { info: () => {}, warn: () => {}, debug: () => {} }

/** A bound channel of a given incarnation, and the proxy teardown it observed. */
function fakeSession(generation: number) {
  const request = vi.fn(async () => ({ socketPath: '/pod/gitcred.sock' }))
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
  return new TunnelBinder({ tunnelsFor: () => ['gitcred'], tunnelSocketPath: () => '/daemon/gitcred.sock', log })
}

describe('tunnel binder', () => {
  it('opens the wanted tunnels on the session that bound', async () => {
    const { session, request } = fakeSession(1)
    await binder().ensure('agent-a', session)

    expect(request).toHaveBeenCalledWith('tunnel', { op: 'listen', tunnel: 'gitcred' })
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
    expect(second.request).toHaveBeenCalledWith('tunnel', { op: 'listen', tunnel: 'gitcred' })
  })

  it('opens nothing when the daemon serves no socket for the tunnel', async () => {
    const { session, request } = fakeSession(1)
    await new TunnelBinder({ tunnelsFor: () => ['gitcred'], log }).ensure('agent-a', session)

    expect(request).not.toHaveBeenCalled()
  })

  it('stops the agent proxy when the launch is no longer served here', async () => {
    const subject = binder()
    const { session, offEvent } = fakeSession(1)
    await subject.ensure('agent-a', session)
    subject.release('agent-a', 'agent no longer served here')

    expect(offEvent).toHaveBeenCalled()
  })

  it('stops every proxy when the plane goes down', async () => {
    const subject = binder()
    const first = fakeSession(1)
    await subject.ensure('agent-a', first.session)
    subject.releaseAll('daemon is shutting down')

    expect(first.offEvent).toHaveBeenCalled()
  })
})
