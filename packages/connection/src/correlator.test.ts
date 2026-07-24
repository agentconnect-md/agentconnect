import { describe, it, expect } from 'vitest'
import { ReqRep, WireError, type WireFrameLike } from './correlator.js'
import { FakeClock } from './clock.js'

/** A tiny wire frame for the tests — any `{ id, corr?, type, payload }` works. */
function frame(type: string, id: string, payload: unknown = {}, corr?: string): WireFrameLike {
  return { id, type, payload, ...(corr ? { corr } : {}) }
}

describe('ReqRep', () => {
  it('resolves a request when its correlated REP arrives', async () => {
    const clock = new FakeClock()
    const rr = new ReqRep(clock, 5000)
    const sent: string[] = []

    const p = rr.request(frame('rc/register', 'req-1'), (e) => sent.push(e))
    expect(rr.inflight()).toBe(1)
    expect(sent).toHaveLength(1)

    rr.settle(frame('rc/registered', 'rep-1', { relayId: 'r1' }, 'req-1'))
    await expect(p).resolves.toMatchObject({ type: 'rc/registered', payload: { relayId: 'r1' } })
    expect(rr.inflight()).toBe(0)
  })

  it('rejects with a WireError when a correlated error frame arrives', async () => {
    const clock = new FakeClock()
    const rr = new ReqRep(clock, 5000)
    const p = rr.request(frame('rc/auth', 'a-1'), () => {})

    rr.settle(frame('error', 'e-1', { code: 'AUTH_FAILED', message: 'bad token', retryable: false }, 'a-1'))
    await expect(p).rejects.toBeInstanceOf(WireError)
    await expect(p).rejects.toMatchObject({ code: 'AUTH_FAILED', retryable: false })
  })

  it('retransmits the identical bytes on ack timeout up to maxTries, then rejects', async () => {
    const clock = new FakeClock()
    const rr = new ReqRep(clock, 1000, 3) // maxTries = 3
    const sent: string[] = []
    const p = rr.request(frame('rc/register', 'req-2'), (e) => sent.push(e))
    p.catch(() => {}) // avoid unhandled rejection while we drive the clock

    expect(sent).toHaveLength(1) // initial send
    clock.advance(1000)
    expect(sent).toHaveLength(2) // retransmit 1
    clock.advance(1000)
    expect(sent).toHaveLength(3) // retransmit 2 (tries now == maxTries)
    // identical bytes each time (same id)
    expect(new Set(sent).size).toBe(1)

    clock.advance(1000) // budget exhausted → reject
    await expect(p).rejects.toMatchObject({ code: 'INTERNAL', retryable: true })
    expect(rr.inflight()).toBe(0)
  })

  it('settle() returns false for an uncorrelated frame', () => {
    const rr = new ReqRep(new FakeClock(), 5000)
    expect(rr.settle(frame('rc/heartbeat', 'x'))).toBe(false) // no corr
    expect(rr.settle(frame('rc/registered', 'y', {}, 'unknown'))).toBe(false) // corr matches nothing
  })

  it('rejects one pending request directly by correlation id', async () => {
    const rr = new ReqRep(new FakeClock(), 5000)
    const pending = rr.request(frame('rc/register', 'req-bad-rep'), () => {})
    const err = new WireError('BAD_PAYLOAD', 'invalid correlated reply', false)

    expect(rr.reject('missing', err)).toBe(false)
    expect(rr.reject('req-bad-rep', err)).toBe(true)
    await expect(pending).rejects.toBe(err)
    expect(rr.inflight()).toBe(0)
  })

  it('rejects the request (not throw) when the transport write throws', async () => {
    const rr = new ReqRep(new FakeClock(), 5000)
    const p = rr.request(frame('rc/auth', 'a-2'), () => {
      throw new Error('socket closed')
    })
    await expect(p).rejects.toMatchObject({ code: 'INTERNAL', retryable: true })
    expect(rr.inflight()).toBe(0)
  })

  it('rejectAll settles every pending request', async () => {
    const clock = new FakeClock()
    const rr = new ReqRep(clock, 5000)
    const p1 = rr.request(frame('rc/auth', 'a'), () => {})
    const p2 = rr.request(frame('rc/register', 'b'), () => {})
    rr.rejectAll(new Error('closed'))
    await expect(p1).rejects.toThrow('closed')
    await expect(p2).rejects.toThrow('closed')
    expect(rr.inflight()).toBe(0)
    // rejectAll cleared the retransmit timers too — advancing fires nothing.
    expect(() => clock.advance(60_000)).not.toThrow()
    expect(rr.inflight()).toBe(0)
  })
})
