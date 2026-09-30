// Unit tests for OAuthReaper: fake repos record each sweep's cutoff while a FakeClock drives the loop.
import { describe, it, expect } from 'vitest'
import { OAuthReaper } from './oauthReaper.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const GRACE_MS = 7 * 86_400_000
const INTERVAL_MS = 10 * 60_000

class FakeOAuthRepo {
  calls: Date[] = []
  fail = false
  async reapExpired(before: Date): Promise<{ codes: number; clients: number }> {
    this.calls.push(before)
    if (this.fail) throw new Error('db down')
    return { codes: 2, clients: 1 }
  }
}

class FakeApiKeyRepo {
  calls: Date[] = []
  async reapOAuthAccessTokens(before: Date): Promise<number> {
    this.calls.push(before)
    return 3
  }
}

// A real macrotask, so the sweep's awaited calls and its `finally` re-arm drain before asserting.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function setup() {
  const clock = new FakeClock(1_000_000_000_000)
  const oauth = new FakeOAuthRepo()
  const apiKeys = new FakeApiKeyRepo()
  const logs: Array<{ level: 'info' | 'error'; obj: unknown; msg?: string }> = []
  const log = {
    info: (obj: unknown, msg?: string) => logs.push({ level: 'info', obj, ...(msg ? { msg } : {}) }),
    error: (obj: unknown, msg?: string) => logs.push({ level: 'error', obj, ...(msg ? { msg } : {}) })
  }
  const reaper = new OAuthReaper(oauth, apiKeys, clock, { intervalMs: INTERVAL_MS, graceMs: GRACE_MS }, log)
  return { clock, oauth, apiKeys, logs, reaper }
}

describe('OAuthReaper', () => {
  it('start() arms exactly one sweep; stop() cancels it', () => {
    const { clock, reaper } = setup()
    expect(clock.pendingTimers()).toBe(0)
    reaper.start()
    expect(clock.pendingTimers()).toBe(1)
    reaper.stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('sweeps codes, clients and access tokens once per interval with cutoff = now − grace', async () => {
    const { clock, oauth, apiKeys, logs, reaper } = setup()
    reaper.start()

    clock.advance(INTERVAL_MS - 1)
    expect(oauth.calls).toHaveLength(0)

    clock.advance(1)
    await flush()
    expect(oauth.calls).toHaveLength(1)
    expect(apiKeys.calls).toHaveLength(1)
    expect(oauth.calls[0]!.getTime()).toBe(clock.now() - GRACE_MS)
    expect(apiKeys.calls[0]!.getTime()).toBe(clock.now() - GRACE_MS)
    expect(logs).toEqual([
      expect.objectContaining({
        level: 'info',
        obj: expect.objectContaining({ codes: 2, clients: 1, accessTokens: 3 })
      })
    ])

    clock.advance(INTERVAL_MS)
    await flush()
    expect(oauth.calls).toHaveLength(2)
    reaper.stop()
  })

  it('stops sweeping after stop()', async () => {
    const { clock, oauth, reaper } = setup()
    reaper.start()
    clock.advance(INTERVAL_MS)
    await flush()
    expect(oauth.calls).toHaveLength(1)

    reaper.stop()
    clock.advance(INTERVAL_MS * 5)
    expect(oauth.calls).toHaveLength(1)
    expect(clock.pendingTimers()).toBe(0)
  })

  it('logs a failing sweep, skips the rest of it, and keeps the loop alive', async () => {
    const { clock, oauth, apiKeys, logs, reaper } = setup()
    oauth.fail = true
    reaper.start()

    clock.advance(INTERVAL_MS)
    await flush()
    expect(oauth.calls).toHaveLength(1)
    expect(apiKeys.calls).toHaveLength(0)
    expect(logs.map((l) => l.level)).toEqual(['error'])
    expect(clock.pendingTimers()).toBe(1)

    oauth.fail = false
    clock.advance(INTERVAL_MS)
    await flush()
    expect(oauth.calls).toHaveLength(2)
    expect(apiKeys.calls).toHaveLength(1)
    reaper.stop()
  })
})
