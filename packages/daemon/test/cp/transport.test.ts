import { describe, it, expect } from 'vitest'
import { FakeTransport } from './fake-transport.js'

describe('FakeTransport', () => {
  it('captures sent frames and delivers inbound frames to the callback', () => {
    const t = new FakeTransport()
    const got: string[] = []
    t.onMessage((m) => got.push(m))
    t.send('out')
    t.pushInbound('in')
    expect(t.sent).toEqual(['out'])
    expect(got).toEqual(['in'])
  })

  it('invokes the close callback on simulateClose', () => {
    const t = new FakeTransport()
    let closed: [number, string] | undefined
    t.onClose((c, r) => (closed = [c, r]))
    t.simulateClose(4401, 'AUTH_FAILED')
    expect(closed).toEqual([4401, 'AUTH_FAILED'])
  })
})
