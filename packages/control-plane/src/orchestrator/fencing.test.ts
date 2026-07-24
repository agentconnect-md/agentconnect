/**
 * Unit tests for the pure fencing predicates (design §5.3 — fencing predicates
 * run in the no-Docker `unit` project). The protocol-layer wiring is covered by
 * `test/protocol/fencing.test.ts`; here we pin the predicate semantics and the
 * epoch → launchId ordering directly.
 */
import { describe, it, expect } from 'vitest'
import { checkEpoch, checkLaunch, checkFencing, FencingState } from './fencing.js'

const A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const L = '11111111-1111-4111-8111-111111111111'
const L_OLD = '99999999-9999-4999-8999-999999999999'

describe('checkEpoch', () => {
  it('rejects an older epoch with STALE_EPOCH', () => {
    expect(checkEpoch(5, 4)).toEqual({ ok: false, code: 'STALE_EPOCH' })
  })
  it('passes an equal or newer epoch', () => {
    expect(checkEpoch(5, 5)).toEqual({ ok: true })
    expect(checkEpoch(5, 6)).toEqual({ ok: true })
  })
})

describe('checkLaunch', () => {
  it('rejects a superseded launchId with STALE_LAUNCH', () => {
    expect(checkLaunch(L, L_OLD)).toEqual({ ok: false, code: 'STALE_LAUNCH' })
  })
  it('passes a matching launchId', () => {
    expect(checkLaunch(L, L)).toEqual({ ok: true })
  })
  it('is a no-op when the frame carries no launchId or no launch is known', () => {
    expect(checkLaunch(L, undefined)).toEqual({ ok: true })
    expect(checkLaunch(undefined, L)).toEqual({ ok: true })
  })
})

describe('checkFencing — order epoch → launchId', () => {
  const baseline = { sessionEpoch: 5, currentLaunch: L }

  it('epoch wins over a stale launch', () => {
    expect(checkFencing(baseline, { epoch: 4, agentId: A, launchId: L_OLD })).toEqual({
      ok: false,
      code: 'STALE_EPOCH'
    })
  })
  it('launch is reported when epoch is fine', () => {
    expect(checkFencing(baseline, { epoch: 5, agentId: A, launchId: L_OLD })).toEqual({
      ok: false,
      code: 'STALE_LAUNCH'
    })
  })
  it('passes a fully in-bounds frame', () => {
    expect(checkFencing(baseline, { epoch: 5, agentId: A, launchId: L })).toEqual({ ok: true })
  })
})

describe('FencingState', () => {
  it('tracks the current launch per agent', () => {
    const s = new FencingState()
    expect(s.currentLaunch(A)).toBeUndefined()
    s.setLaunch(A, L)
    expect(s.currentLaunch(A)).toBe(L)
    s.setLaunch(A, L_OLD)
    expect(s.currentLaunch(A)).toBe(L_OLD)
  })
})
