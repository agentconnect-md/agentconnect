import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { DaemonReleaseResolver } from './daemonRelease.js'

function ok(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

describe('DaemonReleaseResolver', () => {
  it('resolves the latest version for the configured channel', async () => {
    const clock = new FakeClock(1000)
    const fetchImpl = vi.fn(async () => ok({ latest: '1.4.0', rc: '1.5.0-rc.2' }))
    const r = new DaemonReleaseResolver('rc', clock, fetchImpl)

    // First read is synchronous: no version yet, but it kicks a background fetch.
    expect(r.get()).toEqual({ channel: 'rc', latestVersion: null, availableVersions: [] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Once the fetch settles, the channel's dist-tag is cached.
    await vi.waitFor(() => expect(r.get().latestVersion).toBe('1.5.0-rc.2'))
    // On the rc channel the picker offers BOTH rc and release versions, channel first.
    expect(r.get().availableVersions).toEqual(['1.5.0-rc.2', '1.4.0'])
  })

  it('picks the tag named by the channel (latest ≠ rc)', async () => {
    const clock = new FakeClock(1000)
    const fetchImpl = vi.fn(async () => ok({ latest: '1.4.0', rc: '1.5.0-rc.2' }))
    const r = new DaemonReleaseResolver('latest', clock, fetchImpl)
    r.get()
    await vi.waitFor(() => expect(r.get().latestVersion).toBe('1.4.0'))
  })

  it('offers release versions only on a stable channel — rc is never an upgrade target', async () => {
    const clock = new FakeClock(1000)
    // dist-tags carries an rc ahead of latest, plus an older release behind another tag.
    const fetchImpl = vi.fn(async () => ok({ latest: '1.4.0', rc: '1.5.0-rc.2', previous: '1.3.0' }))
    const r = new DaemonReleaseResolver('latest', clock, fetchImpl)
    r.get()
    await vi.waitFor(() => expect(r.get().latestVersion).toBe('1.4.0'))
    // The prerelease is filtered out; only release versions remain, channel version first.
    expect(r.get().availableVersions).toEqual(['1.4.0', '1.3.0'])
  })

  it('stays null when the channel has no published tag', async () => {
    const clock = new FakeClock(1000)
    const fetchImpl = vi.fn(async () => ok({ latest: '1.4.0' }))
    const r = new DaemonReleaseResolver('beta', clock, fetchImpl)
    r.get()
    await new Promise((res) => setTimeout(res, 0))
    expect(r.get().latestVersion).toBeNull()
  })

  it('is best-effort: a failed fetch never throws and keeps null', async () => {
    const clock = new FakeClock(1000)
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const r = new DaemonReleaseResolver('latest', clock, fetchImpl)
    expect(() => r.get()).not.toThrow()
    await new Promise((res) => setTimeout(res, 0))
    expect(r.get().latestVersion).toBeNull()
  })

  it('caches within the TTL and refetches once it expires', async () => {
    const clock = new FakeClock(1000)
    let version = '1.4.0'
    const fetchImpl = vi.fn(async () => ok({ latest: version }))
    const r = new DaemonReleaseResolver('latest', clock, fetchImpl, 60_000)

    r.get()
    await vi.waitFor(() => expect(r.get().latestVersion).toBe('1.4.0'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Within the TTL: served from cache, no new fetch.
    clock.advance(30_000)
    r.get()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Past the TTL: a fresh fetch picks up the newer publish.
    version = '1.4.1'
    clock.advance(31_000)
    r.get()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(r.get().latestVersion).toBe('1.4.1'))
  })
})
