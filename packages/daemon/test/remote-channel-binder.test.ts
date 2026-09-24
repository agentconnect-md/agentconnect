import { describe, expect, it, vi } from 'vitest'
import { FakeClock, type Clock } from '@agentconnect.md/connection'
import { ChannelBinder } from '../src/remote/channel-binder.js'
import { LaunchRegistry } from '../src/remote/launch-registry.js'
import { noopClusterMetrics } from '../src/metrics/cluster-metrics.js'
import { fakeGenerations } from './fake-generations.js'
import { LaunchTimeoutError, type ShimEndpointProvider } from '../src/remote/shim-endpoint.js'
import type { ShimConnection } from '../src/shim/connection.js'

const log = { info: () => {}, warn: () => {}, debug: () => {} }

/** Enough of a bound channel for the binder to attach a session to. */
function stubConnection(generation: number, workspaceRoot?: string): ShimConnection {
  return {
    binding: { agentId: 'agent-a', generation, grants: ['acp'], podName: 'p', podUid: 'u' },
    issuedCredential: 'cred',
    ...(workspaceRoot ? { workspaceRoot } : {}),
    send: () => {},
    onFrame: () => {},
    close: () => {}
  } as unknown as ShimConnection
}

/** An endpoint that is already up, so resolving it costs the bind nothing. */
const endpoints: ShimEndpointProvider = {
  resolve: async () => ({ address: '10.0.0.8', peer: { name: 'p', proof: 'pod' as const } }),
  retain: () => {},
  release: () => {}
}

function binder(
  registry: LaunchRegistry,
  clock: FakeClock,
  connectChannel: () => Promise<ShimConnection> = async () => {
    throw new Error('the bind must not reach the pod')
  }
) {
  return new ChannelBinder({
    registry,
    endpoints,
    clock,
    log,
    metrics: noopClusterMetrics,
    channelTimeoutMs: 1_000,
    connectChannel
  })
}

async function withLaunch() {
  const clock = new FakeClock()
  const registry = new LaunchRegistry({ generations: fakeGenerations(), clock })
  return { clock, registry, launch: await registry.recordLaunch('agent-a', 'sandbox-uid-1', {}) }
}

