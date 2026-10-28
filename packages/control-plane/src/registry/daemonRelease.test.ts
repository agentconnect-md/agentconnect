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

  it('uses a shorter default TTL for rc than stable channels', async () => {
    const clock = new FakeClock(1000)
    let rcVersion = '1.5.0-rc.1'
    const rcFetch = vi.fn(async () => ok({ rc: rcVersion }))
    const stableFetch = vi.fn(async () => ok({ latest: '1.4.0' }))
    const rc = new DaemonReleaseResolver('rc', clock, rcFetch)
    const stable = new DaemonReleaseResolver('latest', clock, stableFetch)

    rc.get()
    stable.get()
    await vi.waitFor(() => {
      expect(rc.get().latestVersion).toBe('1.5.0-rc.1')
      expect(stable.get().latestVersion).toBe('1.4.0')
    })

    rcVersion = '1.5.0-rc.2'
    clock.advance(2 * 60_000 + 1)
    rc.get()
    stable.get()

    expect(rcFetch).toHaveBeenCalledTimes(2)
    expect(stableFetch).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(rc.get().latestVersion).toBe('1.5.0-rc.2'))
  })

  describe('background refresh and change notification', () => {
    it('refreshes on its own cadence without any read, 5 min stable and 2 min rc', async () => {
      const clock = new FakeClock(1000)
      const stableFetch = vi.fn(async () => ok({ latest: '1.4.0' }))
      const rcFetch = vi.fn(async () => ok({ rc: '1.5.0-rc.1' }))
      const stable = new DaemonReleaseResolver('latest', clock, stableFetch)
      const rc = new DaemonReleaseResolver('rc', clock, rcFetch)
      stable.start()
      rc.start()
      // Cold start resolves at once, without a console read.
      await vi.waitFor(() => {
        expect(stable.current()).toEqual({ channel: 'latest', version: '1.4.0' })
        expect(rc.current()).toEqual({ channel: 'rc', version: '1.5.0-rc.1' })
      })
      expect(stableFetch).toHaveBeenCalledTimes(1)
      expect(rcFetch).toHaveBeenCalledTimes(1)

      clock.advance(2 * 60_000)
      await vi.waitFor(() => expect(rcFetch).toHaveBeenCalledTimes(2))
      expect(stableFetch).toHaveBeenCalledTimes(1)

      clock.advance(3 * 60_000)
      await vi.waitFor(() => expect(stableFetch).toHaveBeenCalledTimes(2))
      stable.stop()
      rc.stop()
    })

    it('fires onChange once per version change, including the cold-start resolution', async () => {
      const clock = new FakeClock(1000)
      let version = '1.4.0'
      const fetchImpl = vi.fn(async () => ok({ latest: version }))
      const r = new DaemonReleaseResolver('latest', clock, fetchImpl, 60_000, 60_000)
      const seen: unknown[] = []
      r.onChange((release) => seen.push(release))
      r.start()
      await vi.waitFor(() => expect(seen).toEqual([{ channel: 'latest', version: '1.4.0' }]))

      // Same version on the next round: no notification.
      clock.advance(60_000)
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
      await new Promise((res) => setTimeout(res, 0))
      expect(seen).toHaveLength(1)

      // A moved dist-tag (forward or back) notifies.
      version = '1.3.9'
      clock.advance(60_000)
      await vi.waitFor(() => expect(seen).toHaveLength(2))
      expect(seen[1]).toEqual({ channel: 'latest', version: '1.3.9' })
      r.stop()
    })

    it('does not notify on a failed fetch and keeps the last good version', async () => {
      const clock = new FakeClock(1000)
      let fail = false
      const fetchImpl = vi.fn(async () => {
        if (fail) throw new Error('network down')
        return ok({ latest: '1.4.0' })
      })
      const r = new DaemonReleaseResolver('latest', clock, fetchImpl, 60_000, 60_000)
      const listener = vi.fn()
      r.onChange(listener)
      r.start()
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))

      fail = true
      clock.advance(60_000)
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
      await new Promise((res) => setTimeout(res, 0))
      expect(listener).toHaveBeenCalledTimes(1)
      expect(r.current()).toEqual({ channel: 'latest', version: '1.4.0' })
      r.stop()
    })

    it('reports no release before the first resolution, and a throwing listener does not block others', async () => {
      const clock = new FakeClock(1000)
      const r = new DaemonReleaseResolver(
        'latest',
        clock,
        vi.fn(async () => ok({ latest: '1.4.0' }))
      )
      expect(r.current()).toBeNull()
      const after = vi.fn()
      r.onChange(() => {
        throw new Error('boom')
      })
      r.onChange(after)
      r.get()
      await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1))
    })

    it('stops re-arming once stopped, and unsubscribed listeners hear nothing', async () => {
      const clock = new FakeClock(1000)
      let version = '1.4.0'
      const fetchImpl = vi.fn(async () => ok({ latest: version }))
      const r = new DaemonReleaseResolver('latest', clock, fetchImpl, 60_000, 60_000)
      const listener = vi.fn()
      const unsubscribe = r.onChange(listener)
      r.start()
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
      unsubscribe()
      r.stop()

      version = '1.5.0'
      clock.advance(10 * 60_000)
      await new Promise((res) => setTimeout(res, 0))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })
})
