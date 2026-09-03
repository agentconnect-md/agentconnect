import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { LaunchRegistry, type Launch } from '../src/k8s/launch-registry.js'
import { fakeGenerations } from './fake-generations.js'

function registry(clock = new FakeClock()) {
  return { subject: new LaunchRegistry({ generations: fakeGenerations(), clock }), clock }
}

describe('launch registry records', () => {
  it('records a launch at a fresh generation and forgets it on request', async () => {
    const { subject, clock } = registry()
    clock.advance(1_000)

    const first = await subject.recordLaunch('agent-a', 'sb-1', 'sandbox-uid-1')
    expect(first).toMatchObject({ agentId: 'agent-a', sandboxName: 'sb-1', generation: 1, since: clock.now() })
    expect(subject.currentLaunch('agent-a')).toBe(first)
    expect(subject.launched()).toEqual([{ subject: 'agent-a', agentId: 'agent-a', since: clock.now() }])

    // A replacement pod must never reuse the fence the departed incarnation was bound against.
    const second = await subject.recordLaunch('agent-a', 'sb-1', 'sandbox-uid-2')
    expect(second.generation).toBe(2)

    expect(subject.forgetLaunch('agent-a')).toBe(second)
    expect(subject.currentLaunch('agent-a')).toBeUndefined()
    expect(subject.forgetLaunch('agent-a')).toBeUndefined()
    expect(subject.launched()).toEqual([])
  })
})

describe('launch registry release fence', () => {
  it('refuses a launch whose acquisition crossed a release', async () => {
    const { subject } = registry()
    const releasedAt = subject.releaseFence('agent-a')
    // Read-compare-act: the acquisition awaits the cluster, and the agent leaves meanwhile.
    await Promise.resolve()
    subject.bumpRelease('agent-a')

    expect(subject.stillServed('agent-a', releasedAt)).toBe(false)
    expect(() => subject.assertStillServed('agent-a', releasedAt)).toThrow(/left this member/)
  })

  it('admits a launch acquired within one fence snapshot', async () => {
    const { subject } = registry()
    subject.bumpRelease('agent-a')
    const releasedAt = subject.releaseFence('agent-a')
    await Promise.resolve()

    expect(subject.stillServed('agent-a', releasedAt)).toBe(true)
    expect(() => subject.assertStillServed('agent-a', releasedAt)).not.toThrow()
  })

  it('fences each agent independently', () => {
    const { subject } = registry()
    const releasedAt = subject.releaseFence('agent-a')
    subject.bumpRelease('agent-b')

    expect(subject.stillServed('agent-a', releasedAt)).toBe(true)
  })
})

describe('launch registry takeover', () => {
  it('single-flights concurrent re-derivations and clears the entry when they settle', async () => {
    const { subject } = registry()
    let finish: ((launch: Launch | undefined) => void) | undefined
    const derive = vi.fn(
      async () =>
        await new Promise<Launch | undefined>((resolve) => {
          finish = resolve
        })
    )

    const first = subject.adopt('agent-a', derive)
    const second = subject.adopt('agent-a', derive)
    expect(second).toBe(first)
    expect(subject.adoptInFlight('agent-a')).toBe(first)
    expect(derive).toHaveBeenCalledTimes(1)

    finish?.(await subject.recordLaunch('agent-a', 'sb-1', 'sandbox-uid-1'))
    expect(await first).toBe(subject.currentLaunch('agent-a'))
    expect(subject.adoptInFlight('agent-a')).toBeUndefined()
  })

  it('answers from the cached launch without reaching the cluster', async () => {
    const { subject } = registry()
    const launch = await subject.recordLaunch('agent-a', 'sb-1', 'sandbox-uid-1')
    const derive = vi.fn(async () => undefined)

    expect(await subject.adopt('agent-a', derive)).toBe(launch)
    expect(derive).not.toHaveBeenCalled()
  })

  it('hands the derivation the fence snapshot taken before it started', async () => {
    const { subject } = registry()
    subject.bumpRelease('agent-a')
    const seen: number[] = []

    await subject.adopt('agent-a', async (releasedAt) => {
      seen.push(releasedAt)
      return undefined
    })
    expect(seen).toEqual([subject.releaseFence('agent-a')])
  })

  it('clears the entry after a failed re-derivation so the next takeover retries', async () => {
    const { subject } = registry()
    await expect(
      subject.adopt('agent-a', async () => {
        throw new Error('api server down')
      })
    ).rejects.toThrow(/api server down/)

    expect(subject.adoptInFlight('agent-a')).toBeUndefined()
  })
})