describe('cluster channel binder', () => {
  it('refuses a launch the registry no longer holds, before waking its pod', async () => {
    // The release fence only catches a release that lands DURING the bind. One that landed while
    // the caller was still awaiting its launch is already in the snapshot, so both fence checks
    // pass — and a departed member would wake and bind a pod that is no longer its to serve.
    const { clock, registry, launch } = await withLaunch()
    registry.bumpRelease('agent-a')
    registry.forgetLaunch('agent-a')

    await expect(binder(registry, clock).bindChannel('agent-a', launch, undefined, ['acp'])).rejects.toThrow(
      /left this member before its sandbox channel was bound/
    )
  })

  it('reuses the session across a rebind at the same generation', async () => {
    const { clock, registry, launch } = await withLaunch()
    const subject = binder(registry, clock, async () => stubConnection(7))

    await subject.bindChannel('agent-a', launch, undefined, ['acp'])
    const session = subject.sessionFor('agent-a')
    await subject.bindChannel('agent-a', launch, undefined, ['acp'])

    expect(subject.sessionFor('agent-a')).toBe(session)
  })

  it('starts a new session rather than reusing one bound at another generation', async () => {
    // A session is terminal per launch: reattaching a pod bound at a newer generation to the old
    // one would leave the runtime talking through a channel the shim has already fenced off.
    const { clock, registry, launch } = await withLaunch()
    let generation = 7
    const subject = binder(registry, clock, async () => stubConnection(generation))

    await subject.bindChannel('agent-a', launch, undefined, ['acp'])
    const first = subject.sessionFor('agent-a')
    generation = 8
    await subject.bindChannel('agent-a', launch, undefined, ['acp'])

    const second = subject.sessionFor('agent-a')
    expect(second).not.toBe(first)
    expect(first?.generation).toBe(7)
    expect(second?.generation).toBe(8)
  })

  it('loses a session a renewed connection has outrun', async () => {
    const { clock, registry, launch } = await withLaunch()
    const subject = binder(registry, clock, async () => stubConnection(7))
    await subject.bindChannel('agent-a', launch, undefined, ['acp'])
    const session = subject.sessionFor('agent-a')
    const lost = vi.fn()
    session?.onLost(lost)

    subject.onChannelBound(stubConnection(8))
    expect(lost).toHaveBeenCalledWith('superseded by generation 8')
  })

  it('drops both the session and the remembered mount when the agent leaves', async () => {
    const { clock, registry, launch } = await withLaunch()
    const subject = binder(registry, clock, async () => stubConnection(7, '/sandbox/workspace'))

    await subject.bindChannel('agent-a', launch, undefined, ['acp'])
    expect(subject.sessionFor('agent-a')).toBeDefined()
    expect(subject.workspaceRootFor('agent-a')).toBe('/sandbox/workspace')

    subject.forget('agent-a')
    expect(subject.sessionFor('agent-a')).toBeUndefined()
    expect(subject.workspaceRootFor('agent-a')).toBeUndefined()
  })

  it('keeps the remembered mount when a suspend drops the session', async () => {
    const { clock, registry, launch } = await withLaunch()
    const subject = binder(registry, clock, async () => stubConnection(7, '/sandbox/workspace'))
    await subject.bindChannel('agent-a', launch, undefined, ['acp'])

    subject.dropSession('agent-a')
    expect(subject.sessionFor('agent-a')).toBeUndefined()
    // The volume outlives the pod, so the next bind resumes onto the same mount.
    expect(subject.workspaceRootFor('agent-a')).toBe('/sandbox/workspace')
  })

  it('forgets a mount the current pod no longer reports', async () => {
    // A root kept from a previous incarnation names a mount this pod may not have; unset means the
    // caller falls back to the historical mount instead of reaching for a stale one.
    const { clock, registry, launch } = await withLaunch()
    const subject = binder(registry, clock, async () => stubConnection(7, '/sandbox/workspace'))
    await subject.bindChannel('agent-a', launch, undefined, ['acp'])

    subject.onChannelBound(stubConnection(7))
    expect(subject.workspaceRootFor('agent-a')).toBeUndefined()
    expect(subject.sessionFor('agent-a')).toBeDefined()
  })

  it('reports a channel that never arrived as a timeout when the deadline fires before the clock shows it spent', async () => {
    // A Node timer is armed from the event loop's cached time, so under load it comes due before Date.now() reaches it.
    const { clock, registry, launch } = await withLaunch()
    const stale: Clock = {
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms - 5),
      clearTimeout: (handle) => clock.clearTimeout(handle)
    }
    let armed = (): void => {}
    const dialing = new Promise<void>((resolve) => (armed = resolve))
    const subject = new ChannelBinder({
      registry,
      endpoints,
      clock: stale,
      log,
      metrics: noopClusterMetrics,
      channelTimeoutMs: 1_000,
      connectChannel: (_record, _address, timeoutMs) =>
        new Promise((_resolve, reject) => {
          stale.setTimeout(() => reject(new Error('binding timed out')), timeoutMs)
          armed()
        })
    })

    const outcome = expect(subject.bindChannel('agent-a', launch, undefined, ['acp'])).rejects.toBeInstanceOf(
      LaunchTimeoutError
    )
    await dialing
    clock.advance(995)
    await outcome
    expect(clock.pending).toBe(0)
  })

  it('tells the host of a failed bind while the bind still holds the launch', async () => {
    // A host that puts the pod back to sleep must see the bind's own hold, or it would act before the release it defers to.
    const { clock, registry, launch } = await withLaunch()
    const events: string[] = []
    const subject = new ChannelBinder({
      registry,
      endpoints: {
        resolve: async () => {
          throw new Error('pod never came up')
        },
        retain: () => void events.push('retain'),
        release: () => void events.push('release')
      },
      clock,
      log,
      metrics: noopClusterMetrics,
      channelTimeoutMs: 1_000,
      connectChannel: async () => stubConnection(7),
      onBindFailed: (failed, which) => void events.push(`failed:${failed}:${which === launch}`)
    })

    await expect(subject.bindChannel('agent-a', launch, undefined, ['acp'])).rejects.toThrow(/pod never came up/)
    expect(events).toEqual(['retain', 'failed:agent-a:true', 'release'])
  })

  it('reports whether it was the call that dropped a lost session', async () => {
    const { clock, registry, launch } = await withLaunch()
    const subject = binder(registry, clock, async () => stubConnection(7))
    await subject.bindChannel('agent-a', launch, undefined, ['acp'])

    expect(subject.loseChannel('agent-a', 'pod gone')).toBe(true)
    // Only the first loss forgets the launch; a second report has nothing left to drop.
    expect(subject.loseChannel('agent-a', 'pod gone')).toBe(false)
  })
})
