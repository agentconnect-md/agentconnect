/**
 * Unit tests for the identity warm-at-touch trigger (session-access-cold-visit.md
 * §3): per-principal throttling, API-key sub resolution + memoization, and the
 * fire-and-forget contract — failures swallowed, the request never touched.
 */
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { createIdentityWarmTrigger } from './identity-warm.js'

/** The trigger's async leg settles in microtasks — one macrotask turn is enough. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

function harness(getOidcSubject = vi.fn(async (_userId: string): Promise<string | null> => 'sub-1')) {
  const clock = new FakeClock(0)
  const ensureIdentityFresh = vi.fn<(sub: string) => void>()
  const log = { debug: vi.fn<(obj: object, msg: string) => void>() }
  const trigger = createIdentityWarmTrigger({
    identity: { ensureIdentityFresh },
    users: { getOidcSubject },
    clock,
    log
  })
  return { clock, ensureIdentityFresh, getOidcSubject, log, trigger }
}

describe('createIdentityWarmTrigger', () => {
  it('an OIDC principal warms with the request sub — no DB read', () => {
    const { trigger, ensureIdentityFresh, getOidcSubject } = harness()
    trigger({ userId: 'u1', oidcSubject: 'sub-1' })
    expect(ensureIdentityFresh).toHaveBeenCalledWith('sub-1')
    expect(getOidcSubject).not.toHaveBeenCalled()
  })

  it('checks each principal at most once per throttle window', () => {
    const { trigger, ensureIdentityFresh, clock } = harness()
    trigger({ userId: 'u1', oidcSubject: 'sub-1' })
    clock.advance(29_999)
    trigger({ userId: 'u1', oidcSubject: 'sub-1' })
    expect(ensureIdentityFresh).toHaveBeenCalledTimes(1)
    clock.advance(1) // the window closes at exactly 30 s
    trigger({ userId: 'u1', oidcSubject: 'sub-1' })
    expect(ensureIdentityFresh).toHaveBeenCalledTimes(2)
  })

  it('throttles per principal, not globally', () => {
    const { trigger, ensureIdentityFresh } = harness()
    trigger({ userId: 'u1', oidcSubject: 'sub-1' })
    trigger({ userId: 'u2', oidcSubject: 'sub-2' })
    expect(ensureIdentityFresh).toHaveBeenCalledTimes(2)
  })

  it('an API-key principal resolves its sub once, memoizes it, then warms', async () => {
    const { trigger, ensureIdentityFresh, getOidcSubject, clock } = harness()
    trigger({ userId: 'u1' })
    await settled()
    expect(getOidcSubject).toHaveBeenCalledWith('u1')
    expect(ensureIdentityFresh).toHaveBeenCalledWith('sub-1')

    clock.advance(30_000)
    trigger({ userId: 'u1' })
    expect(getOidcSubject).toHaveBeenCalledTimes(1) // memoized — no second read
    expect(ensureIdentityFresh).toHaveBeenCalledTimes(2)
  })

  it('a principal with no OIDC identity warms nothing and is retried next window', async () => {
    const getOidcSubject = vi.fn(async (): Promise<string | null> => null)
    const { trigger, ensureIdentityFresh, clock } = harness(getOidcSubject)
    trigger({ userId: 'u1' })
    await settled()
    expect(ensureIdentityFresh).not.toHaveBeenCalled()

    trigger({ userId: 'u1' }) // inside the window: not even a DB read
    expect(getOidcSubject).toHaveBeenCalledTimes(1)

    clock.advance(30_000)
    trigger({ userId: 'u1' }) // null was not memoized — the next window asks again
    await settled()
    expect(getOidcSubject).toHaveBeenCalledTimes(2)
  })

  it('a failing sub lookup is swallowed and debug-logged', async () => {
    const getOidcSubject = vi.fn(async (): Promise<string | null> => {
      throw new Error('db blip')
    })
    const { trigger, ensureIdentityFresh, log } = harness(getOidcSubject)
    expect(() => trigger({ userId: 'u1' })).not.toThrow()
    await settled()
    expect(ensureIdentityFresh).not.toHaveBeenCalled()
    expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), 'identity warm sub lookup failed')
  })

  it('a sub learned from an OIDC request serves later API-key requests without a DB read', () => {
    const { trigger, ensureIdentityFresh, getOidcSubject, clock } = harness()
    trigger({ userId: 'u1', oidcSubject: 'sub-1' })
    clock.advance(30_000)
    trigger({ userId: 'u1' }) // same principal over an API key
    expect(getOidcSubject).not.toHaveBeenCalled()
    expect(ensureIdentityFresh).toHaveBeenNthCalledWith(2, 'sub-1')
  })
})
